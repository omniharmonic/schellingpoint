import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'

// Ingest against the local database with synthetic Jetstream frames: relevance, validation,
// proposal linking, cid drift and withdrawal on the published schedule, double opt-in co-host
// pairing, the per-record error boundary, and the monotonic cursor. No PDS is needed: frames are
// what a relay would deliver.
loadEnvConfig(process.cwd(), true)

const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const configured = Boolean(migrationUrl && process.env.DATABASE_URL)

type Resolver = (request: string, ...rest: unknown[]) => string
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = moduleWithResolver._resolveFilename
const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const did = (label: string) => `did:plc:${`${label}${RUN}`.replace(/[^a-z2-7]/g, 'q').padEnd(24, 'q').slice(0, 24)}`
const GATHERING_DID = did('ingestgathering')
const GATHERING_URI = `at://${GATHERING_DID}/schellingpoint.draft.gathering/self`
const AUTHOR = did('ingestauthor')
const STRANGER = did('ingeststranger')
const COHOST = did('ingestcohost')
const CID1 = 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe'
const CID2 = 'bafyreigwnxqttkhzha2ig4io6wwht3qiugtor4ruglceyfdbnyq53a55fe'
const CID3 = 'bafyreib4ibsg2hkw6zwzbxla3oi7wqffdi6qsbk2fihkjxxgbynewqfwru'
const PROPOSAL = 'schellingpoint.draft.proposal'

function proposal(overrides: Record<string, unknown> = {}) {
  return { $type: PROPOSAL, gathering: GATHERING_URI, title: `Ingest ${RUN}`, format: 'workshop', durationMinutes: 45, topics: ['atproto'], createdAt: new Date().toISOString(), ...overrides }
}

