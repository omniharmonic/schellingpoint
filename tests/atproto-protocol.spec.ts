import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { randomUUID } from 'node:crypto'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, randomTag, type TestAccount, type TestGathering } from './helpers/gathering'

// Protocol hygiene of the ATProto layer, against the REAL local PDS where the point is the protocol:
//   - #account frames: an admin takedown hides a proposer's records everywhere, reversal restores
//   - #identity frames: handles re-verified both ways; an unverifiable handle is stored as NULL
//   - 429 / RateLimit-Reset backoff with a wait budget, per-repo pacing
//   - resumable bulk schedule publish jobs, applyWrites batching under the per-call cap
//   - Jetstream records with side effects are verified against the author's own PDS
loadEnvConfig(process.cwd(), true)
// The local stack's PLC (deploy/local/compose.yml): our accounts' DID documents are re-read from it.
process.env.PDS_PLC_URL ||= 'http://localhost:2582'

const base = 'http://localhost:3001'
const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const adminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const configured = Boolean(migrationUrl && pds && adminPassword && process.env.DATABASE_URL && process.env.ATPROTO_CUSTODY_KEY)

type Resolver = (request: string, ...rest: unknown[]) => string
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = moduleWithResolver._resolveFilename
const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
}
/* eslint-disable @typescript-eslint/no-require-imports */
const rateLimit = require('../src/lib/atproto/rate-limit') as typeof import('../src/lib/atproto/rate-limit')
const { XRPCError } = require('@atproto/xrpc') as typeof import('@atproto/xrpc')
/* eslint-enable @typescript-eslint/no-require-imports */

const PROPOSAL = 'schellingpoint.draft.proposal'
const CID_BOGUS = 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe'

async function adminXrpc(nsid: string, body: unknown): Promise<Response> {
  return fetch(`${pds}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`admin:${adminPassword}`).toString('base64')}` },
    body: JSON.stringify(body),
  })
}

async function setTakedown(did: string, applied: boolean): Promise<void> {
  const res = await adminXrpc('com.atproto.admin.updateSubjectStatus', {
    subject: { $type: 'com.atproto.admin.defs#repoRef', did },
    takedown: { applied, ...(applied ? { ref: `protocol-test-${randomTag(4)}` } : {}) },
  })
  expect(res.status, await res.clone().text()).toBe(200)
}

test.describe.configure({ mode: 'serial', retries: 0 })

/* ───────────────────────────── rate limits (no I/O) ───────────────────────────── */

