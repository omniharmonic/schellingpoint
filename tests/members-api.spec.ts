import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'

/**
 * Members and invitations (work package D) against the running dev server (:3001), the local
 * Postgres and the local PDS (docs/ATPROTO_APPVIEW_PLAN.md §7.3). Accounts come through the real
 * custodial door; the dev server must run without a mail key. Everything created is removed.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.MEMBERS_TEST_BASE_URL || 'http://localhost:3001'
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(ownerUrl && pdsUrl && pdsAdminPassword)
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(ownerUrl).hostname)
  } catch {
    return false
  }
})()

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const EMAIL = (who: string) => `pkgd-members+${who}-${RUN}@example.test`
const adminAuth = `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`

interface Account { email: string; cookie: string; id: string; did: string }

async function signIn(sql: postgres.Sql, who: string): Promise<Account> {
  const email = EMAIL(who)
  const res = await fetch(`${base}/api/auth/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ email, next: '/' }),
  })
  const body = await res.json()
  expect(res.status, JSON.stringify(body)).toBe(200)
  expect(typeof body.devVerifyUrl, 'run the dev server without RESEND_API_KEY').toBe('string')
  const verify = await fetch(body.devVerifyUrl, { redirect: 'manual' })
  const cookie = (verify.headers.getSetCookie?.() ?? [verify.headers.get('set-cookie') ?? ''])
    .map((c) => c.split(';')[0])
    .find((c) => c.startsWith('sp_at_session='))
  expect(cookie, 'verify sets the session cookie').toBeTruthy()
  const [row] = await sql<{ id: string; did: string }[]>`select id, did from accounts where email = ${email}`
  return { email, cookie: cookie!, id: row.id, did: row.did }
}

async function api(path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { origin: base }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, text }
}

test('member and invitation endpoints reject unsigned requests', async () => {
  const fake = '00000000-0000-4000-8000-000000000000'
  expect((await api(`/api/v1/events/demo-gathering/members/${fake}`, { method: 'PATCH', json: { role: 'admin' } })).status).toBe(401)
  expect((await api(`/api/v1/events/demo-gathering/members/${fake}`, { method: 'DELETE' })).status).toBe(401)
  expect((await api('/api/v1/events/demo-gathering/invitations')).status).toBe(401)
  expect((await api(`/api/v1/invitations/${'a'.repeat(64)}/accept`, { method: 'POST' })).status).toBe(401)
  expect((await api('/api/v1/invitations/not-a-token')).status).toBe(404)
})

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('members and invitations (package D)', () => {
  test.skip(!configured || !isLocal, 'Needs the local stack: DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD (plan §7.3)')

  let sql: postgres.Sql
  let owner: Account
  let admin: Account
  let joinerA: Account
  let joinerB: Account
  let eventId = ''
  const slug = `pkgd-members-${RUN}`

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    sql = postgres(ownerUrl, { max: 3, onnotice: () => {} })
    owner = await signIn(sql, 'owner')
    admin = await signIn(sql, 'admin')
    joinerA = await signIn(sql, 'joiner-a')
    joinerB = await signIn(sql, 'joiner-b')
    const [event] = await sql<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, visibility, timezone)
      values (${slug}, 'Package D members', current_date + 20, current_date + 21, 'published', 'private', 'America/Denver')
      returning id
    `
    eventId = event.id
    await sql`insert into event_members (event_id, user_id, role) values (${eventId}, ${owner.id}, 'owner'), (${eventId}, ${admin.id}, 'admin')`
  })

  test.afterAll(async () => {
    if (!sql) return
    await sql`delete from events where id = ${eventId}`
    const accounts = await sql<{ did: string; id: string }[]>`select did, id from accounts where email like ${`pkgd-members+%-${RUN}@example.test`}`
    for (const a of accounts) {
      await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: adminAuth },
        body: JSON.stringify({ did: a.did }),
      })
    }
    if (accounts.length) await sql`delete from accounts where id in ${sql(accounts.map((a) => a.id))}`
    await sql`delete from auth_email_tokens where email like ${`pkgd-members+%-${RUN}@example.test`}`
    await sql.end({ timeout: 5 })
  })

  test('roster is for owners and admins; strangers to a private gathering get 404', async () => {
    const roster = await api(`/api/v1/events/${slug}/members`, { cookie: admin.cookie })
    expect(roster.status, roster.text).toBe(200)
    expect(roster.body.members.map((m: { user_id: string }) => m.user_id).sort()).toEqual([owner.id, admin.id].sort())
    expect((await api(`/api/v1/events/${slug}/members`, { cookie: joinerA.cookie })).status).toBe(404)
    expect((await api(`/api/v1/events/${slug}/invitations`, { cookie: joinerA.cookie })).status).toBe(404)
  })

  test('a single-use link cannot be redeemed twice, even by concurrent accepts', async () => {
    expect((await api(`/api/v1/events/${slug}/invitations`, { method: 'POST', cookie: admin.cookie, json: { role: 'moderator' } })).status, 'elevated links need a limit').toBe(400)
    expect((await api(`/api/v1/events/${slug}/invitations`, { method: 'POST', cookie: admin.cookie, json: { role: 'admin', max_uses: 1 } })).status, 'only owners invite admins').toBe(403)

    const created = await api(`/api/v1/events/${slug}/invitations`, { method: 'POST', cookie: owner.cookie, json: { role: 'volunteer', max_uses: 1 } })
    expect(created.status, created.text).toBe(201)
    const token: string = created.body.invitations[0].token
    expect(created.body.inviteUrl).toContain(`/invite/e/${token}`)

    const preview = await api(`/api/v1/invitations/${token}`)
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ role: 'volunteer', exhausted: false, max_uses: 1, use_count: 0 })
    expect(preview.text, 'the preview never names the inviter').not.toContain(owner.email)

    const [first, second] = await Promise.all([
      api(`/api/v1/invitations/${token}/accept`, { method: 'POST', cookie: joinerA.cookie }),
      api(`/api/v1/invitations/${token}/accept`, { method: 'POST', cookie: joinerB.cookie }),
    ])
    const statuses = [first.status, second.status].sort()
    expect(statuses, `${first.text} / ${second.text}`).toEqual([200, 410])
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from event_members where event_id = ${eventId} and role = 'volunteer'`
    expect(n).toBe(1)
    const [inv] = await sql<{ use_count: number; last_redeemed_at: string | null }[]>`select use_count, last_redeemed_at from event_invitations where token = ${token}`
    expect(inv.use_count).toBe(1)
    expect(inv.last_redeemed_at).not.toBeNull()
    expect((await api(`/api/v1/invitations/${token}`)).body.exhausted).toBe(true)
  })

  test('email invitations: existing accounts are invited in the app, the address must match, roles upgrade', async () => {
    const [joined] = await sql<{ user_id: string }[]>`select user_id from event_members where event_id = ${eventId} and role = 'volunteer'`
    const outsider = joined.user_id === joinerA.id ? joinerB : joinerA
    const member = joined.user_id === joinerA.id ? joinerA : joinerB
    const newcomer = `pkgd-members+nobody-${RUN}@example.test`

    const sent = await api(`/api/v1/events/${slug}/invitations`, {
      method: 'POST',
      cookie: owner.cookie,
      json: { emails: [outsider.email.toUpperCase(), newcomer], role: 'attendee' },
    })
    expect(sent.status, sent.text).toBe(201)
    const results = Object.fromEntries(sent.body.emailResults.map((r: { email: string; channel: string }) => [r.email, r.channel]))
    expect(results[outsider.email]).toBe('notification')
    expect(results[newcomer]).toBe('email')

    const [note] = await sql<{ action_url: string; data: Record<string, unknown> }[]>`
      select action_url, data from notifications where user_id = ${outsider.id} and event_id = ${eventId} and type = 'event_invitation'
    `
    expect(note.action_url).toMatch(/^\/invite\/e\/[0-9a-f]{64}$/)
    expect(JSON.stringify(note.data)).not.toContain(owner.id)
    const token = note.action_url.split('/').pop()!

    // The member's own address does not match this invitation.
    const wrong = await api(`/api/v1/invitations/${token}/accept`, { method: 'POST', cookie: member.cookie })
    expect(wrong.status).toBe(403)
    const ok = await api(`/api/v1/invitations/${token}/accept`, { method: 'POST', cookie: outsider.cookie })
    expect(ok.status, ok.text).toBe(200)
    expect((await api(`/api/v1/invitations/${token}/accept`, { method: 'POST', cookie: outsider.cookie })).status).toBe(409)

    // An invitation to a higher role upgrades an existing member; a lower one never downgrades.
    const upgrade = await api(`/api/v1/events/${slug}/invitations`, { method: 'POST', cookie: owner.cookie, json: { role: 'moderator', max_uses: 2 } })
    const upToken: string = upgrade.body.invitations[0].token
    expect((await api(`/api/v1/invitations/${upToken}/accept`, { method: 'POST', cookie: member.cookie })).status).toBe(200)
    const [{ role }] = await sql<{ role: string }[]>`select role from event_members where event_id = ${eventId} and user_id = ${member.id}`
    expect(role).toBe('moderator')

    // Inviter retention (spec §9): once created_by is nulled the list shows no inviter.
    await sql`update event_invitations set created_by = null where token = ${upToken}`
    const list = await api(`/api/v1/events/${slug}/invitations`, { cookie: owner.cookie })
    expect(list.body.invitations.find((i: { token: string }) => i.token === upToken).invited_by).toBeNull()

    const revoked = await api(`/api/v1/events/${slug}/invitations/${upgrade.body.invitations[0].id}`, { method: 'DELETE', cookie: admin.cookie })
    expect(revoked.status).toBe(200)
    expect((await api(`/api/v1/invitations/${upToken}/accept`, { method: 'POST', cookie: outsider.cookie })).status).toBe(410)
  })

  test('role changes and removal respect the owner rules', async () => {
    // Nobody changes their own role; admins cannot touch owners or grant ownership.
    expect((await api(`/api/v1/events/${slug}/members/${owner.id}`, { method: 'PATCH', cookie: owner.cookie, json: { role: 'admin' } })).status).toBe(403)
    expect((await api(`/api/v1/events/${slug}/members/${owner.id}`, { method: 'PATCH', cookie: admin.cookie, json: { role: 'attendee' } })).status).toBe(403)
    expect((await api(`/api/v1/events/${slug}/members/${joinerA.id}`, { method: 'PATCH', cookie: admin.cookie, json: { role: 'owner' } })).status).toBe(403)
    expect((await api(`/api/v1/events/${slug}/members/${owner.id}`, { method: 'DELETE', cookie: admin.cookie })).status).toBe(403)
    expect((await api(`/api/v1/events/${slug}/members/${joinerA.id}`, { method: 'PATCH', cookie: admin.cookie, json: { role: 'emperor' } })).status).toBe(400)

    // The owner can make the admin a co-owner; then either owner may step the other down.
    const promoted = await api(`/api/v1/events/${slug}/members/${admin.id}`, { method: 'PATCH', cookie: owner.cookie, json: { role: 'owner' } })
    expect(promoted.status, promoted.text).toBe(200)
    expect(promoted.body.member.role).toBe('owner')
    const demoted = await api(`/api/v1/events/${slug}/members/${owner.id}`, { method: 'PATCH', cookie: admin.cookie, json: { role: 'admin' } })
    expect(demoted.status, demoted.text).toBe(200)

    // Removal keeps the account; the removed person loses access to the private gathering.
    const removed = await api(`/api/v1/events/${slug}/members/${joinerA.id}`, { method: 'DELETE', cookie: admin.cookie })
    expect(removed.status, removed.text).toBe(200)
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from event_members where event_id = ${eventId} and user_id = ${joinerA.id}`
    expect(n).toBe(0)
    expect((await api(`/api/v1/events/${slug}/members`, { cookie: joinerA.cookie })).status).toBe(404)
  })
})