function frame(repo: string, collection: string, rkey: string, operation: 'create' | 'update' | 'delete', record?: Record<string, unknown>, cid?: string) {
  return { did: repo, time_us: Date.now() * 1000, kind: 'commit' as const, commit: { rev: '3mvjrev', operation, collection, rkey, ...(record ? { record } : {}), ...(cid ? { cid } : {}) } }
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('ingest', () => {
  test.skip(!configured, 'DATABASE_URL / DATABASE_MIGRATION_URL are not set')

  let raw: postgres.Sql
  let ingest: typeof import('../src/lib/atproto/ingest')
  let store: typeof import('../src/lib/atproto/index-store')
  let db: typeof import('../src/lib/db')
  let eventId = ''
  let organizerId = ''
  let cohostId = ''
  const rkeyNew = `3ing${RUN}`.slice(0, 13).padEnd(13, 'a')

  test.beforeAll(async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    ingest = require('../src/lib/atproto/ingest')
    store = require('../src/lib/atproto/index-store')
    db = require('../src/lib/db')
    /* eslint-enable @typescript-eslint/no-require-imports */
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })
    const [event] = await raw<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, actor_did, gathering_uri, allowed_formats, allowed_durations)
      values (${`f-ingest-${RUN}`}, 'F ingest test', '2026-10-01', '2026-10-02', 'proposals_open', ${GATHERING_DID}, ${GATHERING_URI},
              ${['talk', 'workshop', 'discussion']}, ${[30, 60]})
      returning id
    `
    eventId = event!.id
    const [organizer] = await raw<{ id: string }[]>`insert into accounts (did, kind, email) values (${did('ingestorg')}, 'custodial', ${`f-ingest-org-${RUN}@example.test`}) returning id`
    organizerId = organizer!.id
    await raw`insert into event_members (event_id, user_id, role) values (${eventId}, ${organizerId}, 'owner')`
    const [cohost] = await raw<{ id: string }[]>`insert into accounts (did, kind, email) values (${COHOST}, 'custodial', ${`f-ingest-cohost-${RUN}@example.test`}) returning id`
    cohostId = cohost!.id
  })

  test.afterAll(async () => {
    if (raw) {
      await raw`delete from events where id = ${eventId}`
      await raw`delete from at_records where did = any(${[AUTHOR, STRANGER, COHOST, GATHERING_DID]}::text[])`
      await raw`delete from at_sync_cursor where source = ${`test:${RUN}`}`
      await raw`delete from accounts where id = any(${[organizerId, cohostId]}::uuid[])`
      await raw.end({ timeout: 5 })
    }
    await db?.sql.end({ timeout: 5 }).catch(() => undefined)
    moduleWithResolver._resolveFilename = originalResolve
  })

  test('the Jetstream URL asks for our collections and the borrowed ones we read', () => {
    const url = new URL(ingest.jetstreamSubscribeUrl(undefined, 1789000000000000))
    const wanted = url.searchParams.getAll('wantedCollections')
    for (const nsid of [PROPOSAL, 'community.lexicon.calendar.event', 'coop.lexicon.event.listing', 'freeschool.draft.approval', 'freeschool.draft.skill']) expect(wanted).toContain(nsid)
    expect(url.searchParams.get('cursor')).toBe('1789000000000000')
  })

  test('records that are not ours are not mirrored; invalid records are never indexed', async () => {
    const elsewhere = await ingest.ingestFromJetstreamFrame(frame(STRANGER, PROPOSAL, 'elsewhere1abc', 'create', proposal({ gathering: `at://${STRANGER}/schellingpoint.draft.gathering/self` }), CID1))
    expect(elsewhere?.outcome).toBe('skipped:irrelevant')
    const invalid = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, 'invalid1abcde', 'create', proposal({ durationMinutes: 2 }), CID1))
    expect(invalid?.outcome).toBe('skipped:invalid')
    expect(await store.getIndexedRecord(`at://${AUTHOR}/${PROPOSAL}/invalid1abcde`)).toBeNull()
    expect(await ingest.ingestFromJetstreamFrame({ did: AUTHOR, time_us: 1, kind: 'identity' })).toBeNull()
    const skill = await ingest.ingestFromJetstreamFrame(frame(STRANGER, 'freeschool.draft.skill', 'fake-skill', 'create', { id: 'fake-skill', label: 'Fake', status: 'canonical', createdAt: new Date().toISOString() }, CID1))
    expect(skill?.outcome).toBe('skipped:irrelevant')
  })

  test('one malformed record fails alone and is reported, never thrown', async () => {
    const res = await ingest.ingestRecord({ uri: 'not-an-at-uri', did: AUTHOR, collection: PROPOSAL, rkey: 'x', record: proposal(), source: 'test', operation: 'create', trusted: true })
    expect(res.outcome).toBe('error')
    expect(res.warnings.length).toBeGreaterThan(0)
  })

  test('a proposal offered to a gathering we host becomes a pending session naming no one', async () => {
    const res = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, rkeyNew, 'create', proposal({ selfHosted: true, place: 'South Boulder', startsAt: '2026-10-01T16:00:00Z', endsAt: '2026-10-01T17:00:00Z' }), CID1))
    expect(res?.outcome).toBe('indexed')
    expect(res?.sideEffects.some((s) => s.startsWith('session-created'))).toBe(true)
    const [session] = await raw<{ status: string; host_id: string | null; host_name: string | null; host_did: string; duration: number; public_place: string | null; custom_location: string | null }[]>`
      select status, host_id, host_name, host_did, duration, public_place, custom_location from sessions where proposal_uri = ${`at://${AUTHOR}/${PROPOSAL}/${rkeyNew}`}
    `
    expect(session).toMatchObject({ status: 'pending', host_id: null, host_name: null, host_did: AUTHOR, duration: 30, public_place: 'South Boulder', custom_location: null })
    const [told] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${organizerId} and type = 'new_proposal'`
    expect(told!.n).toBe(1)

    const updated = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, rkeyNew, 'update', proposal({ title: `Ingest ${RUN} v2` }), CID2))
    expect(updated?.sideEffects).toContain('session-updated')
    const [after] = await raw<{ title: string; proposal_cid: string }[]>`select title, proposal_cid from sessions where proposal_uri = ${`at://${AUTHOR}/${PROPOSAL}/${rkeyNew}`}`
    expect(after).toEqual({ title: `Ingest ${RUN} v2`, proposal_cid: CID2 })
  })

  test('a proposer editing a published session is cid drift: flagged once, content untouched', async () => {
    const uri = `at://${AUTHOR}/${PROPOSAL}/${rkeyNew}`
    const slotUri = `at://${GATHERING_DID}/schellingpoint.draft.slot/3lslotingest2`
    await raw`update sessions set status = 'scheduled', slot_uri = ${slotUri}, slot_cid = ${CID1} where proposal_uri = ${uri}`
    await store.upsertIndexedRecord({
      uri: slotUri,
      cid: CID1,
      source: 'test',
      record: { $type: 'schellingpoint.draft.slot', gathering: GATHERING_URI, event: { uri: `at://${GATHERING_DID}/community.lexicon.calendar.event/3levent`, cid: CID1 }, proposal: { uri, cid: CID2 }, startsAt: '2026-10-01T16:00:00.000Z', endsAt: '2026-10-01T17:00:00.000Z', createdAt: new Date().toISOString() },
    })
    const drift = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, rkeyNew, 'update', proposal({ title: 'Something else entirely' }), CID3))
    expect(drift?.sideEffects).toContain('drift:flagged')
    const [row] = await raw<{ title: string; status: string; proposal_drift_cid: string }[]>`select title, status, proposal_drift_cid from sessions where proposal_uri = ${uri}`
    expect(row).toEqual({ title: `Ingest ${RUN} v2`, status: 'scheduled', proposal_drift_cid: CID3 })
    const again = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, rkeyNew, 'update', proposal({ title: 'Something else entirely' }), CID3))
    expect(again?.sideEffects).toContain('drift:already-flagged')
    const [n] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${organizerId} and type = 'proposal_changed'`
    expect(n!.n).toBe(1)
  })

  test('a co-host record pairs only with the proposer’s half of the double opt-in', async () => {
    const proposalRef = { uri: `at://${AUTHOR}/${PROPOSAL}/${rkeyNew}`, cid: CID3 }
    const cohostRecord = { $type: 'schellingpoint.draft.cohost', proposal: proposalRef, createdAt: new Date().toISOString() }
    const uninvited = await ingest.ingestFromJetstreamFrame(frame(COHOST, 'schellingpoint.draft.cohost', '3lcohostingst', 'create', cohostRecord, CID1))
    expect(uninvited?.sideEffects).toContain('cohost:no-invite')
    const [session] = await raw<{ id: string }[]>`select id from sessions where proposal_uri = ${proposalRef.uri}`
    const [pairs] = await raw<{ n: number }[]>`select count(*)::int as n from session_cohosts where session_id = ${session!.id}`
    expect(pairs!.n).toBe(0)

    await raw`
      insert into cohost_invites (session_id, created_by, accepted_by, status, event_id, accepted_at)
      values (${session!.id}, ${cohostId}, ${cohostId}, 'accepted', ${eventId}, now())
    `
    const invited = await ingest.ingestFromJetstreamFrame(frame(COHOST, 'schellingpoint.draft.cohost', '3lcohostingst', 'update', cohostRecord, CID2))
    expect(invited?.sideEffects).toContain('cohost-linked')
    const [paired] = await raw<{ cohost_uri: string }[]>`select cohost_uri from session_cohosts where session_id = ${session!.id} and user_id = ${cohostId}`
    expect(paired!.cohost_uri).toBe(`at://${COHOST}/schellingpoint.draft.cohost/3lcohostingst`)

    const removed = await ingest.ingestFromJetstreamFrame(frame(COHOST, 'schellingpoint.draft.cohost', '3lcohostingst', 'delete'))
    expect(removed?.outcome).toBe('deleted')
    const [cleared] = await raw<{ cohost_uri: string | null }[]>`select cohost_uri from session_cohosts where session_id = ${session!.id} and user_id = ${cohostId}`
    expect(cleared!.cohost_uri).toBeNull()
  })

  test('a withdrawn proposal flags the scheduled session and never touches the schedule', async () => {
    const uri = `at://${AUTHOR}/${PROPOSAL}/${rkeyNew}`
    const res = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, rkeyNew, 'delete'))
    expect(res?.outcome).toBe('deleted')
    expect(res?.sideEffects).toContain('proposal-withdrawn:flagged')
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
