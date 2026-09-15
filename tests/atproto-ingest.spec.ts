import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

// Ingest against the local stack. Side-effect records (proposals, co-hosts) are REAL records in real
// custodial accounts' repos on the local PDS, and every frame goes through `processJetstreamFrame`,
// which re-reads the record from its author's PDS before anything is applied: relevance, validation,
// proposal linking, cid drift and withdrawal on the published schedule, double opt-in co-host
// pairing, and frames whose cid or content the PDS does not confirm. Pure parsing, the per-record
// error boundary and the monotonic cursor stay on the unverified inner functions.
loadEnvConfig(process.cwd(), true)

const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const configured = Boolean(migrationUrl && process.env.DATABASE_URL && process.env.PDS_URL && process.env.PDS_ADMIN_PASSWORD && process.env.ATPROTO_CUSTODY_KEY)

type Resolver = (request: string, ...rest: unknown[]) => string
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = moduleWithResolver._resolveFilename
const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const did = (label: string) => `did:plc:${`${label}${RUN}`.replace(/[^a-z2-7]/g, 'q').padEnd(24, 'q').slice(0, 24)}`
const STRANGER = did('ingeststranger')
const CID1 = 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe'
const PROPOSAL = 'schellingpoint.draft.proposal'
const COHOST = 'schellingpoint.draft.cohost'

