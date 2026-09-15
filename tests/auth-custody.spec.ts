import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { verifyMagicLink } from './helpers/gathering'

// The email door end to end against the running dev server (:3001) and the local stack
// (deploy/local: Postgres :55432, dev PDS :2583 with handle domain `.test`).
//
// The dev server must run WITHOUT a Resend key so the API hands back `devVerifyUrl`. Opening that
// link renders a confirmation page; its form POST consumes the token:
//   RESEND_API_KEY= npm run dev
//
// Every account created here is deleted afterwards, from Postgres and from the PDS.
loadEnvConfig(process.cwd(), true)

const base = process.env.AUTH_TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const handleDomain = (process.env.PDS_HANDLE_DOMAIN || '').replace(/^\./, '')
const configured = Boolean(databaseUrl && pdsUrl && pdsAdminPassword && handleDomain && process.env.ATPROTO_SESSION_SECRET)

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('custodial email sign-in', () => {
  test.skip(!configured, 'DATABASE_URL / PDS_URL / PDS_ADMIN_PASSWORD / PDS_HANDLE_DOMAIN / ATPROTO_SESSION_SECRET are not set')

  let sql: postgres.Sql
  const email = `auth-custody-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  const next = '/e/some-gathering/sessions?tab=mine'
  const createdDids = new Set<string>()
  let verifyUrl = ''
  let cookie = ''
  let did = ''

  test.beforeAll(() => {
    sql = postgres(databaseUrl, { max: 2, onnotice: () => {} })
  })

  test.afterAll(async () => {
    const rows = await sql<{ did: string }[]>`select did from accounts where email = ${email}`
    for (const r of rows) createdDids.add(r.did)
    for (const d of createdDids) {
      const res = await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`,
        },
        body: JSON.stringify({ did: d }),
      })
      expect(res.ok, `PDS deleteAccount ${d}`).toBe(true)
    }
    if (createdDids.size) await sql`delete from accounts where did in ${sql([...createdDids])}`
    await sql`delete from auth_email_tokens where email = ${email}`
    await sql.end()
  })

  test('POST /api/auth/email mints an identity and returns a dev verify link', async () => {
    const res = await fetch(`${base}/api/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.toUpperCase(), next }),
    })
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body.ok).toBe(true)
    expect(typeof body.devVerifyUrl, 'start the dev server with RESEND_API_KEY= so mail is not delivered').toBe('string')
    verifyUrl = body.devVerifyUrl
    expect(verifyUrl).toContain('/auth/verify?token=')
  })

  test('the account row has a PLC DID, a generated handle and a profile', async () => {
    const [account] = await sql<{ id: string; did: string; handle: string; kind: string; wrapped: boolean; email: string }[]>`
      select id, did, handle, kind, wrapped_password is not null as wrapped, email from accounts where email = ${email}
    `
    expect(account).toBeTruthy()
    did = account.did
    createdDids.add(did)
    expect(account.did).toMatch(/^did:plc:[a-z2-7]{24}$/)
    expect(account.handle.endsWith(`.${handleDomain}`)).toBe(true)
    expect(account.handle).toMatch(/^[a-z]+\d{3}\./)
    expect(account.handle).not.toContain('auth-custody')
    expect(account.kind).toBe('custodial')
    expect(account.wrapped).toBe(true)
    expect(account.email).toBe(email)

    const [profile] = await sql<{ id: string; did: string | null }[]>`select id, did from profiles where id = ${account.id}`
    expect(profile?.id).toBe(account.id)
    expect(profile?.did).toBe(account.did)

    const [token] = await sql<{ n: number }[]>`
      select count(*)::int as n from auth_email_tokens where email = ${email} and purpose = 'signin' and used_at is null
    `
    expect(token.n).toBe(1)
  })

  test('the handle resolves on the local PDS', async () => {
    const [account] = await sql<{ handle: string }[]>`select handle from accounts where did = ${did}`
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(account.handle)}`)
    expect(res.status).toBe(200)
    expect((await res.json()).did).toBe(did)
  })

  test('opening the link only renders a confirmation; the form POST sets the session cookie and redirects to next', async () => {
    // A GET (what a mail scanner issues) renders the page and leaves the token unused.
    const page = await fetch(verifyUrl, { redirect: 'manual' })
    expect(page.status).toBe(200)
    expect(page.headers.get('set-cookie')).toBeNull()
    expect(await page.text()).toContain('<form method="post" action="/auth/verify">')
    const [unused] = await sql<{ n: number }[]>`
      select count(*)::int as n from auth_email_tokens where email = ${email} and purpose = 'signin' and used_at is null
    `
    expect(unused.n).toBe(1)

    const res = await verifyMagicLink(verifyUrl, base)
    expect(res.status).toBe(303)
    const location = new URL(res.location || '', base)
    expect(location.pathname + location.search).toBe(next)
    const setCookie = res.setCookie || ''
    expect(setCookie).toMatch(/^sp_at_session=[^;]+/)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    cookie = res.cookie!
  })

  test('GET /api/auth/me with the cookie returns the user and profile', async () => {
    const res = await fetch(`${base}/api/auth/me`, { headers: { cookie } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user).toMatchObject({ email, did, kind: 'custodial' })
    expect(body.user.handle.endsWith(`.${handleDomain}`)).toBe(true)
    expect(body.profile?.id).toBe(body.user.id)

    const anon = await (await fetch(`${base}/api/auth/me`)).json()
    expect(anon).toEqual({ user: null, profile: null })
  })

  test('take ownership rotates the password and reveals it exactly once', async () => {
    const res = await fetch(`${base}/api/me/take-ownership`, { method: 'POST', headers: { cookie, origin: base } })
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(typeof body.revealUrl).toBe('string')
    const token = new URL(body.revealUrl).searchParams.get('token') || ''

    const again = await fetch(`${base}/api/me/take-ownership`, { method: 'POST', headers: { cookie, origin: base } })
    expect(again.status).toBe(409)

    const [account] = await sql<{ owned: boolean; wrapped: boolean; handle: string }[]>`
      select owned_at is not null as owned, wrapped_password is not null as wrapped, handle from accounts where did = ${did}
    `
    expect(account).toMatchObject({ owned: true, wrapped: false })

    const reveal = await fetch(`${base}/api/me/reveal?token=${encodeURIComponent(token)}`)
    expect(reveal.status).toBe(200)
    const revealed = await reveal.json()
    expect(revealed.handle).toBe(account.handle)
    expect(revealed.password.length).toBeGreaterThanOrEqual(20)

    const login = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: account.handle, password: revealed.password }),
    })
    expect(login.status).toBe(200)

    expect((await fetch(`${base}/api/me/reveal?token=${encodeURIComponent(token)}`)).status).toBe(410)
    const [stored] = await sql<{ n: number }[]>`select count(*)::int as n from at_credentials where created_by = (select id from accounts where did = ${did})`
    expect(stored.n).toBe(0)

    const identity = await (await fetch(`${base}/api/atproto/me`, { headers: { cookie } })).json()
    expect(identity).toMatchObject({ linked: true, did, kind: 'custodial', owned: true })
  })

  test('a used token redirects to /login?error=link', async () => {
    const res = await verifyMagicLink(verifyUrl, base)
    expect(res.status).toBe(303)
    const location = new URL(res.location || '', base)
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('error')).toBe('link')
    expect(res.setCookie).toBeNull()
  })

  test('a returning email reuses the same account', async () => {
    const res = await fetch(`${base}/api/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    expect(res.status).toBe(200)
    const rows = await sql<{ did: string }[]>`select did from accounts where email = ${email}`
    expect(rows.map((r) => r.did)).toEqual([did])
  })

  test('cross-site mutations are refused', async () => {
    const crossSite = await fetch(`${base}/api/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ email }),
    })
    expect(crossSite.status).toBe(403)
    expect((await crossSite.json()).error).toBe('Cross-origin request refused')

    const foreignOrigin = await fetch(`${base}/api/auth/signout`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(foreignOrigin.status).toBe(403)
    // The refused signout did not end the session.
    expect((await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()).user?.did).toBe(did)
  })

  test('POST /api/auth/signout clears the cookie and ends the session', async () => {
    const res = await fetch(`${base}/api/auth/signout`, {
      method: 'POST',
      headers: { cookie, origin: base },
    })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie') || ''
    expect(setCookie).toMatch(/sp_at_session=;/)
    expect(setCookie).toContain('Max-Age=0')

    const me = await (await fetch(`${base}/api/auth/me`, { headers: { cookie } })).json()
    expect(me).toEqual({ user: null, profile: null })
  })

  test('sign-in links are rate limited per email', async () => {
    // One link from the first test and one from "returning email": three more are allowed.
    for (let i = 0; i < 3; i++) {
      const ok = await fetch(`${base}/api/auth/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      expect(ok.status).toBe(200)
    }
    const limited = await fetch(`${base}/api/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    expect(limited.status).toBe(429)
  })

  test('the Bluesky door requires the hard confirm and refuses linking', async () => {
    const noConfirm = await fetch(`${base}/api/atproto/auth/start?handle=someone.bsky.social&purpose=signin`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    })
    expect(noConfirm.status).toBe(400)
    const body = await noConfirm.json()
    expect(body.error).toBe('confirmation_required')
    expect(body.detail).toContain('permanently attached to this identity')

    const link = await fetch(`${base}/api/atproto/auth/start?handle=someone.bsky.social&purpose=link&confirm=1`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    })
    expect(link.status).toBe(409)
  })

  test('an invalid email is a 400', async () => {
    const res = await fetch(`${base}/api/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    })
    expect(res.status).toBe(400)
  })
})
