import { test, expect, type APIRequestContext } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'
import { createTestGathering, deletePdsAccount, signInWithEmail, type TestGathering } from './helpers/gathering'

// Attendance voting (design §11, PRD §2.3): the second ballot-key round, `phase = 'attendance'`,
// against the local stack (Postgres :55432, dev PDS) and the running dev server (:3001, mail off).
//
// Two throwaway gatherings (tests/helpers/gathering.ts), never a seeded one: one opted in, one not.
// Every row this file creates is deleted in afterAll.
loadEnvConfig(process.cwd(), true)

const base = process.env.VOTING_TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const emailFor = (who: string) => `attv+${RUN}-${who}@example.test`

type Voting = typeof import('../src/lib/voting')

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('attendance voting', () => {
  test.skip(!isLocal || !pdsUrl || !pdsAdminPassword, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')

  type Resolver = (request: string, ...rest: unknown[]) => string
  const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
  const originalResolve = moduleWithResolver._resolveFilename

  let raw: postgres.Sql
  let voting: Voting
  let live: TestGathering | null = null
  let quiet: TestGathering | null = null
  const createdDids = new Set<string>()

  const cookies = { org: '', voterA: '' }
  const ids = { org: '', voterA: '', B: '', C: '' }
  // sessions of the opted-in gathering
  let S_NOW = ''      // scheduled, slot contains now
  let S_LATER = ''    // scheduled, slot in three hours
  let S_UNSCHED = ''  // approved, no slot
  let roundId = ''

  async function accountId(email: string): Promise<string> {
    const [row] = await raw<{ id: string; did: string }[]>`select id, did from accounts where email = ${email}`
    expect(row).toBeTruthy()
    createdDids.add(row.did)
    return row.id
  }

  const api = (request: APIRequestContext, method: 'GET' | 'PUT' | 'PATCH', url: string, cookie?: string, data?: unknown) =>
    request.fetch(`${base}${url}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: base }) },
      ...(data !== undefined ? { data } : {}),
    })

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
    moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
      return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    voting = require('../src/lib/voting') as Voting
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })

    live = await createTestGathering(raw, { tag: 'attv', status: 'scheduling', startInDays: 0, policyThresholds: { feedbackK: 3 } })
    quiet = await createTestGathering(raw, { tag: 'attq', status: 'scheduling', startInDays: 0 })
    await raw`update events set attendance_voting_enabled = true, attendance_credits = 50 where id = ${live.id}`

    cookies.org = await signInWithEmail(emailFor('org'), base)
    cookies.voterA = await signInWithEmail(emailFor('votera'), base)
    ids.org = await accountId(emailFor('org'))
    ids.voterA = await accountId(emailFor('votera'))
    for (const who of ['B', 'C'] as const) {
      const [row] = await raw<{ id: string }[]>`
        insert into accounts (did, handle, email, kind)
        values (${`did:plc:attv${RUN}${who.toLowerCase()}`}, ${`attv-${RUN}-${who.toLowerCase()}.test`}, ${emailFor(who.toLowerCase())}, 'custodial')
        returning id
      `
      ids[who] = row.id
    }
    await raw`
      insert into event_members (event_id, user_id, role) values
        (${live.id}, ${ids.org}, 'owner'),
        (${live.id}, ${ids.voterA}, 'attendee'),
        (${live.id}, ${ids.B}, 'attendee'),
        (${live.id}, ${ids.C}, 'attendee'),
        (${quiet.id}, ${ids.org}, 'owner')
      on conflict (event_id, user_id) do update set role = excluded.role, vote_credits = null
    `

    const [venue] = await raw<{ id: string }[]>`
      insert into venues (event_id, name, slug, capacity) values (${live.id}, 'Room A', 'room-a', 40) returning id
    `
    const slots = await raw<{ id: string }[]>`
      insert into time_slots (event_id, venue_id, start_time, end_time, day_date, slot_type)
      values (${live.id}, ${venue.id}, now() - interval '10 minutes', now() + interval '40 minutes', current_date, 'session'),
             (${live.id}, ${venue.id}, now() + interval '3 hours', now() + interval '4 hours', current_date, 'session')
      returning id
    `
    const session = async (title: string, status: string, slot: string | null) => {
      const [row] = await raw<{ id: string }[]>`
        insert into sessions (event_id, title, format, duration, host_id, status, is_votable, venue_id, time_slot_id)
        values (${live!.id}, ${`attv ${RUN} ${title}`}, 'talk', 30, ${ids.org}, ${status}, true, ${slot ? venue.id : null}, ${slot})
        returning id
      `
      return row.id
    }
    S_NOW = await session('now', 'scheduled', slots[0].id)
    S_LATER = await session('later', 'scheduled', slots[1].id)
    S_UNSCHED = await session('unscheduled', 'approved', null)
  })

  test.afterAll(async () => {
    moduleWithResolver._resolveFilename = originalResolve
    if (raw) {
      await live?.cleanup()
      await quiet?.cleanup()
      const rows = await raw<{ did: string }[]>`select did from accounts where email like ${`attv+${RUN}-%`}`
      for (const r of rows) if (!r.did.startsWith(`did:plc:attv${RUN}`)) createdDids.add(r.did)
      for (const did of createdDids) await deletePdsAccount(did)
      await raw`delete from accounts where email like ${`attv+${RUN}-%`}`
      await raw`delete from auth_email_tokens where email like ${`attv+${RUN}-%`}`
      await raw.end({ timeout: 5 })
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await (require('../src/lib/db') as typeof import('../src/lib/db')).sql.end({ timeout: 5 }).catch(() => {})
  })

  test('going live opens an attendance round with fresh credits; a gathering that did not opt in gets none', async ({ request }) => {
    const before = await api(request, 'GET', `/api/v1/events/${live!.slug}/rounds/current?round=attendance`)
    expect(before.status()).toBe(200)
    expect(await before.json()).toMatchObject({ round: null, status: 'none', attendance: { open: false, votable_now: [] } })

    const go = await api(request, 'PATCH', `/api/events/${live!.id}/settings`, cookies.org, { status: 'live' })
    expect(go.status(), await go.text()).toBe(200)
    const rounds = await raw<{ id: string; phase: string; credits: number; has_key: boolean; finalized: boolean; future: boolean; ledger: number }[]>`
      select r.id, r.phase, r.credits, r.ballot_key is not null as has_key, r.finalized_at is not null as finalized,
             r.closes_at > now() + interval '55 minutes' as future,
             (select count(*) from credit_ledger l where l.round_id = r.id)::int as ledger
      from vote_rounds r where r.event_id = ${live!.id}
    `
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toMatchObject({ phase: 'attendance', credits: 50, has_key: true, finalized: false, future: true, ledger: 0 })
    roundId = rounds[0].id

    // Members were told once, with the fresh budget.
    const [note] = await raw<{ n: number }[]>`
      select count(*)::int as n from notifications where event_id = ${live!.id} and type = 'voting_opened' and title like 'Attendance voting is open%'
    `
    expect(note.n).toBeGreaterThanOrEqual(4)

    // Same transition, attendance voting off: no round of any kind.
    const quietGo = await api(request, 'PATCH', `/api/events/${quiet!.id}/settings`, cookies.org, { status: 'live' })
    expect(quietGo.status(), await quietGo.text()).toBe(200)
    const [none] = await raw<{ n: number }[]>`select count(*)::int as n from vote_rounds where event_id = ${quiet!.id}`
    expect(none.n).toBe(0)
  })

  test('reads describe the window — open, votable now, credits — and never a count', async ({ request }) => {
    const mine = await api(request, 'GET', `/api/v1/events/${live!.slug}/votes/mine?round=attendance`, cookies.voterA)
    expect(mine.status()).toBe(200)
    const body = await mine.json()
    expect(body.round).toMatchObject({ id: roundId, phase: 'attendance', credits: 50, status: 'open' })
    expect(body).toMatchObject({ status: 'open', budget: 50, remaining: 50, spent: 0, canVote: true, sealed: false, allocation: {} })
    expect(body.attendance.open).toBe(true)
    expect(body.attendance.credits_remaining).toBe(50)
    expect(body.attendance.votable_now).toContain(S_NOW)
    expect(body.attendance.votable_now).not.toContain(S_LATER)
    expect(body.attendance.votable_now).not.toContain(S_UNSCHED)
    expect(JSON.stringify(body)).not.toMatch(/"(voters|ballotsCast|ballot_key|ballotKey|results|entries)"/)

    // The pre-event view is a different round (none here) and still carries the attendance block.
    const pre = await api(request, 'GET', `/api/v1/events/${live!.slug}/votes/mine`, cookies.voterA)
    expect(pre.status()).toBe(200)
    const preBody = await pre.json()
    expect(preBody).toMatchObject({ round: null, status: 'none', allocation: {} })
    expect(preBody.attendance).toMatchObject({ open: true, credits_remaining: 50 })

    const bad = await api(request, 'GET', `/api/v1/events/${live!.slug}/votes/mine?round=later`, cookies.voterA)
    expect(bad.status()).toBe(400)
  })

  test('votes are accepted only while the session is happening; the pre-event round is untouched', async ({ request }) => {
    const ok = await api(request, 'PUT', `/api/v1/events/${live!.slug}/votes/mine`, cookies.voterA, { sessionId: S_NOW, votes: 2, round: 'attendance' })
    expect(ok.status(), await ok.text()).toBe(200)
    const okBody = await ok.json()
    expect(okBody.allocation).toEqual({ [S_NOW]: 2 })
    expect(okBody.remaining).toBe(46)
    expect(okBody.attendance.credits_remaining).toBe(46)

    const later = await api(request, 'PUT', `/api/v1/events/${live!.slug}/votes/mine`, cookies.voterA, { sessionId: S_LATER, votes: 1, round: 'attendance' })
    expect(later.status()).toBe(403)
    expect((await later.json()).code).toBe('SessionNotHappening')

    const unsched = await api(request, 'PUT', `/api/v1/events/${live!.slug}/votes/mine`, cookies.voterA, { sessionId: S_UNSCHED, votes: 1, round: 'attendance' })
    expect(unsched.status()).toBe(403)
    expect((await unsched.json()).code).toBe('SessionNotHappening')

    // Removing is always allowed, even outside the window.
    const remove = await api(request, 'PUT', `/api/v1/events/${live!.slug}/votes/mine`, cookies.voterA, { sessionId: S_LATER, votes: 0, round: 'attendance' })
    expect(remove.status()).toBe(200)

    // Without `round` the write means the pre-event round, which does not exist here.
    const pre = await api(request, 'PUT', `/api/v1/events/${live!.slug}/votes/mine`, cookies.voterA, { sessionId: S_NOW, votes: 1 })
    expect(pre.status()).toBe(409)
    expect((await pre.json()).code).toBe('NoRound')

    // Cross-origin and signed-out writes are refused before anything else.
    const foreign = await request.fetch(`${base}/api/v1/events/${live!.slug}/votes/mine`, {
      method: 'PUT', headers: { cookie: cookies.voterA, origin: 'https://evil.example' }, data: { sessionId: S_NOW, votes: 1, round: 'attendance' },
    })
    expect(foreign.status()).toBe(403)
    const anon = await api(request, 'PUT', `/api/v1/events/${live!.slug}/votes/mine`, undefined, { sessionId: S_NOW, votes: 1, round: 'attendance' })
    expect(anon.status()).toBe(401)

    // The ledger row is the only author-linked thing and it belongs to the attendance round.
    const ledger = await raw<{ round_id: string; allocated: Record<string, number> }[]>`
      select round_id, allocated from credit_ledger where event_id = ${live!.id} and account_id = ${ids.voterA}
    `
    expect(ledger).toEqual([{ round_id: roundId, allocated: { [S_NOW]: 2 } }])
  })

  test('counts are sealed while the round is open — for organizers too', async ({ request }) => {
    const tally = await api(request, 'GET', `/api/v1/events/${live!.slug}/rounds/${roundId}/tally`, cookies.org)
    expect(tally.status()).toBe(409)
    const results = await api(request, 'GET', `/api/v1/events/${live!.slug}/rounds/${roundId}/results`, cookies.org)
    expect(results.status()).toBe(409)
    const analytics = await api(request, 'GET', `/api/v1/events/${live!.slug}/admin/overview/analytics`, cookies.org)
    expect(analytics.status(), await analytics.text()).toBe(200)
    const body = await analytics.json()
    expect(body.attendance).toMatchObject({ enabled: true, status: 'open', sealed: true })
    expect(JSON.stringify(body.attendance)).not.toMatch(/"(voters|votes|credits|entries|ballotsCast)"/)
  })

  test('the close job seals it: key destroyed, ledger gone, token-only entries, k-suppressed signal', async ({ request }) => {
    // Three voters on S_NOW (k = 3) so its counts show; S_LATER gets none and is suppressed.
    await voting.setAllocation(live!.id, ids.B, S_NOW, 1, 'attendance')
    await voting.setAllocation(live!.id, ids.C, S_NOW, 1, 'attendance')

    await raw`update vote_rounds set opens_at = least(opens_at, now() - interval '2 seconds'), closes_at = now() - interval '1 second' where id = ${roundId}`
    const job = await api(request, 'GET', `/api/jobs/close-rounds`)
    expect(job.status(), await job.text()).toBe(200)
    const jobBody = await job.json()
    expect(jobBody.rounds.closed.map((r: { roundId: string; phase: string }) => `${r.phase}:${r.roundId}`)).toContain(`attendance:${roundId}`)

    const [round] = await raw<{ key_null: boolean; finalized: boolean; ledger: number; ballots: number }[]>`
      select ballot_key is null as key_null, finalized_at is not null as finalized,
             (select count(*) from credit_ledger where round_id = ${roundId})::int as ledger,
             (select count(*) from vote_ballots where round_id = ${roundId})::int as ballots
      from vote_rounds where id = ${roundId}
    `
    expect(round).toEqual({ key_null: true, finalized: true, ledger: 0, ballots: 3 })

    // Entries: token, day, no account; the same columns the pre-event round writes.
    const cols = await raw<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'vote_entries' order by column_name
    `
    expect(cols.map((c) => c.column_name)).toEqual(['ballot_token', 'credits', 'day', 'event_id', 'id', 'round_id', 'session_id', 'votes'])
    const entries = await raw<{ session_id: string; votes: number; credits: number; token: string }[]>`
      select session_id, votes, credits, encode(ballot_token, 'hex') as token from vote_entries where round_id = ${roundId}
    `
    expect(entries).toHaveLength(3)
    expect(entries.every((e) => e.session_id === S_NOW)).toBe(true)
    expect(new Set(entries.map((e) => e.token)).size).toBe(3)
    expect(entries.map((e) => e.votes).sort()).toEqual([1, 1, 2])

    // The voter's own view: sealed, allocation gone.
    const mine = await api(request, 'GET', `/api/v1/events/${live!.slug}/votes/mine?round=attendance`, cookies.voterA)
    expect(await mine.json()).toMatchObject({ status: 'closed', sealed: true, allocation: {}, canVote: false, attendance: { open: false, votable_now: [] } })

    // Analytics: the k-suppressed signal, scheduled sessions only.
    const analytics = await api(request, 'GET', `/api/v1/events/${live!.slug}/admin/overview/analytics`, cookies.org)
    const body = await analytics.json()
    expect(body.attendance).toMatchObject({ enabled: true, status: 'closed', sealed: false, k: 3, ballotsCast: 3, credits: 50 })
    const byId = new Map<string, Record<string, unknown>>(body.attendance.entries.map((e: { sessionId: string }) => [e.sessionId, e]))
    expect(byId.get(S_NOW)).toMatchObject({ suppressed: false, voters: 3, votes: 4, credits: 6 })
    expect(byId.get(S_LATER)).toMatchObject({ suppressed: true })
    expect(byId.get(S_LATER)).not.toHaveProperty('votes')
    expect(byId.has(S_UNSCHED)).toBe(false)

    // The public tally of the closed round is readable and equally suppressed.
    const tally = await api(request, 'GET', `/api/v1/events/${live!.slug}/rounds/${roundId}/tally`)
    expect(tally.status()).toBe(200)
    const tallyBody = await tally.json()
    expect(tallyBody.round.phase).toBe('attendance')
    expect(tallyBody.entries.find((e: { sessionId: string }) => e.sessionId === S_NOW)).toMatchObject({ suppressed: false, voters: 3 })
  })

  test('switching attendance voting off while live seals an open round', async () => {
    const reopened = await voting.openRound(live!.id, { phase: 'attendance', credits: 50 })
    expect(reopened.status).toBe('open')
    expect(reopened.id).not.toBe(roundId)
    await raw`update events set attendance_voting_enabled = false where id = ${live!.id}`
    const state = await voting.roundState(live!.id, 'attendance')
    expect(state.status).toBe('closed')
    const [row] = await raw<{ key_null: boolean }[]>`select ballot_key is null as key_null from vote_rounds where id = ${reopened.id}`
    expect(row.key_null).toBe(true)
  })
})