test.describe('rate-limit backoff', () => {
  const rateLimited = (resetInMs: number, now = Date.now()) =>
    new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded', {
      'ratelimit-limit': '5000',
      'ratelimit-remaining': '0',
      'ratelimit-reset': String(Math.ceil((now + resetInMs) / 1000)),
      'retry-after': String(Math.ceil(resetInMs / 1000)),
    })

  test('RateLimit-Reset (epoch seconds) and Retry-After are read case-insensitively', () => {
    const now = 1_789_000_000_000
    expect(rateLimit.retryAfterMsFromHeaders({ 'RateLimit-Reset': String(now / 1000 + 30) }, now)).toBe(30_000)
    expect(rateLimit.retryAfterMsFromHeaders({ 'retry-after': '12' }, now)).toBe(12_000)
    expect(rateLimit.retryAfterMsFromHeaders({ 'ratelimit-reset': '5' }, now)).toBe(5_000) // a delta, not an epoch
    expect(rateLimit.retryAfterMsFromHeaders({}, now)).toBeNull()
    expect(rateLimit.classifyXrpcError(rateLimited(1000))).toBe('rate-limit')
    expect(rateLimit.classifyXrpcError(new XRPCError(502, 'UpstreamFailure'))).toBe('transient')
    expect(rateLimit.classifyXrpcError(new XRPCError(400, 'InvalidSwap'))).toBe('other')
  })

  test('a write rate-limited twice succeeds once the reset passes; a reset beyond the budget is a typed error', async () => {
    // A fake XRPC agent: 429 with RateLimit-Reset twice, then success — through write.ts putRecord.
    const write = require('../src/lib/atproto/write') as typeof import('../src/lib/atproto/write')
    let calls = 0
    const agent = {
      com: {
        atproto: {
          repo: {
            putRecord: async (input: { repo: string; collection: string; rkey: string }) => {
              calls++
              if (calls <= 2) throw rateLimited(400)
              return { data: { uri: `at://${input.repo}/${input.collection}/${input.rkey}`, cid: CID_BOGUS } }
            },
          },
        },
      },
    } as unknown as import('@atproto/api').Agent
    const started = Date.now()
    const out = await write.putRecord(agent, {
      repo: `did:plc:ratelimit${randomTag(15)}`,
      collection: 'schellingpoint.draft.track',
      rkey: 'ratelimited1',
      record: { name: 'Paced', createdAt: '2026-09-14T12:00:00.000Z' },
      skipLocalValidation: true,
    })
    expect(out.cid).toBe(CID_BOGUS)
    expect(calls).toBe(3)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300) // it waited for the reset, twice

    // Fake clock: a reset an hour away never fits a 60 s budget — fail at once, typed, with retryAfter.
    let clock = 1_789_000_000_000
    const slept: number[] = []
    let attempts = 0
    const err = await rateLimit
      .withXrpcBackoff(
        async () => {
          attempts++
          throw rateLimited(3_600_000, clock)
        },
        { now: () => clock, sleep: async (ms) => void slept.push((clock += ms)), random: () => 0.5 },
      )
      .catch((e) => e)
    expect(rateLimit.isRateLimitBudgetExceeded(err)).toBe(true)
    expect(err).toBeInstanceOf(rateLimit.RateLimitBudgetExceededError)
    expect(err.retryAfterMs).toBeGreaterThan(3_500_000)
    expect(attempts).toBe(1)
    expect(slept).toEqual([])

    // Short resets repeatedly: waits accumulate until the budget is spent, then the typed error.
    clock = 1_789_000_000_000
    const budgetErr = await rateLimit
      .withXrpcBackoff(async () => { throw rateLimited(20_000, clock) }, { maxTotalWaitMs: 60_000, now: () => clock, sleep: async (ms) => void (clock += ms), random: () => 0 })
      .catch((e) => e)
    expect(budgetErr).toBeInstanceOf(rateLimit.RateLimitBudgetExceededError)
    expect(budgetErr.waitedMs).toBeGreaterThanOrEqual(40_000)
    expect(budgetErr.waitedMs).toBeLessThanOrEqual(60_000)

    // 5xx is retried a few times; a CAS answer never is.
    let fiveHundreds = 0
    await expect(
      rateLimit.withXrpcBackoff(async () => { fiveHundreds++; throw new XRPCError(502, 'UpstreamFailure') }, { sleep: async () => undefined }),
    ).rejects.toMatchObject({ error: 'UpstreamFailure' })
    expect(fiveHundreds).toBe(4)
    let swaps = 0
    await expect(rateLimit.withXrpcBackoff(async () => { swaps++; throw new XRPCError(400, 'InvalidSwap') }, { sleep: async () => undefined })).rejects.toMatchObject({ error: 'InvalidSwap' })
    expect(swaps).toBe(1)
  })

  test('the per-repo pacer serialises writes and keeps a repo under its points budget', async () => {
    let clock = 0
    const pacer = new rateLimit.RepoWritePacer({ hourPoints: 10, dayPoints: 100, maxWaitMs: 60_000, now: () => clock, sleep: async (ms) => void (clock += ms) })
    let inFlight = 0
    let maxInFlight = 0
    const job = () => pacer.run('did:plc:pacer', 3, async () => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
    })
    await Promise.all([job(), job(), job()])
    expect(maxInFlight).toBe(1)
    expect(pacer.spentIn('did:plc:pacer', 3_600_000)).toBe(9)
    // A fourth create would exceed 10 points in the hour: the pacer waits for the oldest to age out,
    // and a wait longer than its budget is the typed error instead.
    expect(pacer.waitFor('did:plc:pacer', 3)).toBe(3_600_000)
    await expect(pacer.run('did:plc:pacer', 3, async () => undefined)).rejects.toBeInstanceOf(rateLimit.RateLimitBudgetExceededError)
    expect(rateLimit.chunk(Array.from({ length: 450 }, (_, i) => i), 1000).map((c) => c.length)).toEqual([200, 200, 50])
  })
})

