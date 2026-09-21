import { test, expect, type APIRequestContext } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'
import {
  audienceClusters,
  fineTogetherSets,
  keepApartPairs,
  overlapCoefficient,
  overlapMatrix,
} from '../src/lib/scheduling/clusters'
import { buildObjectiveContext, placementCost, type Placement } from '../src/lib/scheduling/objective'
import { hillClimb } from '../src/lib/scheduling/improve'
import { qualityScore } from '../src/lib/scheduling/quality'
import {
  autoSchedule,
  SCHEDULER_STAGE_NAMES,
  type BallotInputs,
  type SchedulerSession,
  type SchedulerTimeSlot,
  type SchedulerVenue,
} from '../src/lib/scheduling/auto-scheduler'

// Cluster-aware scheduling (release design §9): the pure library, then the organizer routes
// against the local stack and the dev server on :3001. The API part creates its own gathering,
// accounts and a closed round with hand-made ballot tokens; everything is removed in afterAll.
loadEnvConfig(process.cwd(), true)

/* ───────────────────────────── pure fixtures ───────────────────────────── */

const TZ = 'America/Denver'
const DAY = '2030-06-01'
const iso = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`

const VENUES: SchedulerVenue[] = [
  { id: 'main', name: 'Main Hall', capacity: 100, is_primary: true, features: ['projector'] },
  { id: 'small', name: 'Breakout', capacity: 20, is_primary: false, features: [] },
]
const ROWS = [
  ['15:00', '16:00'],
  ['16:15', '17:15'],
  ['17:30', '18:30'],
]
const SLOTS: SchedulerTimeSlot[] = ROWS.flatMap(([start, end], r) =>
  VENUES.map((v) => ({ id: `r${r + 1}-${v.id}`, start_time: iso(start), end_time: iso(end), is_break: false, venue_id: v.id, day_date: DAY, label: `Row ${r + 1}` })),
)
const session = (id: string, extra: Partial<SchedulerSession> = {}): SchedulerSession => ({
  id,
  title: `Session ${id.toUpperCase()}`,
  duration: 60,
  expected_attendance: null,
  status: 'approved',
  time_slot_id: null,
  track_id: null,
  time_preferences: null,
  required_features: null,
  format: 'talk',
  ...extra,
})
const tokens = (...names: string[]) => new Set(names)
const ballotsOf = (entries: Record<string, string[]>): BallotInputs =>
  new Map(Object.entries(entries).map(([id, t]) => [id, { votes: t.length, tokens: tokens(...t) }]))
const P = (slotId: string, venueId: string): Placement => ({ slotId, venueId })

const V = ['v1', 'v2', 'v3', 'v4', 'v5']
const W = ['w1', 'w2', 'w3', 'w4', 'w5']
// a and b share every voter; c is disjoint from both; d has too few voters to compare (k = 3).
const BALLOTS = ballotsOf({ a: V, b: V, c: W, d: ['v1', 'v2'] })

test.describe('scheduling library', () => {
  test('overlap coefficient is |A∩B| / min(|A|,|B|) with the shared count kept', () => {
    expect(overlapCoefficient(tokens('1', '2', '3', '4', '5'), tokens('1', '2', '3', '9', '10', '11', '12', '13', '14', '15'))).toEqual({ shared: 3, coefficient: 0.6 })
    expect(overlapCoefficient(tokens('1'), tokens())).toEqual({ shared: 0, coefficient: 0 })
    expect(overlapCoefficient(tokens('x', 'y'), tokens('x', 'y'))).toEqual({ shared: 2, coefficient: 1 })
  })

  test('k-suppression: pairs with fewer than k voters on a side are neither shown nor constrained', () => {
    const matrix = overlapMatrix(BALLOTS, 3)
    expect(matrix.comparableSessions).toEqual(['a', 'b', 'c'])
    expect(matrix.pairs.map((p) => `${p.a}|${p.b}`)).toEqual(['a|b', 'a|c', 'b|c'])
    expect(matrix.suppressedCount).toBe(3) // d against each of a, b, c
    expect(matrix.suppressedSessions).toBe(1)

    // With k above every voter count nothing is comparable and nothing is constrained.
    const strict = overlapMatrix(BALLOTS, 6)
    expect(strict.pairs).toEqual([])
    expect(strict.suppressedCount).toBe(6)
    const ctx = buildObjectiveContext([session('a'), session('b')], SLOTS, VENUES, { ballots: BALLOTS, k: 6, timezone: TZ })
    const concurrent = new Map([['a', P('r1-main', 'main')], ['b', P('r1-small', 'small')]])
    expect(placementCost(concurrent, ctx).conflict).toBe(0)
    expect(audienceClusters(BALLOTS, 6).keepApart).toEqual([])
  })

  test('keep-apart pairs and fine-together sets', () => {
    const matrix = overlapMatrix(BALLOTS, 3)
    expect(keepApartPairs(matrix)).toEqual([{ a: 'a', b: 'b', shared: 5, coefficient: 1 }])
    expect(fineTogetherSets(matrix, BALLOTS)).toEqual([{ sessionIds: ['a', 'c'], maxCoefficient: 0 }])
    const clusters = audienceClusters(BALLOTS, 3)
    expect(clusters).toMatchObject({ k: 3, comparableSessions: 3, suppressedCount: 3, suppressedSessions: 1 })
    // Counts and ratios only: no token ever appears in the cluster view.
    const blob = JSON.stringify(clusters)
    for (const t of [...V, ...W]) expect(blob).not.toContain(`"${t}"`)
    expect(blob).not.toContain('tokens')
  })

  test('placement cost: weighted conflicts, capacity, constraint violations, imbalance', () => {
    const sessions = [session('a'), session('b'), session('c')]
    const ctx = buildObjectiveContext(sessions, SLOTS, VENUES, { ballots: BALLOTS, k: 3, timezone: TZ })

    const together = new Map([['a', P('r1-main', 'main')], ['b', P('r1-small', 'small')], ['c', P('r2-main', 'main')]])
    const apart = new Map([['a', P('r1-main', 'main')], ['b', P('r2-small', 'small')], ['c', P('r2-main', 'main')]])
    const costTogether = placementCost(together, ctx)
    const costApart = placementCost(apart, ctx)
    expect(costTogether.conflict).toBe(10) // 5 shared voters × 2 (≥ 0.6)
    expect(costApart.conflict).toBe(0)
    expect(costApart.total).toBeLessThan(costTogether.total)

    // a and c are disjoint: concurrent but free.
    expect(placementCost(new Map([['a', P('r1-main', 'main')], ['c', P('r1-small', 'small')]]), ctx).conflict).toBe(0)

    // Capacity: 30 expected in a room for 20 → 10 people over.
    const big = buildObjectiveContext([session('a', { expected_attendance: 30 })], SLOTS, VENUES, { ballots: BALLOTS, k: 3, timezone: TZ })
    expect(placementCost(new Map([['a', P('r1-small', 'small')]]), big).capacity).toBe(10)
    expect(placementCost(new Map([['a', P('r1-main', 'main')]]), big).capacity).toBe(0)

    // Constraints cost 1000 each: pinned room, missing feature, room format, host blackout.
    const constrained = buildObjectiveContext(
      [
        session('a', { pinned_venue_id: 'main' }),
        session('b', { required_features: ['projector'] }),
        session('c', { format: 'workshop' }),
        session('d', { blackouts: [{ startsAt: iso('15:30'), endsAt: iso('15:45') }] }),
      ],
      SLOTS,
      [VENUES[0], { ...VENUES[1], allowed_formats: ['talk'] }],
      { ballots: new Map(), k: 3, timezone: TZ },
    )
    const bad = new Map([['a', P('r1-small', 'small')], ['b', P('r2-small', 'small')], ['c', P('r3-small', 'small')], ['d', P('r1-main', 'main')]])
    expect(placementCost(bad, constrained)).toMatchObject({ violationCount: 4, violations: 4000 })
    const good = new Map([['a', P('r1-main', 'main')], ['b', P('r2-main', 'main')], ['c', P('r3-main', 'main')], ['d', P('r2-small', 'small')]])
    expect(placementCost(good, constrained).violationCount).toBe(0)

    // Imbalance: all votes in one time row costs more than spreading them.
    const stacked = new Map([['a', P('r1-main', 'main')], ['c', P('r1-small', 'small')]])
    const spread = new Map([['a', P('r1-main', 'main')], ['c', P('r2-main', 'main')]])
    expect(placementCost(stacked, ctx).imbalance).toBeGreaterThan(placementCost(spread, ctx).imbalance)
  })

  test('hill-climb separates a keep-apart pair seeded concurrently when a free slot exists, deterministically', () => {
    const sessions = [session('a'), session('b'), session('c')]
    const ctx = buildObjectiveContext(sessions, SLOTS, VENUES, { ballots: BALLOTS, k: 3, timezone: TZ })
    const seed = new Map([['a', P('r1-main', 'main')], ['b', P('r1-small', 'small')], ['c', P('r2-main', 'main')]])
    const result = hillClimb(seed, ctx, { budgetMs: 2000 })
    const slotOf = (id: string) => ctx.slots.get(result.assignments.get(id)!.slotId)!
    expect(slotOf('a').start_time).not.toBe(slotOf('b').start_time)
    expect(result.cost.total).toBeLessThan(result.stats.seedCost.total)
    expect(result.stats.moves + result.stats.swaps).toBeGreaterThan(0)
    expect(result.stats.stoppedBy).toBe('converged')
    expect(placementCost(result.assignments, ctx).conflict).toBe(0)
    // The seed is untouched and a second run lands on the same answer.
    expect(seed.get('b')).toEqual(P('r1-small', 'small'))
    const again = hillClimb(seed, ctx, { budgetMs: 2000 })
    expect([...again.assignments]).toEqual([...result.assignments])
  })

  test('hill-climb never moves hand-placed sessions and respects the budget', () => {
    // b is placed by hand in r1-small; a must be the one that moves.
    const sessions = [session('a'), session('b', { time_slot_id: 'r1-small', status: 'scheduled' }), session('c')]
    const ctx = buildObjectiveContext(sessions, SLOTS, VENUES, { ballots: BALLOTS, k: 3, timezone: TZ })
    expect([...ctx.fixed.keys()]).toEqual(['b'])
    const seed = new Map([...ctx.fixed, ['a', P('r1-main', 'main')], ['c', P('r2-main', 'main')]])
    const result = hillClimb(seed, ctx)
    expect(result.assignments.get('b')).toEqual(P('r1-small', 'small'))
    expect(result.assignments.get('a')!.slotId).not.toBe('r1-main')

    let now = 0
    const starved = hillClimb(seed, ctx, { budgetMs: 5, now: () => (now += 10) })
    expect(starved.stats.stoppedBy).toBe('budget')
    expect(starved.assignments.get('b')).toEqual(P('r1-small', 'small'))
  })

  test('quality score stays within 0..100 and reports checks and warnings', () => {
    const sessions = [session('a'), session('b'), session('c', { expected_attendance: 50 })]
    const ctx = buildObjectiveContext(sessions, SLOTS, VENUES, { ballots: BALLOTS, k: 3, timezone: TZ })

    const perfect = qualityScore(new Map([['a', P('r1-main', 'main')], ['b', P('r2-main', 'main')], ['c', P('r3-main', 'main')]]), ctx)
    expect(perfect.score).toBe(100)
    expect(perfect.checks).toEqual({ noKeepApartConflicts: true, constraintsMet: true })
    expect(perfect.violations).toEqual([])
    // Rows 1..3 have a session in Main Hall and nothing in Breakout.
    expect(perfect.warnings.filter((w) => w.startsWith('Empty room'))).toHaveLength(3)

    const clash = qualityScore(new Map([['a', P('r1-main', 'main')], ['b', P('r1-small', 'small')], ['c', P('r2-small', 'small')]]), ctx)
    expect(clash.keepApartConflicts).toBe(1)
    expect(clash.checks.noKeepApartConflicts).toBe(false)
    expect(clash.conflictPeople).toBe(5)
    expect(clash.totalVoterSessionPairs).toBe(17) // 5 + 5 + 5 + 2
    expect(clash.overCapacityPeople).toBe(30)
    expect(clash.totalDemand).toBe(60)
    expect(clash.score).toBeLessThan(perfect.score)
    expect(clash.score).toBeGreaterThanOrEqual(0)
    expect(clash.warnings.some((w) => w.startsWith('Keep apart'))).toBe(true)
    expect(clash.warnings.some((w) => w.startsWith('Over capacity'))).toBe(true)

    // Violations subtract 15 and fail the constraints check; the same slot twice is a violation.
    const doubled = qualityScore(new Map([['a', P('r1-main', 'main')], ['c', P('r1-main', 'main')]]), ctx)
    expect(doubled.checks.constraintsMet).toBe(false)
    expect(doubled.violations.length).toBeGreaterThan(0)
    expect(doubled.score).toBeLessThanOrEqual(85)

    // Capacity alone costs at most 25 points.
    const packed = buildObjectiveContext([session('a', { expected_attendance: 100000 })], SLOTS, VENUES, { ballots: BALLOTS, k: 3, timezone: TZ })
    expect(qualityScore(new Map([['a', P('r1-small', 'small')]]), packed).score).toBe(75)

    // Four sessions wanted by the same five people, all at once, all over capacity, one slot
    // double-booked: the raw formula goes negative and the score clamps at 0.
    const rooms: SchedulerVenue[] = ['p', 'q', 'r', 's'].map((id) => ({ id, name: id, capacity: 1, is_primary: false, features: [] }))
    const row: SchedulerTimeSlot[] = rooms.map((v) => ({ id: `row-${v.id}`, start_time: iso('15:00'), end_time: iso('16:00'), is_break: false, venue_id: v.id, day_date: DAY }))
    const crowd = buildObjectiveContext(
      ['a', 'b', 'c', 'd'].map((id) => session(id, { expected_attendance: 100 })),
      row,
      rooms,
      { ballots: ballotsOf({ a: V, b: V, c: V, d: V }), k: 3, timezone: TZ },
    )
    const jam = qualityScore(new Map([['a', P('row-p', 'p')], ['b', P('row-q', 'q')], ['c', P('row-r', 'r')], ['d', P('row-r', 'r')]]), crowd)
    expect(jam.conflictPeople).toBe(30) // 6 pairs × 5 people
    expect(jam.totalVoterSessionPairs).toBe(20)
    expect(jam.checks.constraintsMet).toBe(false)
    expect(jam.score).toBe(0)
  })

  test('autoSchedule keeps its shape, adds quality, improvement and the five PRD stages, and separates keep-apart pairs', () => {
    const sessions = [session('a'), session('b'), session('c'), session('d')]
    const result = autoSchedule(sessions, SLOTS, VENUES, { ballots: BALLOTS, timezone: TZ, k: 3 })
    expect(result.stats).toMatchObject({ totalSessions: 4, assigned: 4, unassigned: 0, usedBallots: true, k: 3, keepApartPairs: 1 })
    expect(result.assignments.map((a) => Object.keys(a).sort())).toEqual(Array(4).fill(['score', 'sessionId', 'sessionTitle', 'slotId', 'venueId', 'warnings']))
    expect(result.stages.map((s) => s.name)).toEqual(SCHEDULER_STAGE_NAMES.map((s) => s.name))
    expect(result.stages.every((s) => s.status === 'done' && s.detail.length > 0)).toBe(true)
    const slotById = new Map(SLOTS.map((s) => [s.id, s]))
    const start = (id: string) => slotById.get(result.assignments.find((a) => a.sessionId === id)!.slotId)!.start_time
    expect(start('a')).not.toBe(start('b'))
    expect(result.quality.keepApartConflicts).toBe(0)
    expect(result.quality.checks.constraintsMet).toBe(true)
    expect(result.improvement.finalCost.total).toBeLessThanOrEqual(result.improvement.seedCost.total)
    // Ballot tokens never reach the result.
    const blob = JSON.stringify(result)
    for (const t of [...V, ...W]) expect(blob).not.toContain(`"${t}"`)
  })
})

/* ───────────────────────────── API ───────────────────────────── */

const base = process.env.TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

test.describe('scheduling routes', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let organizer: TestAccount
  let outsider: TestAccount
  const S: Record<'s1' | 's2' | 's3' | 's4', string> = { s1: '', s2: '', s3: '', s4: '' }
  const TOKENS = Array.from({ length: 8 }, () => randomBytes(32).toString('hex'))
  let rowA: { main: string; workshop: string }
  let rowB: { main: string }

  const api = (request: APIRequestContext, method: 'GET' | 'POST', url: string, cookie?: string, data?: unknown) =>
    request.fetch(`${base}${url}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: base }) },
      ...(data !== undefined ? { data } : {}),
    })

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(raw, { tag: 'sched', status: 'scheduling', withProgram: true, policyThresholds: { feedbackK: 3 } })
    organizer = await createTestAccount('sched-org', { sql: raw })
    outsider = await createTestAccount('sched-out', { sql: raw })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${organizer.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`

    for (const key of ['s1', 's2', 's3', 's4'] as const) {
      const [row] = await raw<{ id: string }[]>`
        insert into sessions (event_id, title, format, duration, host_id, status, is_votable)
        values (${gathering.id}, ${`sched ${key} ${gathering.slug}`}, 'talk', 60, ${organizer.id}, 'approved', true)
        returning id
      `
      S[key] = row.id
    }

    // A finalized round: key destroyed, tokens hand-made (spec §5.4 — they link votes to each other only).
    const [round] = await raw<{ id: string }[]>`
      insert into vote_rounds (event_id, mechanism, credits, opens_at, closes_at, ballot_key, finalized_at)
      values (${gathering.id}, 'quadratic', 100, now() - interval '3 hours', now() - interval '1 hour', null, now() - interval '1 hour')
      returning id
    `
    for (const t of TOKENS) {
      await raw`insert into vote_ballots (round_id, event_id, token, cast_at) values (${round.id}, ${gathering.id}, decode(${t}, 'hex'), now() - interval '1 hour')`
    }
    // s1 and s2 share five voters (100%); s3 has three others (disjoint); s4 has two voters (< k).
    const entries: Array<[string, string[]]> = [
      [S.s1, TOKENS.slice(0, 5)],
      [S.s2, TOKENS.slice(0, 5)],
      [S.s3, TOKENS.slice(5, 8)],
      [S.s4, TOKENS.slice(0, 2)],
    ]
    for (const [sessionId, ts] of entries) {
      for (const t of ts) {
        await raw`insert into vote_entries (round_id, event_id, session_id, votes, credits, day, ballot_token)
                  values (${round.id}, ${gathering.id}, ${sessionId}, 1, 1, current_date, decode(${t}, 'hex'))`
      }
    }

    const slots = await raw<{ id: string; venue_id: string; start_time: string }[]>`
      select id, venue_id, start_time::text as start_time from time_slots where event_id = ${gathering.id} and not is_break order by start_time, venue_id
    `
    const [mainId, workshopId] = gathering.venueIds
    const starts = [...new Set(slots.map((s) => s.start_time))]
    const at = (start: string, venue: string) => slots.find((s) => s.start_time === start && s.venue_id === venue)!.id
    rowA = { main: at(starts[0], mainId), workshop: at(starts[0], workshopId) }
    rowB = { main: at(starts[1], mainId) }
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await organizer?.cleanup()
    await outsider?.cleanup()
    await raw?.end()
  })

  test('audience clusters: keep-apart, fine-together and suppression, without a single token', async ({ request }) => {
    const res = await api(request, 'GET', `/api/v1/events/${gathering.slug}/admin/audience-clusters`, organizer.cookie)
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.k).toBe(3)
    expect(body.keepApart).toHaveLength(1)
    expect(body.keepApart[0]).toMatchObject({ overlapPercent: 100, sharedVoters: 5 })
    expect([body.keepApart[0].a.id, body.keepApart[0].b.id].sort()).toEqual([S.s1, S.s2].sort())
    expect(body.keepApart[0].a.title).toMatch(/^sched s[12]/)
    expect(body.fineTogether).toHaveLength(1)
    expect(body.fineTogether[0].sessions.map((s: { id: string }) => s.id)).toContain(S.s3)
    expect(body.fineTogether[0].maxOverlapPercent).toBe(0)
    expect(body.comparableSessions).toBe(3)
    expect(body.suppressed).toEqual({ pairs: 3, sessions: 1 })
    const blob = await res.text()
    for (const t of TOKENS) expect(blob).not.toContain(t)
    expect(blob).not.toMatch(/"tokens?"/)
  })

  test('audience clusters and quality are organizer-only', async ({ request }) => {
    expect((await api(request, 'GET', `/api/v1/events/${gathering.slug}/admin/audience-clusters`)).status()).toBe(401)
    expect((await api(request, 'GET', `/api/v1/events/${gathering.slug}/admin/audience-clusters`, outsider.cookie)).status()).toBe(403)
    expect((await api(request, 'POST', `/api/v1/events/${gathering.slug}/admin/schedule-quality`, outsider.cookie, { assignments: [] })).status()).toBe(403)
    // Cross-origin mutation is refused before anything else.
    const cross = await request.fetch(`${base}/api/v1/events/${gathering.slug}/admin/schedule-quality`, {
      method: 'POST',
      headers: { cookie: organizer.cookie, origin: 'https://evil.example' },
      data: { assignments: [] },
    })
    expect(cross.status()).toBe(403)
  })

  test('schedule quality scores a draft: keep-apart pair concurrent vs apart', async ({ request }) => {
    const url = `/api/v1/events/${gathering.slug}/admin/schedule-quality`
    const together = await api(request, 'POST', url, organizer.cookie, {
      assignments: [{ sessionId: S.s1, slotId: rowA.main }, { sessionId: S.s2, slotId: rowA.workshop }],
    })
    expect(together.status(), await together.text()).toBe(200)
    const t = await together.json()
    expect(t.evaluated).toBe(2)
    expect(t.quality.keepApartConflicts).toBe(1)
    expect(t.quality.checks.noKeepApartConflicts).toBe(false)
    expect(t.quality.conflictPeople).toBe(5)

    const apart = await api(request, 'POST', url, organizer.cookie, {
      assignments: [{ sessionId: S.s1, slotId: rowA.main, venueId: gathering.venueIds[0] }, { sessionId: S.s2, slotId: rowB.main }],
    })
    expect(apart.status()).toBe(200)
    const a = await apart.json()
    expect(a.quality.keepApartConflicts).toBe(0)
    expect(a.quality.checks).toEqual({ noKeepApartConflicts: true, constraintsMet: true })
    expect(a.quality.score).toBeGreaterThan(t.quality.score)
    for (const blob of [JSON.stringify(t), JSON.stringify(a)]) for (const tok of TOKENS) expect(blob).not.toContain(tok)

    // Foreign ids and malformed drafts are refused.
    expect((await api(request, 'POST', url, organizer.cookie, { assignments: [{ sessionId: S.s1, slotId: '00000000-0000-4000-8000-000000000000' }] })).status()).toBe(400)
    expect((await api(request, 'POST', url, organizer.cookie, { assignments: [{ sessionId: S.s1 }] })).status()).toBe(400)
    expect((await api(request, 'POST', url, organizer.cookie, { assignments: 'nope' })).status()).toBe(400)
  })

  test('auto-schedule preview returns quality, stages and a plan that keeps s1 and s2 apart', async ({ request }) => {
    const res = await api(request, 'GET', `/api/v1/events/${gathering.slug}/admin/auto-schedule`, organizer.cookie)
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.stats).toMatchObject({ totalSessions: 4, assigned: 4, usedBallots: true, k: 3, keepApartPairs: 1 })
    expect(body.stages.map((s: { name: string }) => s.name)).toEqual(SCHEDULER_STAGE_NAMES.map((s) => s.name))
    expect(body.quality.keepApartConflicts).toBe(0)
    expect(body.quality.checks.constraintsMet).toBe(true)
    expect(body.improvement.finalCost.total).toBeLessThanOrEqual(body.improvement.seedCost.total)
    const slots = await raw<{ id: string; start_time: string }[]>`select id, start_time::text as start_time from time_slots where event_id = ${gathering.id}`
    const startOf = new Map(slots.map((s) => [s.id, s.start_time]))
    const placed = (id: string) => startOf.get(body.assignments.find((a: { sessionId: string }) => a.sessionId === id).slotId)
    expect(placed(S.s1)).not.toBe(placed(S.s2))
    const blob = await res.text()
    for (const t of TOKENS) expect(blob).not.toContain(t)
  })

  test('while a round is open every ballot-backed view answers 409 RoundOpen', async ({ request }) => {
    // A pre-event round only stays open while the gathering is voting (the sweep closes it otherwise).
    await raw`update events set status = 'voting_open' where id = ${gathering.id}`
    const [open] = await raw<{ id: string }[]>`
      insert into vote_rounds (event_id, mechanism, credits, opens_at, closes_at)
      values (${gathering.id}, 'quadratic', 100, now() - interval '1 hour', now() + interval '1 hour') returning id
    `
    try {
      for (const [method, path, data] of [
        ['GET', 'audience-clusters', undefined],
        ['GET', 'auto-schedule', undefined],
        ['POST', 'schedule-quality', { assignments: [] }],
      ] as const) {
        const res = await api(request, method, `/api/v1/events/${gathering.slug}/admin/${path}`, organizer.cookie, data)
        expect(res.status(), `${method} ${path}`).toBe(409)
        expect((await res.json()).code).toBe('RoundOpen')
      }
    } finally {
      await raw`delete from vote_rounds where id = ${open.id}`
      await raw`update events set status = 'scheduling' where id = ${gathering.id}`
    }
  })
})
