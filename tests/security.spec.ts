import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'

// Security regressions (Node-side, against the REAL local stack: Postgres :55432, PDS :2583, and the
// dev server :3001 for the HTTP-level checks, run with RESEND_API_KEY unset).
//
//   1. SSRF: the outbound dispatcher refuses non-public addresses at connect time; a DID document naming
//      a loopback PDS is refused before any request reaches it; our own PDS still works internally.
//   2. Email-door abuse: per-IP link and mint limits, the global mint cap, identical responses for an
//      existing and a new address.
//   3. Magic links: GET renders a confirmation page and never consumes; the form POST does.
//
// Everything created here (PDS accounts, account rows, tokens, repo state) is removed afterwards.
loadEnvConfig(process.cwd(), true)

// `src/lib/**` starts with `import 'server-only'`; resolve it to Next's empty stub in this process.
type Resolver = (request: string, ...rest: unknown[]) => string
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = moduleWithResolver._resolveFilename
const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
}

const base = process.env.AUTH_TEST_BASE_URL || 'http://localhost:3001'
const pdsInternal = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const adminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const configured = Boolean(pdsInternal && adminPassword && migrationUrl && process.env.DATABASE_URL && process.env.ATPROTO_SESSION_SECRET && process.env.PDS_HANDLE_DOMAIN)

const RUN = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
const env = process.env as Record<string, string | undefined>

// Unit-level calls in this process must never deliver real mail.
delete env.RESEND_API_KEY

type SafeFetchModule = typeof import('../src/lib/net/safe-fetch')
type IdentityModule = typeof import('../src/lib/atproto/identity')
type WriteModule = typeof import('../src/lib/atproto/write')
type ServiceModule = typeof import('../src/lib/atproto/service-url')
type IngestModule = typeof import('../src/lib/atproto/ingest')
type CustodyModule = typeof import('../src/lib/auth/custody')
type ClientIpModule = typeof import('../src/lib/auth/client-ip')

interface CountingServer {
  url: string
  port: number
  hits: string[]
  close(): Promise<void>
}

async function countingServer(handler?: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<CountingServer> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    if (handler) return handler(req, res)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"records":[]}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function fakePlcDid(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  return `did:plc:${Array.from(randomBytes(24), (b) => alphabet[b % 32]).join('')}`
}

