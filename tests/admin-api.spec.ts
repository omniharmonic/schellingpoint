import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { createTestGathering, signInWithEmail, type TestGathering } from './helpers/gathering'
import { autoSchedule } from '../src/lib/scheduling/auto-scheduler'
import { overlapCoefficient } from '../src/lib/scheduling/clusters'

/**
 * Organizer admin (work package D) end to end against the running dev server (:3001), the local
 * Postgres and the local PDS (docs/ATPROTO_APPVIEW_PLAN.md §7.3). The dev server must run without
 * a mail key so the email door hands back `devVerifyUrl`.
 *
 * Covers: organizer-only enforcement on every admin route; sealed results while a round is open
 * (on a second gathering of this file's own) and results after close; the R9 rule that an organizer-listed speaker name is
 * stored organizer-only and never reaches the sessions API or a published record; review
 * notifications; and the approval flow for moving a session that is already published.
 *
 * Everything created here (accounts and their PDS repos, events, rounds) is removed afterwards.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.ADMIN_TEST_BASE_URL || 'http://localhost:3001'
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(ownerUrl && process.env.DATABASE_URL && pdsUrl && pdsAdminPassword)
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(ownerUrl).hostname)
  } catch {
    return false
  }
})()

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const EMAIL = (who: string) => `pkgd+${who}-${RUN}@example.test`
const ORIGIN = { origin: base }
const adminAuth = `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`
const LISTED_NAME = `Alice Listedspeaker ${RUN}`
const FAKE_GATHERING_DID = `did:plc:pkgdgathering${RUN.replace(/[^a-z0-9]/g, '').slice(0, 10)}`

interface Account { email: string; cookie: string; id: string; did: string }

async function signIn(sql: postgres.Sql, who: string): Promise<Account> {
  const email = EMAIL(who)
  const cookie = await signInWithEmail(email, base)
  const [row] = await sql<{ id: string; did: string }[]>`select id, did from accounts where email = ${email}`
  return { email, cookie: cookie!, id: row.id, did: row.did }
}

async function api(path: string, init: { method?: string; cookie?: string; json?: unknown; origin?: string | null } = {}) {
  const headers: Record<string, string> = {}
  if (init.origin !== null) headers.origin = init.origin ?? base
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, text }
}

/** Every key anywhere in a JSON value. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      allKeys(v, out)
    }
  }
  return out
}

const VOTE_KEYS = ['votes', 'voters', 'credits', 'total_votes', 'total_credits', 'voter_count', 'results']

function expectNoVoteNumbers(body: unknown, allowNullResults = false) {
  const keys = allKeys(body)
  for (const key of VOTE_KEYS) {
    if (key === 'results' && allowNullResults) continue
    expect(keys.has(key), `response must not carry "${key}" while voting is open`).toBe(false)
  }
}

test('the auto-scheduler separates sessions with overlapping ballot tokens and honours host blackouts', async () => {
  // One overlap metric everywhere: the k-filtered overlap coefficient from clusters.ts.
  const shared = new Set(['aa', 'bb', 'cc', 'dd'])
  expect(overlapCoefficient(shared, new Set(['aa', 'bb', 'cc', 'dd'])).coefficient).toBe(1)
  expect(overlapCoefficient(shared, new Set(['ee'])).coefficient).toBe(0)

  const session = (id: string, extra: Record<string, unknown> = {}) => ({
    id, title: id, duration: 60, expected_attendance: 10, status: 'approved' as const, time_slot_id: null,
    track_id: null, time_preferences: null, required_features: null, ...extra,
  })
  const at = (h: number) => `2030-06-01T${String(h).padStart(2, '0')}:00:00.000Z`
  const slot = (id: string, venue: string, h: number) => ({ id, venue_id: venue, day_date: '2030-06-01', start_time: at(h), end_time: at(h + 1), is_break: false })
  const venues = [
    { id: 'v1', name: 'One', capacity: 50, is_primary: true, features: null },
    { id: 'v2', name: 'Two', capacity: 50, is_primary: false, features: null },
  ]
  const slots = [slot('s1-9', 'v1', 16), slot('s2-9', 'v2', 16), slot('s1-10', 'v1', 17)]
  const ballots = new Map([
    ['A', { votes: 9, tokens: shared }],
    ['B', { votes: 8, tokens: new Set(['aa', 'bb', 'cc']) }],
  ])
  const result = autoSchedule([session('A'), session('B')], slots, venues, { ballots, timezone: 'UTC' })
  const slotOf = Object.fromEntries(result.assignments.map((a) => [a.sessionId, a.slotId]))
  const startOf = (id: string) => slots.find((s) => s.id === id)!.start_time
  expect(result.stats.usedBallots).toBe(true)
  expect(startOf(slotOf.A), 'voters of A and B overlap: not at the same time').not.toBe(startOf(slotOf.B))

  const blackout = autoSchedule(
    [session('C', { blackouts: [{ startsAt: at(16), endsAt: at(17) }] })],
    slots,
    venues,
    { timezone: 'UTC' },
  )
  expect(blackout.assignments[0].slotId).toBe('s1-10')
})

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('organizer admin API (package D)', () => {
  test.skip(!configured || !isLocal, 'Needs the local stack: DATABASE_URL / DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD (plan §7.3)')

  let sql: postgres.Sql
  let owner: Account
  let colleague: Account
  let attendee: Account
  let stranger: Account
  let eventId = ''
  let eventSlug = ''
  let privateSlug = ''
  let privateSessionId = ''
  let voteGathering: TestGathering | null = null
  let trackName = ''
  let venueId = ''
  const slotIds: string[] = []

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    sql = postgres(ownerUrl, { max: 3, onnotice: () => {} })
    owner = await signIn(sql, 'owner')
    colleague = await signIn(sql, 'colleague')
    attendee = await signIn(sql, 'attendee')
    stranger = await signIn(sql, 'stranger')

    eventSlug = `pkgd-${RUN}`
    const [event] = await sql<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, visibility, timezone, require_proposal_approval,
                          allowed_formats, allowed_durations)
      values (${eventSlug}, 'Package D gathering', current_date + 10, current_date + 11, 'proposals_open', 'public',
              'America/Denver', true, array['talk','workshop','discussion'], array[30, 60])
      returning id
    `
    eventId = event.id
    await sql`
      insert into event_members (event_id, user_id, role)
      values (${eventId}, ${owner.id}, 'owner'), (${eventId}, ${colleague.id}, 'moderator'), (${eventId}, ${attendee.id}, 'attendee')
    `
    trackName = `Soil ${RUN}`
    await sql`insert into tracks (event_id, name, slug, color) values (${eventId}, ${trackName}, ${`soil-${RUN}`}, '#228833')`

    privateSlug = `pkgd-private-${RUN}`
    const [priv] = await sql<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, visibility, timezone)
      values (${privateSlug}, 'Package D private', current_date + 10, current_date + 10, 'proposals_open', 'private', 'America/Denver')
      returning id
    `
    await sql`insert into event_members (event_id, user_id, role) values (${priv.id}, ${owner.id}, 'owner')`
    await sql.begin(async (t) => {
      await t`select set_config('session_replication_role', 'replica', true)`
      const [s] = await t<{ id: string }[]>`
        insert into sessions (event_id, title, format, duration, status, session_type)
        values (${priv.id}, 'Private curated', 'talk', 60, 'approved', 'curated') returning id
      `
      privateSessionId = s.id
    })

    // A second public gathering, taking proposals, whose voting round this file opens.
    voteGathering = await createTestGathering(sql, { tag: 'admin-vote', status: 'proposals_open', withProgram: true })
    for (const [account, role] of [[owner, 'owner'], [attendee, 'attendee']] as const) {
      await sql`insert into event_members (event_id, user_id, role) values (${voteGathering.id}, ${account.id}, ${role})`
    }
  })

  test.afterAll(async () => {
    if (!sql) return
    await voteGathering?.cleanup()
    await sql`delete from events where slug in ${sql([eventSlug, privateSlug])}`
    const accounts = await sql<{ did: string; id: string }[]>`select did, id from accounts where email like ${`pkgd+%-${RUN}@example.test`}`
    for (const a of accounts) {
      await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: adminAuth },
        body: JSON.stringify({ did: a.did }),
      })
    }
    if (accounts.length) await sql`delete from accounts where id in ${sql(accounts.map((a) => a.id))}`
    await sql`delete from auth_email_tokens where email like ${`pkgd+%-${RUN}@example.test`}`
    await sql.end({ timeout: 5 })
  })

  test('every admin route is organizer-only: attendee 403, anonymous 401, stranger 404 on a private gathering', async () => {
    // ~110 requests over ~20 route files; against `next dev` each file compiles on its first hit,
    // which on a loaded machine can take tens of seconds per route.
    test.setTimeout(600_000)
    const fake = '00000000-0000-4000-8000-000000000000'
    const routes: Array<{ method: string; path: (slug: string) => string; json?: unknown }> = [
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/overview` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/overview/analytics` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/sessions` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/sessions`, json: { title: 'x' } },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/sessions/import`, json: { rows: [{ title: 'x' }] } },
      { method: 'PUT', path: (s) => `/api/v1/events/${s}/admin/sessions/${fake}/schedule`, json: { time_slot_id: fake } },
      { method: 'DELETE', path: (s) => `/api/v1/events/${s}/admin/sessions/${fake}/schedule` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/venues` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/venues`, json: { name: 'x' } },
      { method: 'PATCH', path: (s) => `/api/v1/events/${s}/admin/venues/${fake}`, json: { name: 'x' } },
      { method: 'DELETE', path: (s) => `/api/v1/events/${s}/admin/venues/${fake}` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/time-slots` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/time-slots`, json: { slots: [] } },
      { method: 'PATCH', path: (s) => `/api/v1/events/${s}/admin/time-slots/${fake}`, json: {} },
      { method: 'DELETE', path: (s) => `/api/v1/events/${s}/admin/time-slots/${fake}` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/tracks` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/tracks`, json: { name: 'x' } },
      { method: 'PUT', path: (s) => `/api/v1/events/${s}/admin/tracks`, json: { order: [] } },
      { method: 'PATCH', path: (s) => `/api/v1/events/${s}/admin/tracks/${fake}`, json: { name: 'x' } },
      { method: 'DELETE', path: (s) => `/api/v1/events/${s}/admin/tracks/${fake}` },
      { method: 'PATCH', path: (s) => `/api/v1/events/${s}/sessions/batch`, json: { action: 'approve', session_ids: [fake] } },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/publish-schedule` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/publish-schedule` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/auto-schedule` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/auto-schedule`, json: { assignments: [{ sessionId: fake, slotId: fake }] } },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/broadcast` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/broadcast`, json: { title: 'x', message: 'y' } },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/admin/session-emails` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/session-emails`, json: { action: 'notify-scheduled-hosts' } },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/admin/seed-sessions` },
      { method: 'DELETE', path: (s) => `/api/v1/events/${s}/admin/seed-sessions` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/members` },
      { method: 'PATCH', path: (s) => `/api/v1/events/${s}/members/${fake}`, json: { role: 'admin' } },
      { method: 'DELETE', path: (s) => `/api/v1/events/${s}/members/${fake}` },
      { method: 'GET', path: (s) => `/api/v1/events/${s}/invitations` },
      { method: 'POST', path: (s) => `/api/v1/events/${s}/invitations`, json: { role: 'attendee' } },
      { method: 'DELETE', path: (s) => `/api/v1/events/${s}/invitations/${fake}` },
    ]
    for (const route of routes) {
      const label = `${route.method} ${route.path(':slug')}`
      const asAttendee = await api(route.path(eventSlug), { method: route.method, cookie: attendee.cookie, json: route.json })
      expect(asAttendee.status, `${label} as attendee: ${asAttendee.text}`).toBe(403)
      const anonymous = await api(route.path(eventSlug), { method: route.method, json: route.json })
      expect(anonymous.status, `${label} anonymous`).toBe(401)
      const asStranger = await api(route.path(privateSlug), { method: route.method, cookie: stranger.cookie, json: route.json })
      expect(asStranger.status, `${label} on a private gathering as a stranger`).toBe(404)
    }

    // The moderator may review and read, but not manage rooms or the schedule.
    expect((await api(`/api/v1/events/${eventSlug}/admin/overview`, { cookie: colleague.cookie })).status).toBe(200)
    expect((await api(`/api/v1/events/${eventSlug}/admin/venues`, { method: 'POST', cookie: colleague.cookie, json: { name: 'Nope' } })).status).toBe(403)
    expect((await api(`/api/v1/events/${eventSlug}/admin/publish-schedule`, { method: 'POST', cookie: colleague.cookie })).status).toBe(403)

    // Session-scoped route: notify-host resolves the session's event first.
    expect((await api(`/api/sessions/${privateSessionId}/notify-host`, { method: 'POST', cookie: stranger.cookie })).status).toBe(404)

    // Cross-origin mutations are refused even for the owner.
    const cross = await api(`/api/v1/events/${eventSlug}/admin/venues`, { method: 'POST', cookie: owner.cookie, json: { name: 'Evil' }, origin: 'https://evil.example' })
    expect(cross.status).toBe(403)
  })

  test('rooms and time slots: overlap is refused and a bulk save is all-or-nothing', async () => {
    const created = await api(`/api/v1/events/${eventSlug}/admin/venues`, {
      method: 'POST',
      cookie: owner.cookie,
      json: { name: 'Main Hall', capacity: 80, features: ['projector'], locality: 'Boulder', country: 'us', is_private_residence: false },
    })
    expect(created.status, created.text).toBe(201)
    venueId = created.body.venue.id
    expect(created.body.venue.country).toBe('US')

    const [{ day }] = await sql<{ day: string }[]>`select to_char(start_date, 'YYYY-MM-DD') as day from events where id = ${eventId}`
    const slots = await api(`/api/v1/events/${eventSlug}/admin/time-slots`, {
      method: 'POST',
      cookie: owner.cookie,
      json: {
        slots: [
          { venue_id: venueId, day_date: day, start: '09:00', end: '10:00' },
          { venue_id: venueId, day_date: day, start: '10:00', end: '11:00' },
          { venue_id: venueId, day_date: day, start: '11:00', end: '11:30', slot_type: 'break' },
        ],
      },
    })
    expect(slots.status, slots.text).toBe(201)
    expect(slots.body.timeSlots).toHaveLength(3)
    for (const s of slots.body.timeSlots) if (!s.is_break) slotIds.push(s.id)
    // 09:00 America/Denver is stored as an instant in that zone, not in UTC.
    const nine = slots.body.timeSlots.find((s: { start_time: string }) => new Date(s.start_time).toLocaleTimeString('en-US', { timeZone: 'America/Denver', hour: '2-digit', minute: '2-digit', hour12: false }) === '09:00')
    expect(nine).toBeTruthy()

    const before = await sql<{ n: number }[]>`select count(*)::int as n from time_slots where event_id = ${eventId}`
    const overlapping = await api(`/api/v1/events/${eventSlug}/admin/time-slots`, {
      method: 'POST',
      cookie: owner.cookie,
      json: {
        slots: [
          { venue_id: venueId, day_date: day, start: '13:00', end: '14:00' },
          { venue_id: venueId, day_date: day, start: '09:30', end: '10:30' },
        ],
      },
    })
    expect(overlapping.status).toBe(409)
    expect(overlapping.body.code).toBe('SlotOverlap')
    const after = await sql<{ n: number }[]>`select count(*)::int as n from time_slots where event_id = ${eventId}`
    expect(after[0].n, 'the non-overlapping slot of a refused batch is not saved').toBe(before[0].n)

    const outside = await api(`/api/v1/events/${eventSlug}/admin/time-slots`, {
      method: 'POST',
      cookie: owner.cookie,
      json: { venue_id: venueId, day_date: '2001-01-01', start: '09:00', end: '10:00' },
    })
    expect(outside.status).toBe(400)
  })

  test('overview, analytics and the session list carry no vote numbers while a round is open', async () => {
    const vote = voteGathering!
    await sql`
      insert into vote_rounds (event_id, phase, mechanism, credits, opens_at, closes_at)
      values (${vote.id}, 'pre-event', 'quadratic', 100, now() - interval '1 hour', now() + interval '2 days')
    `

    const overview = await api(`/api/v1/events/${vote.slug}/admin/overview`, { cookie: owner.cookie })
    expect(overview.status, overview.text).toBe(200)
    expect(overview.body.voting.status).toBe('open')
    expectNoVoteNumbers(overview.body)

    const analytics = await api(`/api/v1/events/${vote.slug}/admin/overview/analytics`, { cookie: owner.cookie })
    expect(analytics.status, analytics.text).toBe(200)
    expect(analytics.body.voting.sealed).toBe(true)
    expect(analytics.body.voting.message).toBe('Voting in progress — results are sealed until the round closes.')
    expectNoVoteNumbers(analytics.body)

    const sessions = await api(`/api/v1/events/${vote.slug}/admin/sessions`, { cookie: owner.cookie })
    expect(sessions.status, sessions.text).toBe(200)
    expect(sessions.body.results).toBeNull()
    expectNoVoteNumbers(sessions.body, true)

    const auto = await api(`/api/v1/events/${vote.slug}/admin/auto-schedule`, { cookie: owner.cookie })
    expect(auto.status).toBe(409)
    expect(auto.body.code).toBe('RoundOpen')
    expect(auto.body.error).toMatch(/Voting is still open/)
  })

  test('CSV import stores a named external speaker organizer-only; the sessions API and published records never contain it', async () => {
    const imported = await api(`/api/v1/events/${eventSlug}/admin/sessions/import`, {
      method: 'POST',
      cookie: owner.cookie,
      json: {
        rows: [
          { title: `Soil stories ${RUN}`, description: 'Curated talk', host_name: LISTED_NAME, format: 'Talk', duration: 60, track: trackName },
          { title: '', host_name: 'Nobody' },
          { title: `Unknown track ${RUN}`, track: 'Does not exist' },
        ],
      },
    })
    expect(imported.status, imported.text).toBe(201)
    expect(imported.body.created).toBe(1)
    expect(imported.body.failed).toBe(2)
    const sessionId: string = imported.body.results.find((r: { ok: boolean }) => r.ok).id

    const [row] = await sql<{ host_id: string | null; host_name: string | null; status: string; session_type: string; listed: string | null }[]>`
      select s.host_id, s.host_name, s.status, s.session_type, l.host_name as listed
      from sessions s left join session_host_listings l on l.session_id = s.id
      where s.id = ${sessionId}
    `
    expect(row.host_id).toBeNull()
    expect(row.host_name, 'sessions.host_name stays empty').toBeNull()
    expect(row.listed).toBe(LISTED_NAME)
    expect(row.session_type).toBe('curated')

    const adminList = await api(`/api/v1/events/${eventSlug}/admin/sessions`, { cookie: owner.cookie })
    expect(adminList.body.sessions.find((s: { id: string }) => s.id === sessionId).listed_host_name).toBe(LISTED_NAME)

    // Package B's session APIs, as an attendee and anonymously.
    for (const cookie of [attendee.cookie, undefined]) {
      const list = await api(`/api/v1/events/${eventSlug}/sessions`, { cookie })
      expect(list.status, list.text).toBe(200)
      expect(list.text).not.toContain(LISTED_NAME)
      const one = await api(`/api/v1/events/${eventSlug}/sessions/${sessionId}`, { cookie })
      expect(one.status, one.text).toBe(200)
      expect(one.text).not.toContain(LISTED_NAME)
    }

    // Schedule it and publish through package F's pipeline with a fake PDS: nothing written names the speaker.
    const placed = await api(`/api/v1/events/${eventSlug}/admin/sessions/${sessionId}/schedule`, {
      method: 'PUT',
      cookie: owner.cookie,
      json: { time_slot_id: slotIds[0] },
    })
    expect(placed.status, placed.text).toBe(200)
    expect(placed.body.status).toBe('applied')

    const originalResolve = (Module as unknown as { _resolveFilename: (r: string, ...rest: unknown[]) => string })._resolveFilename
    const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
    ;(Module as unknown as { _resolveFilename: (r: string, ...rest: unknown[]) => string })._resolveFilename = function (request: string, ...rest: unknown[]) {
      return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const publish = require('../src/lib/atproto/publish') as typeof import('../src/lib/atproto/publish')
      const written: unknown[] = []
      const store = new Map<string, { cid: string; value: Record<string, unknown> }>()
      let n = 0
      const deps: import('../src/lib/atproto/publish').PublishDeps = {
        put: async (input) => {
          written.push(input.record)
          const uri = `at://${FAKE_GATHERING_DID}/${input.collection}/${input.rkey}`
          const cid = `bafyreipkgd${(n++).toString().padStart(4, '0')}${'a'.repeat(40)}`
          store.set(uri, { cid, value: input.record as Record<string, unknown> })
          return { uri, cid, auditId: 'audit-fake' }
        },
        del: async () => ({ auditId: 'audit-fake' }),
        getRecord: async <T,>(repo: string, collection: string, rkey: string) => {
          const hit = store.get(`at://${repo}/${collection}/${rkey}`)
          return hit ? { uri: `at://${repo}/${collection}/${rkey}`, cid: hit.cid, value: hit.value as T } : null
        },
        actorDidFor: async () => FAKE_GATHERING_DID,
        indexedCid: async () => null,
        persist: false,
      }
      const { results } = await publish.publishSchedule({ eventId, callerUserId: owner.id, sessionIds: [sessionId] }, deps)
      expect(written.length, JSON.stringify(results)).toBeGreaterThan(0)
      expect(JSON.stringify(written)).not.toContain(LISTED_NAME)
      expect(JSON.stringify(written)).not.toContain('Listedspeaker')
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      await (require('../src/lib/db') as typeof import('../src/lib/db')).sql.end({ timeout: 5 }).catch(() => {})
    } finally {
      ;(Module as unknown as { _resolveFilename: (r: string, ...rest: unknown[]) => string })._resolveFilename = originalResolve
    }

    // A single curated session with a speaker is host-less too.
    const single = await api(`/api/v1/events/${eventSlug}/admin/sessions`, {
      method: 'POST',
      cookie: owner.cookie,
      json: { title: `Single ${RUN}`, host_name: LISTED_NAME, format: 'workshop', duration: 60, status: 'approved' },
    })
    expect(single.status, single.text).toBe(201)
    const [singleRow] = await sql<{ host_id: string | null; host_name: string | null }[]>`select host_id, host_name from sessions where id = ${single.body.id}`
    expect(singleRow).toEqual({ host_id: null, host_name: null })
  })

  test('batch review writes session_approved / session_rejected notifications to the host, as the organizer', async () => {
    const inserted = await sql<{ id: string; status: string }[]>`
      insert into sessions (event_id, title, format, duration, host_id)
      values (${eventId}, ${`Proposal A ${RUN}`}, 'talk', 60, ${attendee.id}),
             (${eventId}, ${`Proposal B ${RUN}`}, 'talk', 60, ${attendee.id}),
             (${eventId}, ${`Proposal C ${RUN}`}, 'discussion', 30, ${attendee.id})
      returning id, status
    `
    expect(inserted.every((s) => s.status === 'pending')).toBe(true)
    const [a, b, c] = inserted.map((s) => s.id)

    // The moderator approves two; the database guard runs as their account.
    const approved = await api(`/api/v1/events/${eventSlug}/sessions/batch`, {
      method: 'PATCH',
      cookie: colleague.cookie,
      json: { action: 'approve', session_ids: [a, b] },
    })
    expect(approved.status, approved.text).toBe(200)
    expect(approved.body.affected).toBe(2)
    const approvals = await sql<{ session_id: string; user_id: string; action_url: string }[]>`
      select data->>'session_id' as session_id, user_id, action_url from notifications
      where event_id = ${eventId} and type = 'session_approved'
    `
    expect(approvals.map((n) => n.session_id).sort()).toEqual([a, b].sort())
    expect(approvals.every((n) => n.user_id === attendee.id)).toBe(true)
    expect(approvals.every((n) => n.action_url.startsWith(`/e/${eventSlug}/sessions/`))).toBe(true)

    // Approving again changes nothing and notifies nobody.
    const again = await api(`/api/v1/events/${eventSlug}/sessions/batch`, { method: 'PATCH', cookie: owner.cookie, json: { action: 'approve', session_ids: [a] } })
    expect(again.body.affected).toBe(0)
    expect(again.body.skipped).toHaveLength(1)

    const rejected = await api(`/api/v1/events/${eventSlug}/sessions/batch`, {
      method: 'PATCH',
      cookie: owner.cookie,
      json: { action: 'reject', session_ids: [c], reason: 'Out of scope this year' },
    })
    expect(rejected.status, rejected.text).toBe(200)
    const [rej] = await sql<{ body: string; user_id: string; reason: string }[]>`
      select body, user_id, data->>'rejection_reason' as reason from notifications
      where event_id = ${eventId} and type = 'session_rejected' and data->>'session_id' = ${c}
    `
    expect(rej.user_id).toBe(attendee.id)
    expect(rej.body).toContain('Out of scope this year')
    const [{ rejection_reason }] = await sql<{ rejection_reason: string }[]>`select rejection_reason from sessions where id = ${c}`
    expect(rejection_reason).toBe('Out of scope this year')

    // Sessions of another event are refused.
    const foreign = await api(`/api/v1/events/${eventSlug}/sessions/batch`, { method: 'PATCH', cookie: owner.cookie, json: { action: 'approve', session_ids: [privateSessionId] } })
    expect(foreign.status).toBe(400)

    // Moderators cannot delete.
    const del = await api(`/api/v1/events/${eventSlug}/sessions/batch`, { method: 'PATCH', cookie: colleague.cookie, json: { action: 'delete', session_ids: [c] } })
    expect(del.status).toBe(403)

    // Placing an approved session tells its host.
    const placed = await api(`/api/v1/events/${eventSlug}/admin/sessions/${a}/schedule`, { method: 'PUT', cookie: owner.cookie, json: { time_slot_id: slotIds[1] } })
    expect(placed.status, placed.text).toBe(200)
    const [scheduled] = await sql<{ n: number }[]>`
      select count(*)::int as n from notifications where type = 'session_scheduled' and user_id = ${attendee.id} and data->>'session_id' = ${a}
    `
    expect(scheduled.n).toBe(1)

    // Publishing stamps the event and tells every member.
    const published = await api(`/api/v1/events/${eventSlug}/admin/publish-schedule`, { method: 'POST', cookie: owner.cookie })
    expect(published.status, published.text).toBe(200)
    expect(published.body.changes.added).toBe(2)
    const [{ n: live }] = await sql<{ n: number }[]>`select count(*)::int as n from notifications where event_id = ${eventId} and type = 'schedule_published'`
    expect(live).toBe(3)
    const status = await api(`/api/v1/events/${eventSlug}/admin/publish-schedule`, { cookie: owner.cookie })
    expect(status.body.hasUnpublishedChanges).toBe(false)
  })

  test('results and the ballot-token scheduler appear only after the round closes', async () => {
    const [session] = await sql<{ id: string }[]>`
      select id from sessions where event_id = ${eventId} and status = 'approved' and time_slot_id is null limit 1
    `
    expect(session).toBeTruthy()
    const [round] = await sql<{ id: string }[]>`
      insert into vote_rounds (event_id, phase, mechanism, credits, opens_at, closes_at, ballot_key, finalized_at)
      values (${eventId}, 'pre-event', 'quadratic', 100, now() - interval '3 days', now() - interval '1 day', null, now() - interval '1 day')
      returning id
    `
    const tokens = [randomBytes(32), randomBytes(32), randomBytes(32)]
    for (const token of tokens) {
      await sql`insert into vote_ballots (round_id, event_id, token, cast_at) values (${round.id}, ${eventId}, ${token}, now() - interval '1 day')`
      await sql`
        insert into vote_entries (round_id, event_id, session_id, votes, credits, day, ballot_token)
        values (${round.id}, ${eventId}, ${session.id}, 2, 4, current_date - 1, ${token})
      `
    }
    await sql`
      insert into vote_round_results (round_id, event_id, session_id, voters, votes, credits)
      values (${round.id}, ${eventId}, ${session.id}, 3, 6, 12)
    `

    const analytics = await api(`/api/v1/events/${eventSlug}/admin/overview/analytics`, { cookie: owner.cookie })
    expect(analytics.status, analytics.text).toBe(200)
    expect(analytics.body.voting.sealed).toBe(false)
    expect(analytics.body.voting.results).toContainEqual(expect.objectContaining({ sessionId: session.id, voters: 3, votes: 6, credits: 12 }))

    const list = await api(`/api/v1/events/${eventSlug}/admin/sessions`, { cookie: owner.cookie })
    expect(list.body.results[session.id]).toEqual({ voters: 3, votes: 6, credits: 12 })

    const overview = await api(`/api/v1/events/${eventSlug}/admin/overview`, { cookie: owner.cookie })
    expectNoVoteNumbers(overview.body)

    const preview = await api(`/api/v1/events/${eventSlug}/admin/auto-schedule`, { cookie: owner.cookie })
    expect(preview.status, preview.text).toBe(200)
    expect(preview.body.stats.usedBallots).toBe(true)
    expect(preview.text, 'the preview never exposes ballot tokens').not.toContain(tokens[0].toString('hex'))

    // The analytics view is organizer-only even after close.
    expect((await api(`/api/v1/events/${eventSlug}/admin/overview/analytics`, { cookie: attendee.cookie })).status).toBe(403)
  })

  test('moving a published session with a two-steward policy answers awaiting_approval and leaves it in place', async () => {
    test.setTimeout(120_000)
    const [session] = await sql<{ id: string; time_slot_id: string }[]>`
      select id, time_slot_id from sessions where event_id = ${eventId} and status = 'scheduled' and host_id is not null limit 1
    `
    expect(session, 'a scheduled session from the previous test').toBeTruthy()
    await sql`
      update events set actor_did = ${FAKE_GATHERING_DID},
        policy_thresholds = '{"destructiveActionStewards": 2, "feedbackK": 3, "publishRoles": false}'::jsonb
      where id = ${eventId}
    `
    await sql`
      update sessions set
        calendar_event_uri = ${`at://${FAKE_GATHERING_DID}/community.lexicon.calendar.event/pkgd${RUN}`},
        calendar_event_cid = 'bafyreipkgdcalendar',
        slot_uri = ${`at://${FAKE_GATHERING_DID}/schellingpoint.draft.slot/pkgd${RUN}`},
        slot_cid = 'bafyreipkgdslot',
        proposal_uri = ${`at://${attendee.did}/schellingpoint.draft.proposal/pkgd${RUN}`},
        proposal_cid = 'bafyreipkgdproposal'
      where id = ${session.id}
    `
    const [{ day }] = await sql<{ day: string }[]>`select to_char(start_date, 'YYYY-MM-DD') as day from events where id = ${eventId}`
    const extra = await api(`/api/v1/events/${eventSlug}/admin/time-slots`, {
      method: 'POST',
      cookie: owner.cookie,
      json: { venue_id: venueId, day_date: day, start: '15:00', end: '16:00' },
    })
    expect(extra.status, extra.text).toBe(201)
    const target: string = extra.body.timeSlots[0].id

    // The organizer must say why.
    const noReason = await api(`/api/v1/events/${eventSlug}/admin/sessions/${session.id}/schedule`, { method: 'PUT', cookie: owner.cookie, json: { time_slot_id: target } })
    expect(noReason.status).toBe(400)
    expect(noReason.body.code).toBe('ReasonRequired')

    const moved = await api(`/api/v1/events/${eventSlug}/admin/sessions/${session.id}/schedule`, {
      method: 'PUT',
      cookie: owner.cookie,
      json: { time_slot_id: target, reason: 'The speaker has a clash' },
    })
    expect(moved.status, moved.text).toBe(202)
    expect(moved.body.status).toBe('awaiting_approval')
    expect(moved.body.approvalsNeeded).toBe(1)

    const [row] = await sql<{ time_slot_id: string }[]>`select time_slot_id from sessions where id = ${session.id}`
    expect(row.time_slot_id, 'the app row does not move until the move is approved').toBe(session.time_slot_id)

    const requests = await api(`/api/v1/events/${eventSlug}/approvals`, { cookie: owner.cookie })
    expect(requests.status, requests.text).toBe(200)
    expect(requests.body.requests).toContainEqual(expect.objectContaining({ sessionId: session.id, action: 'move', status: 'pending' }))

    // Deleting a published session is refused; so is quietly unscheduling it by editing its slot.
    const del = await api(`/api/v1/events/${eventSlug}/sessions/batch`, { method: 'PATCH', cookie: owner.cookie, json: { action: 'delete', session_ids: [session.id] } })
    expect(del.body.affected).toBe(0)
    const slotEdit = await api(`/api/v1/events/${eventSlug}/admin/time-slots/${session.time_slot_id}`, {
      method: 'PATCH',
      cookie: owner.cookie,
      json: { venue_id: venueId, day_date: day, start: '16:00', end: '17:00', confirm_assigned: true },
    })
    expect(slotEdit.status).toBe(409)
    expect(slotEdit.body.code).toBe('PublishedSessions')
  })
})
