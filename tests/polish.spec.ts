import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import webpush from 'web-push'
import { createTestAccount, createTestGathering, withServerOnlyShim, type TestAccount, type TestGathering } from './helpers/gathering'
import { readUploadBody } from '../src/lib/storage/body'

test.describe.configure({ mode: 'serial', retries: 0 })
const local = /^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):/.test(process.env.DATABASE_URL || '')
let db: typeof import('../src/lib/db')
let voting: typeof import('../src/lib/voting')
let push: typeof import('../src/lib/notifications/push')
let route: typeof import('../src/app/api/me/push/route')
let activity: typeof import('../src/lib/events/activity')
let account: TestAccount
let gathering: TestGathering
let session: string
let keys: ReturnType<typeof webpush.generateVAPIDKeys>
const base = 'http://localhost:3001'
const request = (method: string, body?: unknown, origin = base, cookie = account.cookie) => new Request(`${base}/api/me/push`, { method, headers: { origin, cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const subscription = (suffix: string = randomUUID()) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: keys.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } })

test.beforeAll(async () => {
  test.skip(!local, 'Only the local database and mock PLC may be used')
  await withServerOnlyShim(async () => {
    db = require('../src/lib/db')
    voting = require('../src/lib/voting')
    push = require('../src/lib/notifications/push')
    route = require('../src/app/api/me/push/route')
    activity = require('../src/lib/events/activity')
  })
  keys = webpush.generateVAPIDKeys()
  process.env.WEB_PUSH_PUBLIC_KEY = keys.publicKey
  process.env.WEB_PUSH_PRIVATE_KEY = keys.privateKey
  account = await createTestAccount('polish', { sql: db.sql })
  gathering = await createTestGathering(db.sql, { tag: 'polish', name: 'Networks of care', status: 'voting_open', ticketingEnabled: true, withProgram: true })
  await db.sql`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${account.id}, 'owner')`
  await db.sql`insert into profiles (id, email, display_name, onboarding_completed) values (${account.id}, ${account.email}, 'Alex Rivers', true) on conflict (id) do update set onboarding_completed = true`
  const [s] = await db.sql`insert into sessions (event_id, title, description, format, duration, host_id, status, is_votable) values (${gathering.id}, 'Building a neighborhood commons', 'What would it take to share tools, skills and spaces across a neighborhood? Bring an example, a question, or something you would like to try.\n\nWe will map what already exists, find the gaps, and leave with a small experiment we can do together.', 'workshop', 60, ${account.id}, 'approved', true) returning id`
  session = s.id
})
test.afterAll(async () => {
  await gathering?.cleanup()
  await account?.cleanup()
  await db?.sql.end({ timeout: 5 })
})

test('streamed uploads preserve bytes, bound undeclared bodies and reject truncation', async () => {
  const bytes = new Uint8Array(1024).fill(42)
  const req = () => new Request(`${base}/api/uploads?event=mine&purpose=logo`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes })
  const form = await readUploadBody(req(), 1024)
  expect(new Uint8Array(await (form.get('file') as File).arrayBuffer())).toEqual(bytes)
  expect(form.get('event')).toBe('mine')
  await expect(readUploadBody(req(), 100)).rejects.toThrow('TooLarge')
  await expect(readUploadBody(new Request(base, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '2000' }, body: bytes }), 3000)).rejects.toThrow('IncompleteUpload')
})

test('owners and admins can vote without admission; other roles remain gated and totals stay private', async () => {
  const round = await voting.openRound(gathering.id, { opensAt: new Date(Date.now() - 1000), closesAt: new Date(Date.now() + 3600_000) })
  for (const role of ['owner', 'admin']) {
    await db.sql`update event_members set role = ${role} where event_id = ${gathering.id} and user_id = ${account.id}`
    const result = await voting.setAllocation(gathering.id, account.id, session, 2)
    expect(result.allocation[session]).toBe(2)
    expect(result.spent).toBe(4)
  }
  for (const role of ['moderator', 'attendee']) {
    await db.sql`update event_members set role = ${role} where event_id = ${gathering.id} and user_id = ${account.id}`
    expect((await voting.checkEligibility(db.sql, gathering.id, account.id)).code).toBe('TicketRequired')
    await expect(voting.setAllocation(gathering.id, account.id, session, 3)).rejects.toThrow()
  }
  await db.sql`update event_members set role = 'owner' where event_id = ${gathering.id} and user_id = ${account.id}`
  expect(await activity.loadEventActivity(gathering.id)).toMatchObject({ mode: 'endorsements', votingOpen: true, entries: [] })
  await voting.closeRound(round!.id, { publish: false })
  expect(await activity.loadEventActivity(gathering.id)).toMatchObject({ mode: 'results', entries: [], threshold: 3 })
})