function frame(repo: string, collection: string, rkey: string, operation: 'create' | 'update' | 'delete', record?: Record<string, unknown>, cid?: string) {
  return { did: repo, time_us: Date.now() * 1000, kind: 'commit' as const, commit: { rev: '3mvjrev', operation, collection, rkey, ...(record ? { record } : {}), ...(cid ? { cid } : {}) } }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('ingest', () => {
  test.skip(!configured, 'the local stack env (DATABASE_URL, DATABASE_MIGRATION_URL, PDS_URL, PDS_ADMIN_PASSWORD, ATPROTO_CUSTODY_KEY) is not set')
  test.setTimeout(120_000)

  let raw: postgres.Sql
  let ingest: typeof import('../src/lib/atproto/ingest')
  let store: typeof import('../src/lib/atproto/index-store')
  let agents: typeof import('../src/lib/atproto/agent')
  let write: typeof import('../src/lib/atproto/write')
  let db: typeof import('../src/lib/db')
  let gathering: TestGathering
  let gatheringUri = ''
  let author: TestAccount
  let cohost: TestAccount
  let organizerId = ''
  const organizerDid = did('ingestorg')
  const rkeyNew = `3ing${RUN}`.slice(0, 13).padEnd(13, 'a')
  const proposalUri = () => `at://${author.did}/${PROPOSAL}/${rkeyNew}`
  /** The cid of the proposal's latest version on the author's PDS. */
  let currentCid = ''

  const proposal = (overrides: Record<string, unknown> = {}) => ({
    $type: PROPOSAL, gathering: gatheringUri, title: `Ingest ${RUN}`, format: 'workshop', durationMinutes: 45, topics: ['atproto'], createdAt: '2026-09-14T12:00:00.000Z', ...overrides,
  })

  /** Write `record` into `who`'s own repo on the local PDS; the frame then carries exactly what the PDS holds. */
  async function put(who: TestAccount, collection: string, rkey: string, record: Record<string, unknown>) {
    const agent = await agents.agentForDid(who.did)
    const res = await write.putRecord(agent, { repo: who.did, collection, rkey, record })
    return { cid: res.cid, record: { ...record, $type: collection } }
  }

  async function remove(who: TestAccount, collection: string, rkey: string) {
    await write.deleteRecord(await agents.agentForDid(who.did), { repo: who.did, collection, rkey })
  }

  async function processCommit(f: ReturnType<typeof frame>) {
    const out = await ingest.processJetstreamFrame(f, { forceTracked: true })
    expect(out?.kind, JSON.stringify(out)).toBe('commit')
    return (out as Extract<NonNullable<typeof out>, { kind: 'commit' }>).result
  }

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    /* eslint-disable @typescript-eslint/no-require-imports */
    ingest = require('../src/lib/atproto/ingest')
    store = require('../src/lib/atproto/index-store')
    agents = require('../src/lib/atproto/agent')
    write = require('../src/lib/atproto/write')
    db = require('../src/lib/db')
    /* eslint-enable @typescript-eslint/no-require-imports */
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })

    gathering = await createTestGathering(raw, { tag: 'ingest', status: 'proposals_open', mintIdentity: true })
    gatheringUri = `at://${gathering.actorDid}/schellingpoint.draft.gathering/self`
    await raw`
      update events set gathering_uri = ${gatheringUri}, allowed_formats = ${['talk', 'workshop', 'discussion']}, allowed_durations = ${[30, 60]}
      where id = ${gathering.id}
    `
    const [organizer] = await raw<{ id: string }[]>`insert into accounts (did, kind, email) values (${organizerDid}, 'custodial', ${`f-ingest-org-${RUN}@example.test`}) returning id`
    organizerId = organizer!.id
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${organizerId}, 'owner')`

    author = await createTestAccount('ingest-author', { sql: raw })
    cohost = await createTestAccount('ingest-cohost', { sql: raw })
  })

  test.afterAll(async () => {
    try {
      if (raw) {
        await gathering?.cleanup()
        for (const a of [author, cohost]) await a?.cleanup()
        const dids = [author?.did, cohost?.did, STRANGER, organizerDid].filter(Boolean) as string[]
        await raw`delete from at_records where did = any(${dids}::text[])`
        await raw`delete from at_repo_state where did = any(${dids}::text[])`
        await raw`delete from at_repo_status where did = any(${dids}::text[])`
        await raw`delete from at_sync_cursor where source = ${`test:${RUN}`}`
        if (organizerId) await raw`delete from accounts where id = ${organizerId}`
        await raw.end({ timeout: 5 })
      }
    } finally {
      await db?.sql.end({ timeout: 5 }).catch(() => undefined)
      moduleWithResolver._resolveFilename = originalResolve
    }
  })

  test('the Jetstream URL asks for our collections and the borrowed ones we read', () => {
    const url = new URL(ingest.jetstreamSubscribeUrl(undefined, 1789000000000000))
    const wanted = url.searchParams.getAll('wantedCollections')
    for (const nsid of [PROPOSAL, 'community.lexicon.calendar.event', 'coop.lexicon.event.listing', 'freeschool.draft.approval', 'freeschool.draft.skill']) expect(wanted).toContain(nsid)
    expect(url.searchParams.get('cursor')).toBe('1789000000000000')
  })

  test('records that are not ours are not mirrored; invalid records are never indexed', async () => {
    // Both are decided before any PDS is asked: a stranger's proposal to a stranger's gathering…
    const elsewhere = await processCommit(frame(STRANGER, PROPOSAL, 'elsewhere1abc', 'create', proposal({ gathering: `at://${STRANGER}/schellingpoint.draft.gathering/self` }), CID1))
    expect(elsewhere.outcome).toBe('skipped:irrelevant')
    // …and a record that fails the lexicon.
    const invalid = await processCommit(frame(author.did, PROPOSAL, 'invalid1abcde', 'create', proposal({ durationMinutes: 2 }), CID1))
    expect(invalid.outcome).toBe('skipped:invalid')
    expect(await store.getIndexedRecord(`at://${author.did}/${PROPOSAL}/invalid1abcde`)).toBeNull()
    const skill = await processCommit(frame(STRANGER, 'freeschool.draft.skill', 'fake-skill', 'create', { id: 'fake-skill', label: 'Fake', status: 'canonical', createdAt: new Date().toISOString() }, CID1))
    expect(skill.outcome).toBe('skipped:irrelevant')
    // The unverified inner step only parses commits.
    expect(await ingest.ingestFromJetstreamFrame({ did: author.did, time_us: 1, kind: 'identity' })).toBeNull()
  })

  test('one malformed record fails alone and is reported, never thrown', async () => {
    const res = await ingest.ingestRecord({ uri: 'not-an-at-uri', did: author.did, collection: PROPOSAL, rkey: 'x', record: proposal(), source: 'test', operation: 'create', trusted: true })
    expect(res.outcome).toBe('error')
    expect(res.warnings.length).toBeGreaterThan(0)
  })

  test('a frame the author’s PDS does not confirm applies nothing', async () => {
    // A record that was never written to the author's repo.
    const ghostRkey = `3gh${RUN}`.slice(0, 13).padEnd(13, 'b')
    const ghost = await processCommit(frame(author.did, PROPOSAL, ghostRkey, 'create', proposal({ title: `Ghost ${RUN}` }), CID1))
    expect(ghost.outcome).toBe('skipped:unverified')
    expect(await store.getIndexedRecord(`at://${author.did}/${PROPOSAL}/${ghostRkey}`)).toBeNull()
    const [ghostSessions] = await raw<{ n: number }[]>`select count(*)::int as n from sessions where event_id = ${gathering.id}`
    expect(ghostSessions!.n).toBe(0)

    // A real record, but the frame's cid is not the one the PDS holds.
    const real = await put(author, PROPOSAL, ghostRkey, proposal({ title: `Real ${RUN}` }))
    const wrongCid = await processCommit(frame(author.did, PROPOSAL, ghostRkey, 'create', real.record, CID1))
    expect(wrongCid.outcome).toBe('skipped:unverified')
    // The right cid with content the PDS does not hold.
    const wrongValue = await processCommit(frame(author.did, PROPOSAL, ghostRkey, 'create', { ...real.record, title: `Forged ${RUN}` }, real.cid))
    expect(wrongValue.outcome).toBe('skipped:unverified')
    expect(await store.getIndexedRecord(`at://${author.did}/${PROPOSAL}/${ghostRkey}`)).toBeNull()
    const [n] = await raw<{ n: number }[]>`select count(*)::int as n from sessions where event_id = ${gathering.id}`
    expect(n!.n).toBe(0)
    const [told] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${organizerId}`
    expect(told!.n).toBe(0)
    // A reconcile of that repo was asked for instead.
    const [state] = await raw<{ requested: boolean }[]>`select reconcile_requested_at is not null as requested from at_repo_state where did = ${author.did}`
    expect(state?.requested).toBe(true)

    await remove(author, PROPOSAL, ghostRkey)
  })

  test('a proposal offered to a gathering we host becomes a pending session, linked to its author’s account by DID and naming no one', async () => {
    const created = await put(author, PROPOSAL, rkeyNew, proposal({ selfHosted: true, place: 'South Boulder', startsAt: '2026-10-01T16:00:00Z', endsAt: '2026-10-01T17:00:00Z' }))
    const res = await processCommit(frame(author.did, PROPOSAL, rkeyNew, 'create', created.record, created.cid))
    expect(res.outcome).toBe('indexed')
    expect(res.sideEffects.some((s) => s.startsWith('session-created'))).toBe(true)
    const [session] = await raw<{ status: string; host_id: string | null; host_name: string | null; host_did: string; duration: number; public_place: string | null; custom_location: string | null }[]>`
      select status, host_id, host_name, host_did, duration, public_place, custom_location from sessions where proposal_uri = ${proposalUri()}
    `
    expect(session).toMatchObject({ status: 'pending', host_id: author.id, host_name: null, host_did: author.did, duration: 30, public_place: 'South Boulder', custom_location: null })
    const [told] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${organizerId} and type = 'new_proposal'`
    expect(told!.n).toBe(1)

    const v2 = await put(author, PROPOSAL, rkeyNew, proposal({ title: `Ingest ${RUN} v2` }))
    // A replayed frame of the first version no longer matches the PDS: the session keeps v1.
    const stale = await processCommit(frame(author.did, PROPOSAL, rkeyNew, 'update', created.record, created.cid))
    expect(stale.outcome).toBe('skipped:unverified')

    const updated = await processCommit(frame(author.did, PROPOSAL, rkeyNew, 'update', v2.record, v2.cid))
    expect(updated.sideEffects).toContain('session-updated')
    const [after] = await raw<{ title: string; proposal_cid: string }[]>`select title, proposal_cid from sessions where proposal_uri = ${proposalUri()}`
    expect(after).toEqual({ title: `Ingest ${RUN} v2`, proposal_cid: v2.cid })
    currentCid = v2.cid
  })

  test('a proposer editing a published session is cid drift: flagged once, content untouched', async () => {
    const uri = proposalUri()
    const slotUri = `at://${gathering.actorDid}/schellingpoint.draft.slot/3lslotingest2`
    await raw`update sessions set status = 'scheduled', slot_uri = ${slotUri}, slot_cid = ${CID1} where proposal_uri = ${uri}`
    await store.upsertIndexedRecord({
      uri: slotUri,
      cid: CID1,
      source: 'test',
      record: { $type: 'schellingpoint.draft.slot', gathering: gatheringUri, event: { uri: `at://${gathering.actorDid}/community.lexicon.calendar.event/3levent`, cid: CID1 }, proposal: { uri, cid: currentCid }, startsAt: '2026-10-01T16:00:00.000Z', endsAt: '2026-10-01T17:00:00.000Z', createdAt: new Date().toISOString() },
    })
    const v3 = await put(author, PROPOSAL, rkeyNew, proposal({ title: 'Something else entirely' }))
    const drift = await processCommit(frame(author.did, PROPOSAL, rkeyNew, 'update', v3.record, v3.cid))
    expect(drift.sideEffects).toContain('drift:flagged')
    const [row] = await raw<{ title: string; status: string; proposal_drift_cid: string }[]>`select title, status, proposal_drift_cid from sessions where proposal_uri = ${uri}`
    expect(row).toEqual({ title: `Ingest ${RUN} v2`, status: 'scheduled', proposal_drift_cid: v3.cid })
    const again = await processCommit(frame(author.did, PROPOSAL, rkeyNew, 'update', v3.record, v3.cid))
    expect(again.sideEffects).toContain('drift:already-flagged')
    const [n] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${organizerId} and type = 'proposal_changed'`
    expect(n!.n).toBe(1)
    currentCid = v3.cid
  })

  test('a co-host record pairs only with the proposer’s half of the double opt-in', async () => {
    const rkey = '3lcohostingst'
    const proposalRef = { uri: proposalUri(), cid: currentCid }
    const first = await put(cohost, COHOST, rkey, { $type: COHOST, proposal: proposalRef, createdAt: '2026-09-14T12:00:00.000Z' })
    const uninvited = await processCommit(frame(cohost.did, COHOST, rkey, 'create', first.record, first.cid))
    expect(uninvited.sideEffects).toContain('cohost:no-invite')
    const [session] = await raw<{ id: string }[]>`select id from sessions where proposal_uri = ${proposalRef.uri}`
    const [pairs] = await raw<{ n: number }[]>`select count(*)::int as n from session_cohosts where session_id = ${session!.id}`
    expect(pairs!.n).toBe(0)

    await raw`
      insert into cohost_invites (session_id, created_by, accepted_by, status, event_id, accepted_at)
      values (${session!.id}, ${cohost.id}, ${cohost.id}, 'accepted', ${gathering.id}, now())
    `
    const second = await put(cohost, COHOST, rkey, { $type: COHOST, proposal: proposalRef, createdAt: '2026-09-14T12:05:00.000Z' })
    // A forged update naming the co-host is not applied even once the invite exists.
    const forged = await processCommit(frame(cohost.did, COHOST, rkey, 'update', { ...second.record, createdAt: '2026-09-14T13:00:00.000Z' }, second.cid))
    expect(forged.outcome).toBe('skipped:unverified')
    const [none] = await raw<{ n: number }[]>`select count(*)::int as n from session_cohosts where session_id = ${session!.id}`
    expect(none!.n).toBe(0)

    const invited = await processCommit(frame(cohost.did, COHOST, rkey, 'update', second.record, second.cid))
    expect(invited.sideEffects).toContain('cohost-linked')
    const [paired] = await raw<{ cohost_uri: string }[]>`select cohost_uri from session_cohosts where session_id = ${session!.id} and user_id = ${cohost.id}`
    expect(paired!.cohost_uri).toBe(`at://${cohost.did}/${COHOST}/${rkey}`)

    // A delete frame while the record still exists is refused…
    const early = await processCommit(frame(cohost.did, COHOST, rkey, 'delete'))
    expect(early.outcome).toBe('skipped:unverified')
    // …and applied once the PDS no longer holds it.
    await remove(cohost, COHOST, rkey)
    const removed = await processCommit(frame(cohost.did, COHOST, rkey, 'delete'))
    expect(removed.outcome).toBe('deleted')
    const [cleared] = await raw<{ cohost_uri: string | null }[]>`select cohost_uri from session_cohosts where session_id = ${session!.id} and user_id = ${cohost.id}`
    expect(cleared!.cohost_uri).toBeNull()
  })

  test('a withdrawn proposal flags the scheduled session and never touches the schedule', async () => {
    const uri = proposalUri()
    await remove(author, PROPOSAL, rkeyNew)
    const res = await processCommit(frame(author.did, PROPOSAL, rkeyNew, 'delete'))
    expect(res.outcome).toBe('deleted')
    expect(res.sideEffects).toContain('proposal-withdrawn:flagged')
    const [row] = await raw<{ status: string; slot_uri: string; proposal_withdrawn_at: string | null }[]>`select status, slot_uri, proposal_withdrawn_at from sessions where proposal_uri = ${uri}`
    expect(row!.status).toBe('scheduled')
    expect(row!.slot_uri).toBeTruthy()
    expect(row!.proposal_withdrawn_at).not.toBeNull()
    expect(await store.getIndexedRecord(uri)).toBeNull()
  })

  test('the Jetstream cursor only moves forward', async () => {
    const source = `test:${RUN}`
    expect(await store.advanceCursor(source, 1_789_000_000_000_100)).toBe('1789000000000100')
    expect(await store.advanceCursor(source, 1_789_000_000_000_050)).toBe('1789000000000100')
    expect(await store.advanceCursor(source, 1_789_000_000_000_200)).toBe('1789000000000200')
  })

  test('format and duration coerce onto what the gathering allows', () => {
    expect(ingest.coerceFormat('workshop', ['talk', 'workshop'])).toBe('workshop')
    expect(ingest.coerceFormat('ceremony', ['talk'])).toBe('talk')
    expect(ingest.coerceFormat('mystery', null)).toBe('discussion')
    expect(ingest.coerceDuration(45, [30, 60])).toBe(30)
    expect(ingest.coerceDuration(50, [30, 60])).toBe(60)
    expect(ingest.coerceDuration(undefined, [15, 30])).toBe(15)
  })
})