async function deletePdsAccount(did: string): Promise<void> {
  await fetch(`${pdsInternal}/xrpc/com.atproto.admin.deleteAccount`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}` },
    body: JSON.stringify({ did }),
  })
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete env[k]
    else env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
  }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('security', () => {
  test.skip(!configured, 'the local stack env (PDS_URL, PDS_ADMIN_PASSWORD, DATABASE_URL, DATABASE_MIGRATION_URL, ATPROTO_SESSION_SECRET) is not set')

  let sql: postgres.Sql
  let sf: SafeFetchModule
  let identity: IdentityModule
  let write: WriteModule
  let service: ServiceModule
  let ingest: IngestModule
  let custody: CustodyModule
  let clientIp: ClientIpModule
  let victim: CountingServer
  let plc: CountingServer
  const docs = new Map<string, Record<string, unknown>>()
  const createdDids = new Set<string>()
  const emailPrefix = `sec-${RUN}-`
  const fakeAccountDids: string[] = []
  let signingKey = ''

  test.beforeAll(async () => {
    sql = postgres(migrationUrl, { max: 2, onnotice: () => {} })
    victim = await countingServer()
    // Plays the PLC directory: serves attacker-written DID documents.
    plc = await countingServer((req, res) => {
      const did = decodeURIComponent((req.url ?? '/').slice(1))
      const doc = docs.get(did)
      res.writeHead(doc ? 200 : 404, { 'content-type': 'application/did+ld+json' })
      res.end(JSON.stringify(doc ?? { message: 'not found' }))
    })
    // Resolve foreign DIDs against the fake PLC (an allowed local service origin outside production).
    env.ATPROTO_PLC_URL = plc.url
    const { Secp256k1Keypair } = require('@atproto/crypto') as typeof import('@atproto/crypto')
    signingKey = (await Secp256k1Keypair.create()).did().slice('did:key:'.length)

    sf = require('../src/lib/net/safe-fetch') as SafeFetchModule
    identity = require('../src/lib/atproto/identity') as IdentityModule
    write = require('../src/lib/atproto/write') as WriteModule
    service = require('../src/lib/atproto/service-url') as ServiceModule
    ingest = require('../src/lib/atproto/ingest') as IngestModule
    custody = require('../src/lib/auth/custody') as CustodyModule
    clientIp = require('../src/lib/auth/client-ip') as ClientIpModule
  })

  test.afterAll(async () => {
    await victim?.close()
    await plc?.close()
    if (!sql) return
    const rows = await sql<{ did: string }[]>`select did from accounts where email like ${`${emailPrefix}%`}`
    for (const r of rows) createdDids.add(r.did)
    for (const did of createdDids) await deletePdsAccount(did)
    const all = [...createdDids, ...fakeAccountDids, ...docs.keys()]
    if (all.length) {
      await sql`delete from at_repo_state where did in ${sql(all)}`
      await sql`delete from at_records where did in ${sql(all)}`
      await sql`delete from accounts where did in ${sql(all)}`
    }
    await sql`delete from auth_email_tokens where email like ${`${emailPrefix}%`}`
    await sql.end()
    await (require('../src/lib/db') as typeof import('../src/lib/db')).sql.end({ timeout: 5 }).catch(() => {})
  })

  /* ───────────────────────────── 1. SSRF ───────────────────────────── */

  test('isPublicAddress refuses loopback, private, CGNAT, link-local, ULA, multicast and mapped forms', () => {
    for (const a of ['127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '100.64.0.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fe80::1', 'fc00::1', 'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe', '2001:db8::1']) {
      expect(sf.isPublicAddress(a), a).toBe(false)
    }
    for (const a of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(sf.isPublicAddress(a), a).toBe(true)
  })

  test('safeFetch refuses 127.0.0.1, 10.0.0.5, 169.254.169.254, [::1] and a name resolving to loopback', async () => {
    const targets = [
      `https://127.0.0.1:${victim.port}/`,
      `http://127.0.0.1:${victim.port}/`,
      'https://10.0.0.5/',
      'https://169.254.169.254/latest/meta-data/',
      `https://[::1]:${victim.port}/`,
      `https://localhost:${victim.port}/`,
    ]
    for (const url of targets) {
      const err = await sf.safeFetch(url).then(() => null, (e: unknown) => e)
      expect(err, url).toBeInstanceOf(sf.UnsafeUrlError)
    }
    // `localhost` passes the URL policy (https, a name) and is refused by the connect-time lookup.
    const viaLookup = await sf.safeFetch(`https://localhost:${victim.port}/`).catch((e: Error) => e)
    expect(String((viaLookup as Error).message)).toContain('resolves to a non-public address')
    expect(victim.hits).toEqual([])
  })

  test('the guarded dispatcher itself refuses private targets (no URL policy in front of it)', async () => {
    const { request } = require('undici') as typeof import('undici')
    for (const url of [`http://127.0.0.1:${victim.port}/`, 'http://10.0.0.5/', 'http://169.254.169.254/', `http://[::1]:${victim.port}/`, `http://localhost:${victim.port}/`]) {
      const err = await request(url, { dispatcher: sf.safeDispatcher() }).then(() => null, (e: unknown) => e)
      expect(err, url).toBeTruthy()
    }
    expect(victim.hits).toEqual([])
  })

  test('http: to a configured local service is allowed in development and refused in production', async () => {
    const health = `${pdsInternal}/xrpc/_health`
    const dev = await sf.safeFetch(health)
    expect(dev.status).toBe(200)
    await withEnv({ NODE_ENV: 'production' }, async () => {
      const err = await sf.safeFetch(health).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(sf.UnsafeUrlError)
      expect(String((err as Error).message)).toContain('is not https')
    })
  })

  test('a DID document naming a loopback PDS is refused before any request reaches it', async () => {
    const collection = ingest.PARTICIPANT_COLLECTIONS[0]!
    const endpoints = [`http://127.0.0.1:${victim.port}`, `https://127.0.0.1:${victim.port}`, `https://localhost:${victim.port}`, 'https://169.254.169.254']
    for (const endpoint of endpoints) {
      const did = fakePlcDid()
      docs.set(did, {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: did,
        alsoKnownAs: [`at://attacker-${RUN}.example.com`],
        verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: signingKey }],
        service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: endpoint }],
      })
      const plcHitsBefore = plc.hits.length

      const listed = await write.listRecords(did, collection).then(() => null, (e: unknown) => e)
      expect(listed, endpoint).toBeTruthy()
      const reconciled = await ingest.reconcileRepo(did, [collection])
      expect(reconciled.errors.length, endpoint).toBeGreaterThan(0)
      expect(reconciled.records).toBe(0)

      // The document really was fetched (from the fake PLC); the PDS it names never was.
      expect(plc.hits.length, endpoint).toBeGreaterThan(plcHitsBefore)
      expect(victim.hits, endpoint).toEqual([])
    }
    // The literal endpoints are refused as soon as the document is read.
    const [loopbackDid] = [...docs.keys()]
    await expect(identity.resolveDidDoc(loopbackDid!)).rejects.toBeInstanceOf(identity.DidNotFoundError)
    await expect(service.serviceUrlForDid(loopbackDid!)).rejects.toBeTruthy()
    expect(victim.hits).toEqual([])
  })

  test('did:web on an IP literal is refused without a request', async () => {
    await expect(identity.resolveDidDoc(`did:web:127.0.0.1%3A${victim.port}`)).rejects.toBeInstanceOf(identity.DidNotFoundError)
    await expect(identity.resolveDidDoc('did:web:169.254.169.254')).rejects.toBeInstanceOf(identity.DidNotFoundError)
    expect(victim.hits).toEqual([])
  })

  test('our own PDS still works through the internal allowlist (reconcile a custodial repo)', async () => {
    const email = `${emailPrefix}own@example.test`
    const minted = await custody.mintCustodialAccount(email)
    createdDids.add(minted.did)
    const svc = await service.serviceForDid(minted.did)
    expect(svc).toEqual({ url: pdsInternal, internal: true })
    const result = await ingest.reconcileRepo(minted.did, ingest.PARTICIPANT_COLLECTIONS)
    expect(result.errors).toEqual([])
    const listed = await write.listRecords(minted.did, ingest.PARTICIPANT_COLLECTIONS[0]!)
    expect(listed.records).toEqual([])
  })

  /* ───────────────────────── 2. email-door abuse ───────────────────────── */

  const randomIp = () => `198.51.${randomBytes(1)[0]}.${randomBytes(1)[0]}`

  test('client IP: X-Forwarded-For is trusted only with TRUST_PROXY=true, and only hashed', async () => {
    const req = new Request(`${base}/api/auth/email`, { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } })
    await withEnv({ TRUST_PROXY: undefined }, async () => expect(clientIp.clientIp(req)).toBeNull())
    await withEnv({ TRUST_PROXY: 'true' }, async () => expect(clientIp.clientIp(req)).toBe('203.0.113.9'))
    const hash = clientIp.hashIp('203.0.113.9')
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
    expect(hash).not.toContain('203')
    // IPv6 is bucketed to its /64.
    expect(clientIp.hashIp('2001:4860:1:2::1')).toBe(clientIp.hashIp('2001:4860:1:2:ffff::9'))
    expect(clientIp.hashIp('2001:4860:1:2::1')).not.toBe(clientIp.hashIp('2001:4860:1:3::1'))
  })

  test('the 11th sign-in link request from one IP in an hour is a 429', async () => {
    const ip = randomIp()
    // Existing (OAuth) accounts, so no identity is minted: this isolates the per-IP link limit.
    const emails = Array.from({ length: 11 }, (_, i) => `${emailPrefix}links${i}@example.test`)
    for (const [i, email] of emails.entries()) {
      const did = `did:plc:sec${RUN.replace(/[^a-z2-7]/g, 'a').slice(0, 13).padEnd(13, 'a')}${'abcdefghijk'[i]}`
      fakeAccountDids.push(did)
      await sql`insert into accounts (did, email, kind) values (${did}, ${email}, 'oauth')`
    }
    await withEnv({ AUTH_MAX_MINTS_GLOBAL_HOUR: '1000000' }, async () => {
      for (const email of emails.slice(0, 10)) {
        const ok = await custody.startEmailSignIn(email, '/', { ip })
        expect(ok.ok).toBe(true)
      }
      const err = await custody.startEmailSignIn(emails[10]!, '/', { ip }).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(custody.RateLimitedError)
      expect((err as InstanceType<CustodyModule['RateLimitedError']>).status).toBe(429)
      expect((err as InstanceType<CustodyModule['RateLimitedError']>).code).toBe('rate_limited')
      const retry = (err as InstanceType<CustodyModule['RateLimitedError']>).retryAfterSeconds
      expect(retry).toBeGreaterThanOrEqual(1)
      expect(retry).toBeLessThanOrEqual(3600)

      const response = custody.authErrorResponse(err)!
      expect(response.status).toBe(429)
      expect(Number(response.headers.get('retry-after'))).toBe(retry)
      expect(await response.json()).toEqual({ error: 'Too many requests; try again later', code: 'rate_limited' })

      // Another IP is unaffected.
      expect((await custody.startEmailSignIn(emails[10]!, '/', { ip: randomIp() })).ok).toBe(true)
    })
    const [stored] = await sql<{ n: number; raw: number }[]>`
      select count(*)::int as n, count(*) filter (where ip_hash like ${`%${ip}%`})::int as raw
      from auth_email_tokens where email like ${`${emailPrefix}links%`} and ip_hash is not null
    `
    expect(stored.n).toBe(11)
    expect(stored.raw).toBe(0)
  })

  test('the 4th new-account mint from one IP in an hour is a 429', async () => {
    const ip = randomIp()
    await withEnv({ AUTH_MAX_MINTS_GLOBAL_HOUR: '1000000' }, async () => {
      for (let i = 0; i < 3; i++) {
        expect((await custody.startEmailSignIn(`${emailPrefix}mint${i}@example.test`, '/', { ip })).ok).toBe(true)
      }
      const minted = await sql<{ did: string }[]>`select did from accounts where email like ${`${emailPrefix}mint%`}`
      minted.forEach((r) => createdDids.add(r.did))
      expect(minted.length).toBe(3)

      const err = await custody.startEmailSignIn(`${emailPrefix}mint3@example.test`, '/', { ip }).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(custody.RateLimitedError)
      expect((await sql`select 1 from accounts where email = ${`${emailPrefix}mint3@example.test`}`).length).toBe(0)

      // The same IP can still ask for a link to an EXISTING account (4 links < 10).
      expect((await custody.startEmailSignIn(`${emailPrefix}mint0@example.test`, '/', { ip })).ok).toBe(true)
    })
  })

  test('the global new-account cap is a 429 once reached', async () => {
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from accounts where kind = 'custodial' and created_at > now() - interval '1 hour'
    `
    await withEnv({ AUTH_MAX_MINTS_GLOBAL_HOUR: String(n) }, async () => {
      const email = `${emailPrefix}global@example.test`
      const err = await custody.startEmailSignIn(email, '/', { ip: null }).then(() => null, (e: unknown) => e)
      expect(err).toBeInstanceOf(custody.RateLimitedError)
      expect((err as InstanceType<CustodyModule['RateLimitedError']>).code).toBe('rate_limited')
      expect((await sql`select 1 from accounts where email = ${email}`).length).toBe(0)
      expect((await sql`select 1 from auth_email_tokens where email = ${email}`).length).toBe(0)
    })
  })

  test('where mail is delivered, a new and an existing address answer identically, before any mint', async () => {
    const tasks: Array<() => Promise<void>> = []
    const defer = (task: () => Promise<void>) => void tasks.push(task)
    const fresh = `${emailPrefix}deferred@example.test`
    await withEnv({ RESEND_API_KEY: 're_test_not_a_real_key', AUTH_MAX_MINTS_GLOBAL_HOUR: '1000000' }, async () => {
      const newAddress = await custody.startEmailSignIn(fresh, '/', { ip: randomIp(), defer })
      const existing = await custody.startEmailSignIn(`${emailPrefix}mint0@example.test`, '/', { ip: randomIp(), defer })
      expect(newAddress).toEqual({ ok: true })
      expect(existing).toEqual(newAddress)
    })
    // The slow work (mint + mail) was handed to `after()`, not done before answering.
    expect(tasks.length).toBe(2)
    expect((await sql`select 1 from accounts where email = ${fresh}`).length).toBe(0)
  })

  test('HTTP: existing-email and new-email responses have the same shape; limits answer 429 + Retry-After', async () => {
    const email = `${emailPrefix}http@example.test`
    const post = () =>
      fetch(`${base}/api/auth/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email, next: '/' }),
      })
    const first = await post()
    const firstBody = (await first.json()) as Record<string, unknown>
    const [row] = await sql<{ did: string }[]>`select did from accounts where email = ${email}`
    expect(row, JSON.stringify(firstBody)).toBeTruthy()
    createdDids.add(row!.did)
    const second = await post()
    const secondBody = (await second.json()) as Record<string, unknown>
    expect(second.status).toBe(first.status)
    expect(first.status).toBe(200)
    expect(Object.keys(secondBody).sort()).toEqual(Object.keys(firstBody).sort())
    expect(secondBody.ok).toBe(firstBody.ok)

    for (let i = 0; i < 3; i++) expect((await post()).status).toBe(200)
    const limited = await post()
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await limited.json()).toEqual({ error: 'Too many requests; try again later', code: 'rate_limited' })
  })

  /* ───────────────────────────── 3. magic links ───────────────────────────── */

  test('GET /auth/verify renders a confirmation page and does not consume; POST does', async () => {
    const email = `${emailPrefix}verify@example.test`
    const start = await fetch(`${base}/api/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email, next: '/e/some-gathering/sessions?tab=mine' }),
    })
    const { devVerifyUrl } = (await start.json()) as { devVerifyUrl: string }
    expect(typeof devVerifyUrl).toBe('string')
    const token = new URL(devVerifyUrl).searchParams.get('token')!

    // A scanner's GETs: a page with the masked address and a form, no cookie, token untouched.
    for (let i = 0; i < 2; i++) {
      const page = await fetch(devVerifyUrl, { redirect: 'manual' })
      expect(page.status).toBe(200)
      expect(page.headers.get('set-cookie')).toBeNull()
      expect(page.headers.get('content-type')).toContain('text/html')
      const html = await page.text()
      expect(html).toContain('Continue signing in as <strong>s•••@example.test</strong>')
      expect(html).toContain('method="post" action="/auth/verify"')
      expect(html).not.toContain(email)
    }
    const [unused] = await sql<{ n: number }[]>`select count(*)::int as n from auth_email_tokens where email = ${email} and used_at is null`
    expect(unused.n).toBe(1)

    // An unknown token gets the same page (no address) — validity is not revealed on GET.
    const bogus = await fetch(`${base}/auth/verify?token=not-a-real-token`)
    expect(bogus.status).toBe(200)
    expect(await bogus.text()).toContain('method="post" action="/auth/verify"')

    const form = (t: string, headers: Record<string, string> = { origin: base }) =>
      fetch(`${base}/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams({ token: t }).toString(),
        redirect: 'manual',
      })

    expect((await form(token, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await form(token, { origin: 'https://evil.example' })).status).toBe(403)

    const ok = await form(token)
    expect(ok.status).toBe(303)
    const location = new URL(ok.headers.get('location') || '', base)
    expect(location.pathname + location.search).toBe('/e/some-gathering/sessions?tab=mine')
    expect(ok.headers.get('set-cookie') || '').toMatch(/^sp_at_session=[^;]+;.*HttpOnly/)
    const [row] = await sql<{ did: string }[]>`select did from accounts where email = ${email}`
    createdDids.add(row!.did)

    const reused = await form(token)
    expect(reused.status).toBe(303)
    const again = new URL(reused.headers.get('location') || '', base)
    expect(again.pathname).toBe('/login')
    expect(again.searchParams.get('error')).toBe('link')
    expect(reused.headers.get('set-cookie')).toBeNull()

    // A used token still renders the same page on GET.
    const used = await fetch(devVerifyUrl)
    expect(used.status).toBe(200)
    expect(await used.text()).toContain('method="post" action="/auth/verify"')
  })
})