test('the overview uses public endorsements while open and only shareable closed results', async () => {
  const event = await createTestGathering(db.sql, { tag: 'pulse', status: 'proposals_open', policyThresholds: { feedbackK: 3 } })
  const others: TestAccount[] = []
  try {
    for (let i = 0; i < 2; i++) others.push(await createTestAccount(`pulse-${i}`, { sql: db.sql }))
    const voters = [account, ...others]
    for (const v of voters) await db.sql`insert into event_members (event_id, user_id, role) values (${event.id}, ${v.id}, 'attendee')`
    const uri = `at://${account.did}/schellingpoint.draft.proposal/${randomUUID()}`
    const sessions = await db.sql`insert into sessions (event_id, title, format, duration, host_id, status, is_votable, proposal_uri) values (${event.id}, 'Shared support', 'talk', 30, ${account.id}, 'approved', true, ${uri}), (${event.id}, 'Private small result', 'talk', 30, ${account.id}, 'approved', true, null) returning id, title`
    const first = sessions.find(s => s.title === 'Shared support')!, second = sessions.find(s => s.title === 'Private small result')!
    const rkey = randomUUID(), endorsementUri = `at://${account.did}/schellingpoint.draft.endorsement/${rkey}`
    await db.sql`insert into at_records (uri, did, collection, rkey, record) values (${endorsementUri}, ${account.did}, 'schellingpoint.draft.endorsement', ${rkey}, ${db.sql.json({ proposal: { uri } })})`
    try {
      await db.sql`update events set status = 'voting_open' where id = ${event.id}`
      const round = await voting.openRound(event.id, { closesAt: new Date(Date.now() + 3600_000) })
      for (const v of voters) await voting.setAllocation(event.id, v.id, first.id, 2)
      await voting.setAllocation(event.id, account.id, second.id, 5)
      expect((await activity.loadEventActivity(event.id)).entries).toEqual([{ id: first.id, title: first.title, count: 1 }])
      await voting.closeRound(round.id, { publish: false })
      expect(await activity.loadEventActivity(event.id)).toMatchObject({ mode: 'results', entries: [{ id: first.id, title: first.title, count: 6 }] })
      await db.sql`update sessions set hidden_by_moderation = true where id = ${first.id}`
      expect((await activity.loadEventActivity(event.id)).entries).toEqual([])
    } finally { await db.sql`delete from at_records where uri = ${endorsementUri}` }
  } finally {
    await event.cleanup()
    for (const v of others) await v.cleanup()
  }
})

test('push subscription is authenticated, same-origin, bounded and tied to this session', async () => {
  expect((await route.POST(request('POST', subscription(), base, ''))).status).toBe(401)
  expect((await route.POST(request('POST', subscription(), 'https://evil.example'))).status).toBe(403)
  expect((await route.POST(request('POST', { endpoint: 'http://127.0.0.1/private', keys: subscription().keys }))).status).toBe(400)
  expect((await route.POST(request('POST', { huge: 'x'.repeat(5000) }))).status).toBe(413)
  const sub = subscription()
  expect((await route.POST(request('POST', sub))).status).toBe(200)
  expect((await route.POST(request('POST', sub))).status).toBe(200)
  const response = await (await route.GET(request('GET'))).json()
  expect(response).toEqual({ publicKey: keys.publicKey, subscribed: true })
  expect((await route.DELETE(request('DELETE'))).status).toBe(200)
  expect((await (await route.GET(request('GET'))).json()).subscribed).toBe(false)
})