/* ───────────────────────────── database + PDS ───────────────────────────── */

test.describe('protocol against the local stack', () => {
  test.skip(!configured, 'DATABASE_URL / PDS / custody key are not configured')

  let raw: postgres.Sql
  let db: typeof import('../src/lib/db')
  let ingest: typeof import('../src/lib/atproto/ingest')
  let store: typeof import('../src/lib/atproto/index-store')
  let participant: typeof import('../src/lib/atproto/participant')
  let publish: typeof import('../src/lib/atproto/publish')
  let jobs: typeof import('../src/lib/atproto/publish-jobs')
  let agentMod: typeof import('../src/lib/atproto/agent')
  let writeMod: typeof import('../src/lib/atproto/write')
  const gatherings: TestGathering[] = []
  const accounts: TestAccount[] = []
  const extraAccountIds: string[] = []
  const trackedDids: string[] = []

  test.beforeAll(async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    db = require('../src/lib/db')
    ingest = require('../src/lib/atproto/ingest')
    store = require('../src/lib/atproto/index-store')
    participant = require('../src/lib/atproto/participant')
    publish = require('../src/lib/atproto/publish')
    jobs = require('../src/lib/atproto/publish-jobs')
    agentMod = require('../src/lib/atproto/agent')
    writeMod = require('../src/lib/atproto/write')
    /* eslint-enable @typescript-eslint/no-require-imports */
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })
  })

  test.afterAll(async () => {
    if (raw) {
      for (const did of trackedDids) {
        await raw`delete from at_repo_status where did = ${did}`
        await raw`delete from at_repo_state where did = ${did}`
      }
      for (const g of gatherings) await g.cleanup().catch(() => undefined)
      for (const a of accounts) await a.cleanup().catch(() => undefined)
      if (extraAccountIds.length) await raw`delete from accounts where id = any(${extraAccountIds}::uuid[])`
      await raw.end({ timeout: 5 })
    }
    await db?.sql.end({ timeout: 5 }).catch(() => undefined)
    moduleWithResolver._resolveFilename = originalResolve
  })

  /** An organiser row with no PDS account (notifications only). */
  async function organiser(eventId: string): Promise<string> {
    const [row] = await raw<{ id: string }[]>`
      insert into accounts (did, kind, email) values (${`did:plc:org${randomTag(21)}`}, 'custodial', ${`t-proto-org-${randomTag(8)}@example.test`}) returning id
    `
    extraAccountIds.push(row!.id)
    await raw`insert into event_members (event_id, user_id, role) values (${eventId}, ${row!.id}, 'owner')`
    return row!.id
  }

  async function proposalInGathering(label: string) {
    const gathering = await createTestGathering(raw, { tag: label, mintIdentity: true })
    gatherings.push(gathering)
    const author = await createTestAccount(`proto-${label}`, { sql: raw })
    accounts.push(author)
    trackedDids.push(author.did)
    const orgId = await organiser(gathering.id)
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${author.id}, 'attendee') on conflict do nothing`
    const [session] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status, session_type)
      values (${gathering.id}, ${`Protocol ${label} ${randomTag(4)}`}, 'A session whose proposer gets taken down', 'talk', 30, ${author.id}, 'pending', 'proposed')
      returning id
    `
    const published = await participant.publishProposal({ sessionId: session!.id, userId: author.id })
    return { gathering, author, orgId, sessionId: session!.id, proposalUri: published.uri }
  }

  async function recordsServed(slug: string): Promise<string[]> {
    const res = await fetch(`${base}/api/atproto/records?event=${slug}&collection=${PROPOSAL}`, { cache: 'no-store' })
    expect(res.status).toBe(200)
    return ((await res.json()) as Array<{ uri: string }>).map((r) => r.uri)
  }

  test('an admin takedown hides the proposer everywhere; reversing it restores them', async () => {
    test.setTimeout(120_000)
    const { gathering, author, orgId, sessionId, proposalUri } = await proposalInGathering('takedown')
    await raw`update sessions set status = 'approved' where id = ${sessionId}`
    expect(await recordsServed(gathering.slug)).toContain(proposalUri)

    await setTakedown(author.did, true)
    const frame = { did: author.did, time_us: Date.now() * 1000, kind: 'account', account: { active: false, did: author.did, seq: 1, time: new Date().toISOString(), status: 'takendown' } }
    const res = await ingest.processJetstreamFrame(frame, { forceTracked: true })
    expect(res).toMatchObject({ kind: 'account', outcome: 'applied', status: { hidden: true } })

    // The hourly sweep reaches the same answer from the PDS itself (getRepoStatus).
    const reconciled = await ingest.reconcileRepoForDid(author.did)
    expect(reconciled.status).toMatchObject({ active: false, status: 'takendown', hidden: true })
    const [status] = await raw<{ hidden: boolean; status: string; status_source: string }[]>`select hidden, status, status_source from at_repo_status where did = ${author.did}`
    expect(status).toMatchObject({ hidden: true, status: 'takendown', status_source: 'pds' })

    expect(await recordsServed(gathering.slug)).not.toContain(proposalUri)
    const [flagged] = await raw<{ author_inactive_at: Date | null }[]>`select author_inactive_at from sessions where id = ${sessionId}`
    expect(flagged!.author_inactive_at).not.toBeNull()
    const told = await raw<{ data: { kind?: string; sessionId?: string } }[]>`
      select data from notifications where user_id = ${orgId} and type = 'proposal_changed'
    `
    expect(told).toHaveLength(1) // once, even though the frame and the sweep both saw it
    expect(told[0]!.data).toMatchObject({ kind: 'author-inactive', sessionId })
    // The organiser queue no longer offers it for review while pending.
    await raw`update sessions set status = 'pending' where id = ${sessionId}`
    const program = require('../src/lib/scheduling/program') as typeof import('../src/lib/scheduling/program')
    expect((await program.listAdminSessions(gathering.id)).map((s) => s.id)).not.toContain(sessionId)
    await raw`update sessions set status = 'approved' where id = ${sessionId}`

    await setTakedown(author.did, false)
    const back = await ingest.processJetstreamFrame({ ...frame, time_us: Date.now() * 1000, account: { active: true, did: author.did, seq: 2, time: new Date().toISOString() } }, { forceTracked: true })
    expect(back).toMatchObject({ kind: 'account', outcome: 'applied', status: { hidden: false, changed: 'restored' } })
    expect(await recordsServed(gathering.slug)).toContain(proposalUri)
    const [restored] = await raw<{ author_inactive_at: Date | null }[]>`select author_inactive_at from sessions where id = ${sessionId}`
    expect(restored!.author_inactive_at).toBeNull()
  })

  test('an identity frame re-verifies the handle both ways; an unverifiable handle is stored as NULL', async () => {
    test.setTimeout(90_000)
    const author = await createTestAccount('proto-identity', { sql: raw })
    accounts.push(author)
    trackedDids.push(author.did)
    const domain = (process.env.PDS_HANDLE_DOMAIN || 'test').replace(/^\.+/, '')
    const newHandle = `pi${randomTag(10)}.${domain}`
    const agent = await agentMod.agentForDid(author.did)
    await agent.com.atproto.identity.updateHandle({ handle: newHandle })

    const frame = { did: author.did, time_us: Date.now() * 1000, kind: 'identity', identity: { did: author.did, handle: newHandle, seq: 1, time: new Date().toISOString() } }
    const res = await ingest.processJetstreamFrame(frame, { forceTracked: true })
    expect(res).toMatchObject({ kind: 'identity', outcome: 'applied', identity: { state: 'verified', handle: newHandle } })
    const [row] = await raw<{ handle: string | null; atproto_handle: string | null }[]>`
      select a.handle, p.atproto_handle from accounts a left join profiles p on p.id = a.id where a.id = ${author.id}
    `
    expect(row!.handle).toBe(newHandle)

    // A DID document claiming a handle that resolves to someone else: never trusted, stored NULL.
    const liar = { claimedHandle: async () => `impostor.${domain}`, resolveHandle: async () => 'did:plc:someoneelseentirely2345' }
    const lied = await ingest.processJetstreamFrame({ ...frame, identity: { ...frame.identity, handle: `impostor.${domain}` } }, { forceTracked: true, handleVerifier: liar })
    expect(lied).toMatchObject({ kind: 'identity', identity: { state: 'invalid', handle: null } })
    const [after] = await raw<{ handle: string | null }[]>`select handle from accounts where id = ${author.id}`
    expect(after!.handle).toBeNull()
    const [status] = await raw<{ handle: string | null }[]>`select handle from at_repo_status where did = ${author.did}`
    expect(status!.handle).toBeNull()

    // An unreadable DID document leaves stored handles alone.
    const down = { claimedHandle: async () => undefined, resolveHandle: async () => null }
    const unreadable = await ingest.processJetstreamFrame(frame, { forceTracked: true, handleVerifier: down })
    expect(unreadable).toMatchObject({ kind: 'identity', identity: { state: 'unresolvable' } })
  })

  test('a Jetstream proposal is applied only when it matches the author’s own PDS', async () => {
    test.setTimeout(90_000)
    const gathering = await createTestGathering(raw, { tag: 'verify', mintIdentity: true })
    gatherings.push(gathering)
    const author = await createTestAccount('proto-verify', { sql: raw })
    accounts.push(author)
    trackedDids.push(author.did)
    const [event] = await raw<{ gathering_uri: string | null; actor_did: string }[]>`select gathering_uri, actor_did from events where id = ${gathering.id}`
    const gatheringUri = event!.gathering_uri ?? `at://${event!.actor_did}/schellingpoint.draft.gathering/self`
    const record = { $type: PROPOSAL, gathering: gatheringUri, title: `Verified ${randomTag(5)}`, format: 'talk', durationMinutes: 30, createdAt: new Date().toISOString() }
    const rkey = `3lver${randomTag(8)}`
    const written = await writeMod.putRecord(await agentMod.agentForDid(author.did), { repo: author.did, collection: PROPOSAL, rkey, record })
    const frame = (cid: string, rec: Record<string, unknown>) => ({ did: author.did, time_us: Date.now() * 1000, kind: 'commit', commit: { rev: '3lrev', operation: 'create' as const, collection: PROPOSAL, rkey, cid, record: rec } })

    // A relay claiming a cid the author's PDS does not have: nothing applied, a reconcile requested.
    const forged = await ingest.processJetstreamFrame(frame(CID_BOGUS, record))
    expect(forged).toMatchObject({ kind: 'commit', result: { outcome: 'skipped:unverified' } })
    // The right cid with altered content is just as unverified.
    const tampered = await ingest.processJetstreamFrame(frame(written.cid, { ...record, title: 'Something the author never wrote' }))
    expect(tampered).toMatchObject({ kind: 'commit', result: { outcome: 'skipped:unverified' } })
    expect(await raw`select id from sessions where proposal_uri = ${written.uri}`).toHaveLength(0)
    expect(await store.getIndexedRecord(written.uri)).toBeNull()
    const [requested] = await raw<{ reconcile_requested_at: Date | null }[]>`select reconcile_requested_at from at_repo_state where did = ${author.did}`
    expect(requested!.reconcile_requested_at).not.toBeNull()

    const genuine = await ingest.processJetstreamFrame(frame(written.cid, record))
    expect(genuine).toMatchObject({ kind: 'commit', result: { outcome: 'indexed' } })
    const rows = await raw<{ status: string; host_did: string }[]>`select status, host_did from sessions where proposal_uri = ${written.uri}`
    expect(rows).toEqual([{ status: 'pending', host_did: author.did }])
    expect((await store.getIndexedRecord(written.uri))?.source).toBe('jetstream')

    // An index-only collection is indexed but marked unverified until reconciliation confirms it.
    const gatheringFrame = { did: event!.actor_did, time_us: Date.now() * 1000, kind: 'commit', commit: { rev: '3lrev', operation: 'update' as const, collection: 'freeschool.draft.policy', rkey: 'unverifiedpol', cid: CID_BOGUS, record: { $type: 'freeschool.draft.policy', title: 'Relay copy', version: '1', effectiveAt: new Date().toISOString(), createdAt: new Date().toISOString() } } }
    const indexOnly = await ingest.processJetstreamFrame(gatheringFrame)
    if (indexOnly?.kind === 'commit' && indexOnly.result.outcome === 'indexed') {
      expect((await store.getIndexedRecord(`at://${event!.actor_did}/freeschool.draft.policy/unverifiedpol`))?.source).toBe(ingest.UNVERIFIED_SOURCE)
    }

    // The drain serves the request (and the reconcile re-reads the repo from its PDS).
    const drained = await ingest.drainReconcileRequests(50)
    expect(drained.repos).toBeGreaterThanOrEqual(1)
    const [served] = await raw<{ reconcile_requested_at: Date | null }[]>`select reconcile_requested_at from at_repo_state where did = ${author.did}`
    expect(served!.reconcile_requested_at).toBeNull()
  })

  test('a publish of 30 sessions runs as a job, with progress, inside the applyWrites cap', async () => {
    test.setTimeout(120_000)
    const gathering = await createTestGathering(raw, { tag: 'bulkjob', withProgram: true })
    gatherings.push(gathering)
    const orgId = await organiser(gathering.id)
    const actorDid = `did:plc:bulk${randomTag(20)}`
    const slots = await raw<{ id: string; venue_id: string }[]>`
      select id, venue_id from time_slots where event_id = ${gathering.id} and not is_break order by start_time, venue_id limit 30
    `
    expect(slots).toHaveLength(30)
    for (const [i, slot] of slots.entries()) {
      await raw`
        insert into sessions (event_id, title, format, duration, host_id, status, session_type, time_slot_id, venue_id)
        values (${gathering.id}, ${`Bulk ${i}`}, 'talk', 30, ${orgId}, 'scheduled', 'proposed', ${slot.id}, ${slot.venue_id})
      `
    }
    expect(jobs.needsJob((await jobs.schedulableSessionIds(gathering.id)).length)).toBe(true)

    const MAX_OPS = 16
    const batches: number[] = []
    const puts: string[] = []
    const cid = (n: number) => `bafyrei${String(n).padStart(52, 'a')}`
    let n = 0
    const deps: import('../src/lib/atproto/publish').PublishDeps = {
      put: async (input) => {
        puts.push(input.collection)
        return { uri: `at://${actorDid}/${input.collection}/${input.rkey}`, cid: cid(++n), auditId: 'a' }
      },
      del: async () => ({ auditId: 'a' }),
      applyCreates: async (_eventId, inputs, opts) => {
        expect(opts.maxOps).toBe(MAX_OPS)
        batches.push(inputs.length)
        return inputs.map((i) => ({ uri: `at://${actorDid}/${i.collection}/${i.rkey}`, cid: cid(++n), auditId: 'a' }))
      },
      applyWritesMaxOps: MAX_OPS,
      getRecord: async () => null,
      actorDidFor: async () => actorDid,
      indexedCid: async () => null,
      persist: false,
    }

    const { job, created } = await jobs.enqueueSchedulePublish({ eventId: gathering.id, callerUserId: orgId })
    expect(created).toBe(true)
    expect(job).toMatchObject({ status: 'queued', total: 30, position: 0 })
    // Queueing again while it is live returns the same job.
    expect((await jobs.enqueueSchedulePublish({ eventId: gathering.id, callerUserId: orgId })).job.id).toBe(job.id)
    const progress: number[] = []
    const run = await jobs.runDuePublishJobs({ jobId: job.id, deps, onProgress: (p) => progress.push(p.position) })
    expect(run.jobs).toEqual([expect.objectContaining({ id: job.id, status: 'succeeded', position: 30, total: 30 })])
    expect(progress).toEqual([25, 30])

    const done = await jobs.getPublishJob(gathering.id, job.id)
    expect(done).toMatchObject({ status: 'succeeded', position: 30, published: 30, failed: 0 })
    expect(batches.length).toBeGreaterThan(0)
    expect(Math.max(...batches)).toBeLessThanOrEqual(MAX_OPS)
    // Every calendar event, config and slot was a batched create (90); only the stub proposals went one by one.
    expect(batches.reduce((a, b) => a + b, 0)).toBe(90)
    expect(puts.every((c) => c === PROPOSAL)).toBe(true)
    // A job for another gathering's id is not readable through this one.
    expect(await jobs.getPublishJob(randomUUID(), job.id)).toBeNull()
  })

  test('a rate-limited chunk re-queues the job at the reset instead of counting failures', async () => {
    const gathering = await createTestGathering(raw, { tag: 'ratejob', withProgram: true })
    gatherings.push(gathering)
    const orgId = await organiser(gathering.id)
    const slots = await raw<{ id: string; venue_id: string }[]>`select id, venue_id from time_slots where event_id = ${gathering.id} and not is_break order by start_time limit 2`
    for (const [i, slot] of slots.entries()) {
      await raw`insert into sessions (event_id, title, format, duration, host_id, status, session_type, time_slot_id, venue_id) values (${gathering.id}, ${`Rate ${i}`}, 'talk', 30, ${orgId}, 'scheduled', 'proposed', ${slot.id}, ${slot.venue_id})`
    }
    const limited = new rateLimit.RateLimitBudgetExceededError(90_000, 60_000, 'pds')
    const deps: import('../src/lib/atproto/publish').PublishDeps = {
      put: async () => { throw limited },
      del: async () => ({ auditId: 'a' }),
      applyCreates: async () => { throw limited },
      getRecord: async () => null,
      actorDidFor: async () => 'did:plc:ratelimitedjob2345678901',
      indexedCid: async () => null,
      persist: false,
    }
    const { job } = await jobs.enqueueSchedulePublish({ eventId: gathering.id, callerUserId: orgId })
    const run = await jobs.runDuePublishJobs({ jobId: job.id, deps })
    expect(run.jobs[0]).toMatchObject({ status: 'queued', position: 0 })
    const after = await jobs.getPublishJob(gathering.id, job.id)
    expect(after).toMatchObject({ status: 'queued', position: 0, failed: 0 })
    expect(new Date(after!.runAfter).getTime()).toBeGreaterThan(Date.now() + 60_000)
    await raw`update publish_jobs set status = 'cancelled' where id = ${job.id}`
  })

  test('applyWrites creates on the real PDS; a create of an existing record falls back to CAS', async () => {
    test.setTimeout(90_000)
    const gathering = await createTestGathering(raw, { tag: 'applyw', withProgram: true, mintIdentity: true })
    gatherings.push(gathering)
    const first = await publish.publishVenues({ eventId: gathering.id, callerUserId: null })
    expect(first.results.filter((r) => r.error)).toEqual([])
    expect(first.results).toHaveLength(3)
    const audits = await raw<{ reason: string }[]>`select reason from at_audit where event_id = ${gathering.id} and action = 'publish-venue' and decision = 'allow'`
    expect(audits.filter((a) => /batched create/.test(a.reason))).toHaveLength(3)
    for (const r of first.results) {
      const live = await writeMod.getRecord(gathering.actorDid!, 'schellingpoint.draft.venue', r.uri!.split('/').pop()!)
      expect(live?.cid).toBe(r.cid)
    }

    // Forget what we wrote: the next publish believes the records do not exist and batches creates,
    // the PDS refuses the batch (the keys exist), and each venue falls back to a CAS'd putRecord.
    await raw`update venues set at_uri = null, at_cid = null where event_id = ${gathering.id}`
    await raw`delete from at_records where did = ${gathering.actorDid!} and collection = 'schellingpoint.draft.venue'`
    const again = await publish.publishVenues({ eventId: gathering.id, callerUserId: null })
    expect(again.results.filter((r) => r.error)).toEqual([])
    expect(again.results).toHaveLength(3)
    const [{ n }] = await raw<{ n: number }[]>`select count(*)::int as n from venues where event_id = ${gathering.id} and at_cid is not null`
    expect(n).toBe(3)
  })
})
