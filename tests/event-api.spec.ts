import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestGathering, signInWithEmail, type TestGathering } from './helpers/gathering'
import { rmdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'

// Events core HTTP surface (package A) against the running dev server (:3001) and the local
// stack (deploy/local: Postgres :55432, dev PDS :2583, handle domain `.test`). The dev server
// must run without a Resend key so sign-in hands back `devVerifyUrl`.
//
// Joins, subdomains and event uploads run against a public gathering this file creates; the seeded
// `draft-gathering` is only read. Everything created here (accounts, events) is removed afterwards.
loadEnvConfig(process.cwd(), true)

const base = process.env.EVENTS_TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const handleDomain = (process.env.PDS_HANDLE_DOMAIN || '').replace(/^\./, '')
const configured = Boolean(databaseUrl && pdsUrl && pdsAdminPassword && handleDomain)
const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const emailPrefix = `pkga-api-${run}`

test.describe.configure({ mode: 'serial', retries: 0 })

const adminAuth = () => `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`

/** Remove a stored test image and its (then empty) hash directory. */
async function removeUpload(url: string) {
  const file = path.join(process.env.UPLOADS_DIR || path.join(process.cwd(), '.uploads'), url.slice('/uploads/'.length))
  await unlink(file).catch(() => {})
  await rmdir(path.dirname(file)).catch(() => {})
}

/** fetch() cannot set `Host`; gathering subdomain routing needs a raw request. */
function getWithHost(pathname: string, host: string): Promise<{ status: number; location: string | null; body: string }> {
  const url = new URL(pathname, base)
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: 'GET', headers: { host } }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, location: (res.headers.location as string | undefined) ?? null, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function signIn(email: string): Promise<string> {
  return signInWithEmail(email, base)
}

test.describe('events core API', () => {
  test.skip(!configured, 'DATABASE_URL / PDS_URL / PDS_ADMIN_PASSWORD / PDS_HANDLE_DOMAIN are not set')

  let sql: postgres.Sql
  let cookie = ''
  let gathering: TestGathering
  let slug = ''

  test.beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 2, onnotice: () => {} })
    cookie = await signIn(`${emailPrefix}@example.com`)
    gathering = await createTestGathering(sql, { tag: 'events', status: 'proposals_open', visibility: 'public' })
    slug = gathering.slug
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    const accounts = await sql<{ id: string; did: string }[]>`select id, did from accounts where email like ${`${emailPrefix}%`}`
    for (const a of accounts) {
      await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: adminAuth() },
        body: JSON.stringify({ did: a.did }),
      })
    }
    if (accounts.length) await sql`delete from accounts where id in ${sql(accounts.map((a) => a.id))}`
    await sql`delete from auth_email_tokens where email like ${`${emailPrefix}%`}`
    await sql.end()
  })

  test('mutations reject unsigned requests before touching anything', async () => {
    const id = '00000000-0000-0000-0000-000000000000'
    const create = await fetch(`${base}/api/events/create`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ wizardState: {} }),
    })
    expect(create.status).toBe(401)
    const settings = await fetch(`${base}/api/events/${id}/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ status: 'published' }),
    })
    expect(settings.status).toBe(401)
    const identity = await fetch(`${base}/api/events/${id}/identity`, { method: 'POST', headers: { origin: base } })
    expect(identity.status).toBe(401)
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'x.png')
    const upload = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { origin: base }, body: form })
    expect(upload.status).toBe(401)
  })

  test('cross-origin mutations are refused even with a valid session', async () => {
    const create = await fetch(`${base}/api/events/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie },
      body: JSON.stringify({ wizardState: {} }),
    })
    expect(create.status).toBe(403)
    const join = await fetch(`${base}/api/v1/events/${slug}/me`, {
      method: 'POST', headers: { origin: 'https://evil.example', cookie, 'sec-fetch-site': 'cross-site' },
    })
    expect(join.status).toBe(403)
  })

  test('slug validation handles malformed requests without a server error', async () => {
    for (const data of [null, {}, { slug: 123 }, { slug: 'bad slug' }]) {
      const response = await fetch(`${base}/api/events/validate-slug`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      })
      expect(response.status).toBe(400)
      expect((await response.json()).available).toBe(false)
    }
  })

  test('slug availability covers events, reserved labels, member handles, and previews the handle', async () => {
    const post = (slug: string) => fetch(`${base}/api/events/validate-slug`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }))

    const existing = await post(slug)
    expect(existing.status).toBe(200)
    expect(existing.body.available).toBe(false)

    const reserved = await post('pds')
    expect(reserved.body.available).toBe(false)

    const [me] = await sql<{ handle: string }[]>`select handle from accounts where email = ${`${emailPrefix}@example.com`}`
    const memberLabel = me.handle.slice(0, me.handle.indexOf('.'))
    const member = await post(memberLabel)
    expect(member.body.available).toBe(false)
    expect(member.body.error).toMatch(/belongs to someone/)

    const short = await post(`free-${run}`.slice(0, 18))
    expect(short.body).toMatchObject({ available: true, handle: { handle: `${`free-${run}`.slice(0, 18)}.${handleDomain}`, generated: false } })

    const long = await post(`a-much-longer-gathering-${run}`.slice(0, 32).replace(/-+$/, ''))
    expect(long.body.available).toBe(true)
    expect(long.body.handle).toMatchObject({ handle: null, generated: true, reason: 'too-long' })
  })

  test('health reports the database and the PDS without details', async () => {
    const res = await fetch(`${base}/api/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(await res.json()).toEqual({ status: 'ok', checks: { db: 'ok', pds: 'ok' } })
  })

  test('gathering subdomains render the gathering; unknown labels go to the apex', async () => {
    const host = `${slug}.${handleDomain}`
    const page = await getWithHost('/', host)
    expect(page.status).toBe(200)
    expect(page.body).toContain(`<title>${gathering.name} | Schelling Point</title>`)

    const sessions = await getWithHost('/sessions', host)
    expect(sessions.status).toBe(200)
    expect(sessions.body).toContain(gathering.name)

    const unknown = await getWithHost('/', `no-such-gathering-${run}.${handleDomain}`)
    expect(unknown.status).toBe(307)
    expect(new URL(unknown.location || '', base).pathname).toBe('/')

    // APIs and handle resolution are never rewritten onto the event.
    const api = await getWithHost('/api/health', host)
    expect(api.status).toBe(200)
    expect(JSON.parse(api.body).status).toBe('ok')
    const wellKnown = await getWithHost('/.well-known/atproto-did', host)
    expect(wellKnown.status).toBe(404)
    expect(wellKnown.body).not.toContain(gathering.name)

    // The apex is untouched.
    const apex = await getWithHost('/', new URL(base).host)
    expect(apex.status).toBe(200)
    expect(apex.body).not.toContain(`<title>${gathering.name}`)
  })

  test('draft gatherings are hidden from non-members', async () => {
    const anon = await fetch(`${base}/api/v1/events/draft-gathering/me`)
    expect(anon.status).toBe(404)
    const signedIn = await fetch(`${base}/api/v1/events/draft-gathering/me`, { headers: { cookie } })
    expect(signedIn.status).toBe(404)
    const join = await fetch(`${base}/api/v1/events/draft-gathering/me`, { method: 'POST', headers: { cookie, origin: base } })
    expect(join.status).toBe(404)
    const page = await (await fetch(`${base}/e/draft-gathering`, { headers: { cookie } })).text()
    expect(page).toContain('<title>Gathering not available</title>')
    expect(page).not.toContain('draft-gathering |')
  })

  test('viewing a gathering never makes you a member; joining is an explicit POST', async () => {
    const memberships = async () => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from event_members m join accounts a on a.id = m.user_id join events e on e.id = m.event_id
        where a.email = ${`${emailPrefix}@example.com`} and e.slug = ${slug}
      `
      return row.n
    }
    expect(await memberships()).toBe(0)

    // The landing page and a sub-page, rendered for the signed-in visitor.
    expect((await fetch(`${base}/e/${slug}`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${base}/e/${slug}/sessions`, { headers: { cookie } })).status).toBe(200)
    // The read the event context makes on every page.
    const me = await fetch(`${base}/api/v1/events/${slug}/me`, { headers: { cookie } })
    expect(me.status).toBe(200)
    expect(await me.json()).toEqual({ role: null, member: false, voteCredits: null, joinable: true, joinBlockedBy: null })
    expect(await memberships()).toBe(0)

    // A GET is never a join, whatever the method override games.
    expect((await fetch(`${base}/api/v1/events/${slug}/me?join=1`, { headers: { cookie } })).status).toBe(200)
    expect(await memberships()).toBe(0)

    const join = await fetch(`${base}/api/v1/events/${slug}/me`, { method: 'POST', headers: { cookie, origin: base } })
    expect(join.status).toBe(201)
    expect(await join.json()).toMatchObject({ role: 'attendee', member: true, joinable: false })
    expect(await memberships()).toBe(1)

    const again = await fetch(`${base}/api/v1/events/${slug}/me`, { method: 'POST', headers: { cookie, origin: base } })
    expect(again.status).toBe(200)
    expect((await again.json()).role).toBe('attendee')
    expect(await memberships()).toBe(1)
  })

  test('any signed-in account uploads its own avatar, within the avatar limits', async () => {
    const png = (extra: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(extra)])
    const avatar = new FormData()
    avatar.append('file', new Blob([png(`avatar-${run}`)], { type: 'image/png' }), 'me.png')
    avatar.append('purpose', 'avatar')
    const ok = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: avatar })
    expect(ok.status).toBe(201)
    const { url } = await ok.json()
    expect(url).toMatch(/^\/uploads\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
    await removeUpload(url)

    const big = new FormData()
    big.append('file', new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: 'image/png' }), 'me.png')
    big.append('purpose', 'avatar')
    expect((await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: big })).status).toBe(413)

    const notImage = new FormData()
    notImage.append('file', new Blob(['GIF? no'], { type: 'image/gif' }), 'me.gif')
    notImage.append('purpose', 'avatar')
    expect((await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: notImage })).status).toBe(415)

    const mixed = new FormData()
    mixed.append('file', new Blob([png('mixed')], { type: 'image/png' }), 'me.png')
    mixed.append('purpose', 'avatar')
    mixed.append('event', slug)
    expect((await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: mixed })).status).toBe(400)

    const unknown = new FormData()
    unknown.append('file', new Blob([png('unknown')], { type: 'image/png' }), 'me.png')
    unknown.append('purpose', 'banner')
    expect((await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: unknown })).status).toBe(400)

    const anon = new FormData()
    anon.append('file', new Blob([png('anon')], { type: 'image/png' }), 'me.png')
    anon.append('purpose', 'avatar')
    expect((await fetch(`${base}/api/uploads`, { method: 'POST', headers: { origin: base }, body: anon })).status).toBe(401)
  })

  test('uploads refuse non-images and non-organizers', async () => {
    const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: 'image/png' })
    const notImage = new FormData()
    notImage.append('file', svg, 'logo.png')
    const refused = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: notImage })
    expect(refused.status).toBe(415)

    // The test account is only an attendee of the test gathering (it joined above).
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(run)])
    const forEvent = new FormData()
    forEvent.append('file', new Blob([png], { type: 'image/png' }), 'logo.png')
    forEvent.append('event', slug)
    const forbidden = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: forEvent })
    expect(forbidden.status).toBe(403)

    const tooBig = new FormData()
    tooBig.append('file', new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' }), 'big.png')
    expect((await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: tooBig })).status).toBe(413)
  })

  test('an upload is content-addressed and served immutably', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(`wizard-${run}`)])
    const form = () => {
      const f = new FormData()
      f.append('file', new Blob([png], { type: 'image/png' }), 'logo.png')
      return f
    }
    const first = await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: form() })
    expect(first.status).toBe(201)
    const { url } = await first.json()
    expect(url).toMatch(/^\/uploads\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
    const second = await (await fetch(`${base}/api/uploads`, { method: 'POST', headers: { cookie, origin: base }, body: form() })).json()
    expect(second.url).toBe(url)

    const served = await fetch(`${base}${url}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png)

    expect((await fetch(`${base}/uploads/00/not-a-hash.png`)).status).toBe(404)
    await removeUpload(url)
  })
})