test('push delivery respects opt-in, retries each device once, removes expired endpoints and hides content', async () => {
  const a = subscription('success-' + randomUUID()), b = subscription('retry-' + randomUUID())
  await route.POST(request('POST', a)); await route.POST(request('POST', b))
  await db.sql`insert into notification_preferences (user_id, event_id, category, push_enabled) values (${account.id}, ${gathering.id}, 'event_announcements', true)`
  const [n] = await db.sql`insert into notifications (user_id, event_id, type, title, body, action_url) values (${account.id}, ${gathering.id}, 'admin_announcement', 'Private gathering name', 'Sensitive content', ${`/e/${gathering.slug}/dashboard`}) returning id`
  const payloads: string[] = []
  const delivered: string[] = []
  let fail = true
  const send: typeof webpush.sendNotification = async (sub, payload) => {
    payloads.push(String(payload)); delivered.push(sub.endpoint)
    if (sub.endpoint === b.endpoint && fail) throw Object.assign(new Error('retry'), { statusCode: 503 })
    return { statusCode: 201, body: '', headers: {} }
  }
  expect(await push.dispatchPush({ send })).toMatchObject({ sent: 1, failed: 1 })
  fail = false
  expect(await push.dispatchPush({ send })).toMatchObject({ sent: 1, failed: 0 })
  expect(await push.dispatchPush({ send })).toMatchObject({ sent: 0, failed: 0 })
  expect(delivered.filter(x => x === a.endpoint)).toHaveLength(1)
  expect(payloads.join('')).not.toContain('Sensitive content')
  expect(payloads.join('')).not.toContain('Private gathering name')
  expect(JSON.parse(payloads[0]).url).toBe(`/e/${gathering.slug}/dashboard`)
  await db.sql`update notification_preferences set push_enabled = false where user_id = ${account.id}`
  await db.sql`update push_deliveries set completed_at = null where notification_id = ${n.id}`
  expect(await push.dispatchPush({ send })).toMatchObject({ sent: 0 })
  await db.sql`update notification_preferences set push_enabled = true where user_id = ${account.id}`
  await db.sql`update push_deliveries set completed_at = null, attempts = 0 where notification_id = ${n.id}`
  expect(await push.dispatchPush({ send: async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }) } })).toMatchObject({ failed: 2 })
  const [remaining] = await db.sql`select count(*)::int n from push_subscriptions where user_id = ${account.id}`
  expect(remaining.n).toBe(0)
})

test('device credentials are server-only and cascade when a login session ends', async () => {
  const id = randomUUID()
  await db.sql`insert into at_sessions (id, did, user_id, kind, expires_at) values (${id}, ${account.did}, ${account.id}, 'custodial', now() + interval '1 hour')`
  const sub = subscription()
  await db.sql`insert into push_subscriptions (user_id, session_id, endpoint, p256dh, auth) values (${account.id}, ${id}, ${sub.endpoint}, ${sub.keys.p256dh}, ${sub.keys.auth})`
  await expect(db.asAccount(account.id, t => t`select endpoint from push_subscriptions`)).rejects.toThrow(/permission denied/)
  await db.sql`delete from at_sessions where id = ${id}`
  const [row] = await db.sql`select count(*)::int n from push_subscriptions where session_id = ${id}`
  expect(row.n).toBe(0)
})

test('desktop and mobile gathering surfaces fit and expose the organizer phase controls', async ({ browser }) => {
  const context = await browser.newContext()
  const [name, value] = account.cookie.split('=')
  await context.addCookies([{ name, value, url: base }])
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 960 })
    for (const [label, path] of [['home', 'dashboard'], ['admin', 'admin'], ['session', `sessions/${session}`], ['settings', 'admin/settings']] as const) {
      await page.goto(`${base}/e/${gathering.slug}/${path}`)
      await expect(page.getByText('We couldn’t load this page.')).not.toBeVisible()
      if (label === 'admin') await expect(page.getByRole('heading', { name: 'Your gathering, right now' })).toBeVisible()
      if (label === 'home') await expect(page.getByRole('heading', { name: 'Taking shape' })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} at ${width}`).toBe(true)
      if (label === 'session') await expect(page.getByText('No resources yet.', { exact: false })).toBeVisible()
      await page.screenshot({ path: `/tmp/unconference-polish-${label}-${width}.png`, fullPage: true })
    }
  }
  expect(errors).toEqual([])
  await context.close()
})
