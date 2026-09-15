import { test, expect, type APIRequestContext } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'

// Ballot-key voting and feedback ballots (spec §5, plan §7.2 "Voting (C owns)") against the
// local stack (Postgres :55432, dev PDS) and the running dev server (:3001, mail disabled).
//
// Uses the seeded `demo-gathering`: its voting fields are saved first and restored in
// afterAll, and every row this file creates (sessions, rounds, accounts, PDS accounts) is
// deleted there.
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

const SLUG = 'demo-gathering'
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const emailFor = (who: string) => `pkgc+${RUN}-${who}@example.test`

type Voting = typeof import('../src/lib/voting')

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('ballot-key voting', () => {
  test.skip(!isLocal || !pdsUrl || !pdsAdminPassword, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')

  type Resolver = (request: string, ...rest: unknown[]) => string
  const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
  const originalResolve = moduleWithResolver._resolveFilename

  let raw: postgres.Sql
  let voting: Voting
  let eventId = ''
  let savedEvent: Record<string, unknown> | null = null
  const createdDids = new Set<string>()
  const sessionIds: string[] = []
  const roundIds = new Set<string>()

  // accounts
  const cookies: Record<'org' | 'voterA' | 'outsider', string> = { org: '', voterA: '', outsider: '' }
  const ids: Record<'org' | 'voterA' | 'outsider' | 'B' | 'C' | 'D', string> = { org: '', voterA: '', outsider: '', B: '', C: '', D: '' }
  // sessions: S1..S4 votable, S5 not votable, S6 pending
  let S: string[] = []
  let quadraticRoundId = ''

  async function devLogin(email: string): Promise<string> {
    const res = await fetch(`${base}/api/auth/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email, next: '/' }),
    })
    const body = (await res.json().catch(() => ({}))) as { devVerifyUrl?: string }
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(typeof body.devVerifyUrl, 'run the dev server without RESEND_API_KEY').toBe('string')
    const verify = await fetch(body.devVerifyUrl!, { redirect: 'manual' })
    const cookie = (verify.headers.getSetCookie?.() ?? [verify.headers.get('set-cookie') ?? ''])
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('sp_at_session='))
    expect(cookie, 'verify must set the session cookie').toBeTruthy()
    return cookie!
  }

  async function accountId(email: string): Promise<string> {
    const [row] = await raw<{ id: string; did: string }[]>`select id, did from accounts where email = ${email}`
    expect(row).toBeTruthy()
    createdDids.add(row.did)
    return row.id
  }

  const api = (request: APIRequestContext, method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, cookie?: string, data?: unknown) =>
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

    const [event] = await raw<Record<string, unknown>[]>`
      select id, status, voting_mechanism, vote_credits_per_user, voting_opens_at, voting_closes_at, policy_thresholds, ticketing_enabled
      from events where slug = ${SLUG}
    `
    expect(event, `seeded ${SLUG}`).toBeTruthy()
    savedEvent = event
    eventId = event.id as string

    // A crashed earlier run may have left an unfinalized round; one open round per phase.
    await raw`delete from vote_rounds where event_id = ${eventId} and finalized_at is null`

    cookies.org = await devLogin(emailFor('org'))
    cookies.voterA = await devLogin(emailFor('votera'))
    cookies.outsider = await devLogin(emailFor('outsider'))
    ids.org = await accountId(emailFor('org'))
    ids.voterA = await accountId(emailFor('votera'))
    ids.outsider = await accountId(emailFor('outsider'))
    for (const who of ['B', 'C', 'D'] as const) {
      const [row] = await raw<{ id: string }[]>`
        insert into accounts (did, handle, email, kind)
        values (${`did:plc:pkgc${RUN}${who.toLowerCase()}`}, ${`pkgc-${RUN}-${who.toLowerCase()}.test`}, ${emailFor(who.toLowerCase())}, 'custodial')
        returning id
      `
      ids[who] = row.id
    }

    await raw`
      insert into event_members (event_id, user_id, role) values
        (${eventId}, ${ids.org}, 'owner'),
        (${eventId}, ${ids.voterA}, 'attendee'),
        (${eventId}, ${ids.B}, 'attendee'),
        (${eventId}, ${ids.C}, 'attendee'),
        (${eventId}, ${ids.D}, 'attendee')
      on conflict (event_id, user_id) do update set role = excluded.role, vote_credits = null
    `
    await raw`
      update events set status = 'voting_open', voting_mechanism = 'quadratic', vote_credits_per_user = 100,
        voting_opens_at = null, voting_closes_at = null, ticketing_enabled = false,
        policy_thresholds = policy_thresholds || '{"feedbackK": 3}'::jsonb
      where id = ${eventId}
    `

    const specs = [
      { title: 'S1', status: 'approved', votable: true },
      { title: 'S2', status: 'approved', votable: true },
      { title: 'S3', status: 'approved', votable: true },
      { title: 'S4', status: 'approved', votable: true },
      { title: 'S5 not votable', status: 'approved', votable: false },
      { title: 'S6 pending', status: 'pending', votable: true },
    ]
    for (const s of specs) {
      const [row] = await raw<{ id: string }[]>`
        insert into sessions (event_id, title, format, duration, host_id, status, is_votable)
        values (${eventId}, ${`pkgc ${RUN} ${s.title}`}, 'talk', 30, ${ids.org}, ${s.status}, ${s.votable})
        returning id
      `
      sessionIds.push(row.id)
    }
    S = sessionIds
  })

  test.afterAll(async () => {
    moduleWithResolver._resolveFilename = originalResolve
    if (raw) {
      if (roundIds.size) await raw`delete from vote_rounds where id in ${raw([...roundIds])}`
      if (sessionIds.length) await raw`delete from sessions where id in ${raw(sessionIds)}`
      if (savedEvent) {
        await raw`
          update events set status = ${savedEvent.status as string}, voting_mechanism = ${savedEvent.voting_mechanism as string},
            vote_credits_per_user = ${savedEvent.vote_credits_per_user as number},
            voting_opens_at = ${savedEvent.voting_opens_at as string | null}, voting_closes_at = ${savedEvent.voting_closes_at as string | null},
            policy_thresholds = ${raw.json(savedEvent.policy_thresholds as postgres.JSONValue)}, ticketing_enabled = ${savedEvent.ticketing_enabled as boolean}
          where id = ${eventId}
        `
      }
      const rows = await raw<{ did: string }[]>`select did from accounts where email like ${`pkgc+${RUN}-%`}`
      for (const r of rows) if (!r.did.startsWith(`did:plc:pkgc${RUN}`)) createdDids.add(r.did)
      for (const did of createdDids) {
        const res = await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`,
          },
          body: JSON.stringify({ did }),
        })
        if (!res.ok) console.warn(`PDS deleteAccount ${did}: ${res.status} ${await res.text()}`)
      }
      await raw`delete from accounts where email like ${`pkgc+${RUN}-%`}`
      await raw`delete from auth_email_tokens where email like ${`pkgc+${RUN}-%`}`
      await raw.end({ timeout: 5 })
    }
    await voting?.closeDueRounds().catch(() => {})
    // The lib's own pool.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    await (require('../src/lib/db') as typeof import('../src/lib/db')).sql.end({ timeout: 5 }).catch(() => {})
  })

  test('schema: votes and counters are gone; ballot tables carry no account column', async () => {
    const [gone] = await raw<{ votes: boolean; total_votes: boolean; profile_credits: boolean; session_feedback: boolean }[]>`
      select
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'votes') as votes,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sessions'
                and column_name in ('total_votes', 'total_credits', 'voter_count')) as total_votes,
        exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'vote_credits') as profile_credits,
        exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'session_feedback') as session_feedback
    `
    expect(gone).toEqual({ votes: false, total_votes: false, profile_credits: false, session_feedback: false })

    const cols = async (table: string) =>
      (await raw<{ column_name: string; data_type: string }[]>`
        select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = ${table}
        order by column_name
      `)
    const entries = await cols('vote_entries')
    expect(entries.map((c) => c.column_name)).toEqual(['ballot_token', 'credits', 'day', 'event_id', 'id', 'round_id', 'session_id', 'votes'])
    expect(entries.find((c) => c.column_name === 'day')?.data_type).toBe('date')
    expect((await cols('vote_ballots')).map((c) => c.column_name)).toEqual(['cast_at', 'event_id', 'round_id', 'token'])
    const feedback = await cols('feedback_entries')
    expect(feedback.map((c) => c.column_name)).toEqual(['comment', 'day', 'event_id', 'id', 'rating', 'session_id', 'would_attend_again'])
    expect(feedback.find((c) => c.column_name === 'day')?.data_type).toBe('date')
    expect((await cols('feedback_ballots')).map((c) => c.column_name)).toEqual(['event_id', 'session_id', 'token'])

    // Server-only: RLS on, no policies, no privileges for the signed-in role.
    const tables = ['vote_rounds', 'credit_ledger', 'vote_ballots', 'vote_entries', 'vote_round_results', 'feedback_windows', 'feedback_ballots', 'feedback_entries']
    const rls = await raw<{ relname: string; relrowsecurity: boolean; policies: number; auth_select: boolean }[]>`
      select c.relname, c.relrowsecurity,
             (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies,
             has_table_privilege('authenticated', c.oid, 'select') as auth_select
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ${raw(tables)}
    `
    expect(rls).toHaveLength(tables.length)
    for (const r of rls) expect(r, r.relname).toMatchObject({ relrowsecurity: true, policies: 0, auth_select: false })
  })

  test('approval rounds reject votes=2 and cap the count at the credits', async () => {
    const round = await voting.openRound(eventId, { mechanism: 'approval', credits: 2, closesAt: new Date(Date.now() + 3_600_000) })
    roundIds.add(round.id)
    expect(round).toMatchObject({ mechanism: 'approval', credits: 2, status: 'open' })

    await expect(voting.setAllocation(eventId, ids.D, S[0], 2)).rejects.toMatchObject({ status: 400, code: 'InvalidVotes' })
    await voting.setAllocation(eventId, ids.D, S[0], 1)
    const view = await voting.setAllocation(eventId, ids.D, S[1], 1)
    expect(view.spent).toBe(2)
    await expect(voting.setAllocation(eventId, ids.D, S[2], 1)).rejects.toMatchObject({ status: 400, code: 'OverBudget' })

    const closed = await voting.closeRound(round.id, { publish: false })
    expect(closed).toMatchObject({ closed: true, ballotsCast: 1, entries: 2 })
    const again = await voting.closeRound(round.id, { publish: false })
    expect(again.closed).toBe(false)
  })

  test('a quadratic round opens; the current round carries no counts', async ({ request }) => {
    const round = await voting.openRound(eventId, { closesAt: new Date(Date.now() + 3_600_000) })
    roundIds.add(round.id)
    quadraticRoundId = round.id
    expect(round).toMatchObject({ mechanism: 'quadratic', credits: 100, status: 'open', phase: 'pre-event' })

    const res = await api(request, 'GET', `/api/v1/events/${SLUG}/rounds/current`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('open')
    expect(body.round.id).toBe(round.id)
    expect(JSON.stringify(body)).not.toMatch(/"(votes|voters|ballotsCast|ballot_key|ballotKey)"/)

    // The key column is never selected: a second open is idempotent and returns the same round.
    const same = await voting.openRound(eventId, { closesAt: new Date(Date.now() + 3_600_000) })
    expect(same.id).toBe(round.id)
  })

  test('quadratic overspend is rejected; a change within budget is accepted', async ({ request }) => {
    const put = (sessionId: string, votes: number, cookie = cookies.voterA) =>
      api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookie, { sessionId, votes })

    let res = await put(S[0], 7) // 49
    expect(res.status(), await res.text()).toBe(200)
    res = await put(S[1], 7) // 98
    expect(res.status()).toBe(200)
    expect((await res.json()).spent).toBe(98)

    res = await put(S[2], 2) // would be 102
    expect(res.status()).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'OverBudget' })

    let mine = await (await api(request, 'GET', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA)).json()
    expect(mine.allocation).toEqual({ [S[0]]: 7, [S[1]]: 7 })
    expect(mine).toMatchObject({ spent: 98, remaining: 2, budget: 100, canVote: true, sealed: false })

    res = await put(S[0], 5) // 25 + 49 = 74
    expect(res.status()).toBe(200)
    res = await put(S[2], 2) // 78
    expect(res.status()).toBe(200)
    res = await put(S[3], 4) // 94
    expect(res.status()).toBe(200)
    mine = await res.json()
    expect(mine.allocation).toEqual({ [S[0]]: 5, [S[1]]: 7, [S[2]]: 2, [S[3]]: 4 })
    expect(mine.spent).toBe(94)
    expect(mine.sessions.map((s: { id: string }) => s.id).sort()).toEqual([S[0], S[1], S[2], S[3]].sort())

    // votes = 0 removes, and the budget frees up.
    res = await put(S[2], 0)
    expect((await res.json()).allocation[S[2]]).toBeUndefined()
    res = await put(S[2], 2)
    expect((await res.json()).spent).toBe(94)
  })

  test('non-members, signed-out and cross-origin writes are refused; unvotable sessions too', async ({ request }) => {
    const body = { sessionId: S[0], votes: 1 }
    let res = await api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.outsider, body)
    expect(res.status()).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'NotMember' })
    await expect(voting.setAllocation(eventId, ids.outsider, S[0], 1)).rejects.toMatchObject({ status: 403 })

    res = await api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, undefined, body)
    expect(res.status()).toBe(401)

    res = await request.fetch(`${base}/api/v1/events/${SLUG}/votes/mine`, {
      method: 'PUT',
      headers: { cookie: cookies.voterA, origin: 'https://evil.example' },
      data: body,
    })
    expect(res.status()).toBe(403)

    res = await api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA, { sessionId: S[4], votes: 1 })
    expect(res.status()).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'SessionNotVotable' })
    res = await api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA, { sessionId: S[5], votes: 1 })
    expect(res.status()).toBe(403)
    res = await api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA, { sessionId: randomUUID(), votes: 1 })
    expect(res.status()).toBe(404)
  })

  test('a ticketed gathering requires a confirmed ticket in a voting tier', async () => {
    class Rollback extends Error {}
    await raw
      .begin(async (t) => {
        await t`update events set ticketing_enabled = true where id = ${eventId}`
        const [tier] = await t<{ id: string }[]>`
          insert into ticket_tiers (event_id, name, allows_voting) values (${eventId}, 'pkgc tier', true) returning id
        `
        const before = await voting.checkEligibility(t as never, eventId, ids.B)
        expect(before).toMatchObject({ eligible: false, code: 'TicketRequired' })
        await t`insert into tickets (event_id, tier_id, user_id, status) values (${eventId}, ${tier.id}, ${ids.B}, 'confirmed')`
        const after = await voting.checkEligibility(t as never, eventId, ids.B)
        expect(after.eligible).toBe(true)
        throw new Rollback()
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e
      })
  })

  test('tallies and organizer results are sealed (409) while the round is open', async ({ request }) => {
    const tallyUrl = `/api/v1/events/${SLUG}/rounds/${quadraticRoundId}/tally`
    const resultsUrl = `/api/v1/events/${SLUG}/rounds/${quadraticRoundId}/results`
    for (const cookie of [undefined, cookies.voterA, cookies.org]) {
      const res = await api(request, 'GET', tallyUrl, cookie)
      expect(res.status()).toBe(409)
      expect(await res.json()).toMatchObject({ error: 'RoundOpen' })
    }
    let res = await api(request, 'GET', resultsUrl, cookies.org)
    expect(res.status()).toBe(409)
    expect(await res.json()).toMatchObject({ error: 'RoundOpen' })
    res = await api(request, 'GET', resultsUrl, cookies.voterA)
    expect(res.status()).toBe(403)
    res = await api(request, 'GET', resultsUrl)
    expect(res.status()).toBe(401)

    await expect(voting.organizerResults(eventId)).rejects.toMatchObject({ code: 'RoundOpen' })
    await expect(voting.schedulingInputs(eventId)).rejects.toMatchObject({ code: 'RoundOpen' })
    await expect(voting.publicTally(eventId)).rejects.toMatchObject({ code: 'RoundOpen' })
  })

  test('concurrent allocations by one voter cannot overspend or lose writes', async ({ request }) => {
    // Library level: four parallel writes of 6 votes (36 credits each) into 100 credits.
    const settled = await Promise.allSettled([S[0], S[1], S[2], S[3]].map((sid) => voting.setAllocation(eventId, ids.C, sid, 6)))
    const ok = settled.filter((s) => s.status === 'fulfilled').length
    const refused = settled.filter((s) => s.status === 'rejected')
    expect(ok).toBe(2)
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'OverBudget' })
    const [ledgerC] = await raw<{ allocated: Record<string, number>; spent: number }[]>`
      select allocated, spent from credit_ledger where round_id = ${quadraticRoundId} and account_id = ${ids.C}
    `
    expect(Object.keys(ledgerC.allocated)).toHaveLength(2)
    expect(ledgerC.spent).toBe(72)

    // HTTP level. voterA holds S1=5 (25), S2=7 (49), S3=2 (4), S4=4 (16) = 94; drop S2 to 5 → 70.
    // Then S4→6 (+20 → 90) and S3→5 (+21 → 91) each fit alone; together (111) they do not.
    const lower = await api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA, { sessionId: S[1], votes: 5 })
    expect((await lower.json()).spent).toBe(70)
    const [a, b] = await Promise.all([
      api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA, { sessionId: S[3], votes: 6 }),
      api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA, { sessionId: S[2], votes: 5 }),
    ])
    expect([a.status(), b.status()].sort()).toEqual([200, 400])
    const winner = a.status() === 200 ? await a.json() : await b.json()
    const [ledgerA] = await raw<{ spent: number; allocated: Record<string, number> }[]>`
      select spent, allocated from credit_ledger where round_id = ${quadraticRoundId} and account_id = ${ids.voterA}
    `
    expect(ledgerA.spent).toBe(winner.spent)
    expect(ledgerA.spent).toBeLessThanOrEqual(100)
    expect(ledgerA.allocated).toEqual(winner.allocation)

    // The exact pair: B starts at S1=8 (64); S2=5 (+25 → 89) and S3=6 (+36 → 100) each fit, both (125) do not.
    await voting.setAllocation(eventId, ids.B, S[0], 8)
    const pair = await Promise.allSettled([voting.setAllocation(eventId, ids.B, S[1], 5), voting.setAllocation(eventId, ids.B, S[2], 6)])
    expect(pair.filter((p) => p.status === 'fulfilled')).toHaveLength(1)
    const [ledgerB] = await raw<{ spent: number; allocated: Record<string, number> }[]>`
      select spent, allocated from credit_ledger where round_id = ${quadraticRoundId} and account_id = ${ids.B}
    `
    expect(ledgerB.spent).toBeLessThanOrEqual(100)
    expect(Object.keys(ledgerB.allocated)).toHaveLength(2)
  })

  test('closing: ledger gone, key destroyed, entries unlinkable to accounts but linked to each other, results = sums, k-suppression', async ({ request }) => {
    // Shape a known distribution: S1 has 3 voters (A, B, C); S4 has 1 (A only).
    await voting.setAllocation(eventId, ids.B, S[0], 1)
    await voting.setAllocation(eventId, ids.B, S[3], 0)
    await voting.setAllocation(eventId, ids.C, S[3], 0)
    await voting.setAllocation(eventId, ids.C, S[0], 1)
    // An empty ledger row casts no ballot.
    await voting.setAllocation(eventId, ids.D, S[0], 1)
    await voting.setAllocation(eventId, ids.D, S[0], 0)

    const ledger = await raw<{ account_id: string; allocated: Record<string, number> }[]>`
      select account_id, allocated from credit_ledger where round_id = ${quadraticRoundId}
    `
    const byAccount = new Map(ledger.map((l) => [l.account_id, l.allocated]))
    expect(byAccount.get(ids.D)).toEqual({})
    const voters = ledger.filter((l) => Object.keys(l.allocated).length > 0)
    expect(voters.map((v) => v.account_id).sort()).toEqual([ids.voterA, ids.B, ids.C].sort())
    const signature = (alloc: Record<string, number>) =>
      Object.entries(alloc).sort(([x], [y]) => x.localeCompare(y)).map(([k, v]) => `${k}:${v}`).join('|')
    const expectedSignatures = voters.map((v) => signature(v.allocated)).sort()
    const expected = new Map<string, { voters: number; votes: number; credits: number }>()
    for (const v of voters) {
      for (const [sid, n] of Object.entries(v.allocated)) {
        const agg = expected.get(sid) ?? { voters: 0, votes: 0, credits: 0 }
        agg.voters += 1
        agg.votes += n
        agg.credits += n * n
        expected.set(sid, agg)
      }
    }
    expect(expected.get(S[0])?.voters).toBe(3)
    expect(expected.get(S[3])?.voters).toBe(1)

    // Due now; the job closes it.
    await raw`update vote_rounds set opens_at = now() - interval '2 hours', closes_at = now() - interval '1 second' where id = ${quadraticRoundId}`
    const job = await api(request, 'GET', `/api/jobs/close-rounds`)
    expect(job.status(), await job.text()).toBe(200)
    const jobBody = await job.json()
    expect(jobBody.rounds.closed.map((r: { roundId: string }) => r.roundId)).toContain(quadraticRoundId)

    const [round] = await raw<{ key_null: boolean; finalized: boolean; ledger: number; ballots: number }[]>`
      select ballot_key is null as key_null, finalized_at is not null as finalized,
             (select count(*) from credit_ledger where round_id = ${quadraticRoundId})::int as ledger,
             (select count(*) from vote_ballots where round_id = ${quadraticRoundId})::int as ballots
      from vote_rounds where id = ${quadraticRoundId}
    `
    expect(round).toEqual({ key_null: true, finalized: true, ledger: 0, ballots: 3 })

    // Entries: a day, no account; tokens group one voter's entries exactly as their ledger did.
    const entries = await raw<{ session_id: string; votes: number; credits: number; day: string; token: string }[]>`
      select session_id, votes, credits, day::text as day, encode(ballot_token, 'hex') as token
      from vote_entries where round_id = ${quadraticRoundId}
    `
    const today = new Date().toISOString().slice(0, 10)
    for (const e of entries) {
      expect(e.day).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect([today, new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)]).toContain(e.day)
      expect(e.credits).toBe(e.votes * e.votes)
    }
    const byToken = new Map<string, Record<string, number>>()
    for (const e of entries) byToken.set(e.token, { ...(byToken.get(e.token) ?? {}), [e.session_id]: e.votes })
    expect([...byToken.values()].map(signature).sort()).toEqual(expectedSignatures)
    const tokens = [...byToken.keys()]
    const ballotTokens = await raw<{ token: string }[]>`select encode(token, 'hex') as token from vote_ballots where round_id = ${quadraticRoundId}`
    expect(ballotTokens.map((b) => b.token).sort()).toEqual([...tokens].sort())

    // No table maps a token to an account: search every bytea column outside the ballot tables.
    const byteaColumns = await raw<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and data_type = 'bytea'
        and not (table_name = 'vote_ballots' and column_name = 'token')
        and not (table_name = 'vote_entries' and column_name = 'ballot_token')
        and table_name in (select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE')
    `
    const tokenBytes = tokens.map((t) => Buffer.from(t, 'hex'))
    for (const c of byteaColumns) {
      const [hit] = await raw<{ n: number }[]>`
        select count(*)::int as n from ${raw(c.table_name)} where ${raw(c.column_name)} in ${raw(tokenBytes)}
      `
      expect(hit.n, `${c.table_name}.${c.column_name}`).toBe(0)
    }
    // …and no text column carries a token's hex either.
    const textColumns = await raw<{ table_name: string; column_name: string }[]>`
      select c.table_name, c.column_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema = 'public' and c.data_type in ('text', 'character varying')
    `
    for (const c of textColumns) {
      const [hit] = await raw<{ n: number }[]>`
        select count(*)::int as n from ${raw(c.table_name)} where ${raw(c.column_name)} in ${raw(tokens)}
      `
      expect(hit.n, `${c.table_name}.${c.column_name}`).toBe(0)
    }
    // The ballot tables themselves hold no account id anywhere in their rows.
    const accountIds = [ids.voterA, ids.B, ids.C]
    const ballotsBlob = JSON.stringify(await raw`select * from vote_ballots where round_id = ${quadraticRoundId}`)
    const entriesBlob = JSON.stringify(await raw`select * from vote_entries where round_id = ${quadraticRoundId}`)
    for (const id of accountIds) {
      expect(ballotsBlob).not.toContain(id)
      expect(entriesBlob).not.toContain(id)
    }

    // Results equal the sums; every votable session is present, zero-voter ones at 0.
    const results = await raw<{ session_id: string; voters: number; votes: number; credits: number }[]>`
      select session_id, voters, votes, credits from vote_round_results where round_id = ${quadraticRoundId}
    `
    const resultMap = new Map(results.map((r) => [r.session_id, r]))
    for (const sid of [S[0], S[1], S[2], S[3]]) {
      const want = expected.get(sid) ?? { voters: 0, votes: 0, credits: 0 }
      expect(resultMap.get(sid), sid).toMatchObject(want)
    }
    expect(resultMap.has(S[4])).toBe(false)
    expect(resultMap.has(S[5])).toBe(false)

    // Organizer results over HTTP, now allowed.
    const org = await api(request, 'GET', `/api/v1/events/${SLUG}/rounds/${quadraticRoundId}/results`, cookies.org)
    expect(org.status(), await org.text()).toBe(200)
    const orgBody = await org.json()
    expect(orgBody.results.find((r: { sessionId: string }) => r.sessionId === S[0])).toMatchObject(expected.get(S[0])!)

    // Scheduling inputs: tokens (hex) per session, no ids of people.
    const inputs = await voting.schedulingInputs(eventId, { roundId: quadraticRoundId })
    expect(inputs.bySession.get(S[0])?.tokens.size).toBe(3)
    expect(inputs.bySession.get(S[0])?.votes).toBe(expected.get(S[0])!.votes)

    // Public tally: k = 3 → S1 counted, S2..S4 (< 3 voters) suppressed with NO counts.
    const tally = await api(request, 'GET', `/api/v1/events/${SLUG}/rounds/${quadraticRoundId}/tally`)
    expect(tally.status(), await tally.text()).toBe(200)
    const t = await tally.json()
    expect(t.k).toBe(3)
    expect(t.ballotsCast).toBe(3)
    const s1 = t.entries.find((e: { sessionId: string }) => e.sessionId === S[0])
    expect(s1).toEqual({ sessionId: S[0], suppressed: false, ...expected.get(S[0]) })
    for (const sid of [S[1], S[2], S[3]]) {
      const e = t.entries.find((x: { sessionId: string }) => x.sessionId === sid)
      expect(e, sid).toEqual({ sessionId: sid, suppressed: true })
      expect(Object.keys(e)).not.toContain('votes')
      expect(Object.keys(e)).not.toContain('voters')
    }
    expect(JSON.stringify(t)).not.toContain(ids.voterA)

    // k = 1 would reveal S4's single voter; the library applies whatever k it is given.
    const loose = await voting.publicTally(eventId, 1, { roundId: quadraticRoundId })
    expect(loose?.entries.find((e) => e.sessionId === S[3])).toMatchObject({ suppressed: false, voters: 1 })

    // After close: no writes, and the voter's own allocation no longer exists.
    const late = await api(request, 'PUT', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA, { sessionId: S[0], votes: 1 })
    expect(late.status()).toBe(409)
    const mine = await (await api(request, 'GET', `/api/v1/events/${SLUG}/votes/mine`, cookies.voterA)).json()
    expect(mine).toMatchObject({ status: 'closed', sealed: true, allocation: {}, canVote: false })
  })

  test('the round closes when the event leaves the voting phase', async () => {
    const round = await voting.openRound(eventId, { closesAt: new Date(Date.now() + 3_600_000) })
    roundIds.add(round.id)
    await voting.setAllocation(eventId, ids.B, S[0], 2)
    // Pausing (back to proposals) keeps it sealed but alive and read-only.
    await raw`update events set status = 'proposals_open' where id = ${eventId}`
    expect((await voting.roundState(eventId)).status).toBe('open')
    await expect(voting.setAllocation(eventId, ids.B, S[0], 3)).rejects.toMatchObject({ status: 409 })
    // Moving on to scheduling closes it.
    await raw`update events set status = 'scheduling' where id = ${eventId}`
    const state = await voting.roundState(eventId)
    expect(state).toMatchObject({ status: 'closed' })
    expect(state.round?.id).toBe(round.id)
    const [row] = await raw<{ key_null: boolean }[]>`select ballot_key is null as key_null from vote_rounds where id = ${round.id}`
    expect(row.key_null).toBe(true)
    await raw`update events set status = 'voting_open' where id = ${eventId}`
  })

  test('feedback ballots: one mutable response per person while open; sealed, re-keyed and k-suppressed after close', async ({ request }) => {
    // S2 and S3 become scheduled self-hosted sessions that started an hour ago.
    for (const sid of [S[1], S[2]]) {
      await raw`
        update sessions set status = 'scheduled', is_self_hosted = true,
          self_hosted_start_time = now() - interval '60 minutes', self_hosted_end_time = now() - interval '30 minutes'
        where id = ${sid}
      `
    }
    const url = (sid: string) => `/api/v1/events/${SLUG}/sessions/${sid}/feedback`

    let res = await api(request, 'POST', url(S[1]), cookies.voterA, { rating: 4, comment: 'first thoughts', would_attend_again: true })
    expect(res.status(), await res.text()).toBe(200)
    res = await api(request, 'POST', url(S[1]), cookies.voterA, { rating: 5, comment: 'changed my mind', would_attend_again: true })
    expect(res.status()).toBe(200)
    const view = await (await api(request, 'GET', url(S[1]), cookies.voterA)).json()
    expect(view.window.status).toBe('open')
    expect(view.own).toEqual({ rating: 5, comment: 'changed my mind', would_attend_again: true })
    expect(view.summary).toMatchObject({ released: false })
    expect(view.summary.count).toBeUndefined()

    // The host cannot rate their own session; a non-member cannot rate at all.
    res = await api(request, 'POST', url(S[1]), cookies.org, { rating: 5 })
    expect(res.status()).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'SelfFeedback' })
    res = await api(request, 'POST', url(S[1]), cookies.outsider, { rating: 1 })
    expect(res.status()).toBe(403)
    res = await api(request, 'POST', url(S[1]), cookies.voterA, { rating: 9 })
    expect(res.status()).toBe(400)

    await voting.submitFeedback(ids.B, S[1], { rating: 2, comment: 'too fast' })
    const [counts] = await raw<{ ballots: number; entries: number }[]>`
      select (select count(*) from feedback_ballots where session_id = ${S[1]})::int as ballots,
             (select count(*) from feedback_entries where session_id = ${S[1]})::int as entries
    `
    expect(counts).toEqual({ ballots: 2, entries: 2 })

    // S3 reaches k = 3.
    await voting.submitFeedback(ids.voterA, S[2], { rating: 4, comment: 'great demo', wouldAttendAgain: true })
    await voting.submitFeedback(ids.B, S[2], { rating: 5, wouldAttendAgain: true })
    await voting.submitFeedback(ids.C, S[2], { rating: 3, comment: 'ok', wouldAttendAgain: false })
    // Withdrawal while open removes the ballot and the entry.
    await voting.submitFeedback(ids.D, S[2], { rating: 1 })
    expect(await voting.retractFeedback(ids.D, S[2])).toEqual({ removed: true })

    const idsBefore = (await raw<{ id: string }[]>`select id from feedback_entries where session_id in ${raw([S[1], S[2]])}`).map((r) => r.id)

    // Close both windows through the job.
    await raw`
      update feedback_windows set opens_at = now() - interval '5 hours', closes_at = now() - interval '1 second'
      where session_id in ${raw([S[1], S[2]])}
    `
    const job = await api(request, 'GET', `/api/jobs/close-rounds`)
    expect(job.status()).toBe(200)
    expect((await job.json()).feedback.closed).toBeGreaterThanOrEqual(2)

    const windows = await raw<{ key_null: boolean; finalized: boolean }[]>`
      select ballot_key is null as key_null, finalized_at is not null as finalized from feedback_windows where session_id in ${raw([S[1], S[2]])}
    `
    expect(windows).toEqual([{ key_null: true, finalized: true }, { key_null: true, finalized: true }])
    const idsAfter = (await raw<{ id: string }[]>`select id from feedback_entries where session_id in ${raw([S[1], S[2]])}`).map((r) => r.id)
    expect(idsAfter).toHaveLength(5)
    for (const id of idsAfter) expect(idsBefore).not.toContain(id)

    // Under k (2 < 3): nothing, even for the host/organizer.
    const under = await (await api(request, 'GET', url(S[1]), cookies.org)).json()
    expect(under.window.status).toBe('closed')
    expect(under.summary).toEqual({ k: 3, released: false })
    expect(under.own).toBeNull()

    // At k: numbers for everyone, comments only for hosts/organizers, no ratings or dates on them.
    const organizerView = await (await api(request, 'GET', url(S[2]), cookies.org)).json()
    expect(organizerView.summary).toMatchObject({ k: 3, released: true, count: 3, avgRating: 4, wouldAttendAgain: { yes: 2, no: 1 } })
    expect([...organizerView.summary.comments].sort()).toEqual(['great demo', 'ok'])
    const attendeeView = await (await api(request, 'GET', url(S[2]), cookies.voterA)).json()
    expect(attendeeView.summary).toMatchObject({ released: true, count: 3 })
    expect(attendeeView.summary.comments).toBeUndefined()
    expect(attendeeView.own).toBeNull()

    // Sealed: no more edits or withdrawals.
    res = await api(request, 'DELETE', url(S[2]), cookies.voterA)
    expect(res.status()).toBe(409)
    res = await api(request, 'POST', url(S[2]), cookies.voterA, { rating: 1 })
    expect(res.status()).toBe(409)
  })
})
