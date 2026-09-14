import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { createClient } from '@supabase/supabase-js'
import Module from 'node:module'
import path from 'node:path'

/**
 * Ingest (src/lib/atproto/ingest.ts) against the local database and the seeded
 * `ethboulder-2026` event. Synthetic Jetstream v1 frames stand in for the
 * network; nothing here touches a PDS.
 *
 * `ingest.ts` is `server-only` (Next.js aliases that marker at bundle time and
 * it does not exist in node_modules), so the marker is resolved to Next's own
 * empty shim before the module is required.
 */
loadEnvConfig(process.cwd(), true)
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const local = ['127.0.0.1', 'localhost'].includes(new URL(url).hostname)
test.skip(!local, 'Ingest tests only run against local Supabase')
const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } })

const SERVER_ONLY_SHIM = path.resolve(process.cwd(), 'node_modules/next/dist/compiled/server-only/empty.js')
const M = Module as unknown as { _resolveFilename: (...a: unknown[]) => string }
const originalResolve = M._resolveFilename
M._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  if (request === 'server-only') return SERVER_ONLY_SHIM
  return originalResolve.call(this, request, ...rest)
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ingest = require('../src/lib/atproto/ingest') as typeof import('../src/lib/atproto/ingest')

const base = 'http://127.0.0.1:3001'
const SLUG = 'ethboulder-2026'
const GATHERING = 'at://did:plc:testgathering/schellingpoint.draft.gathering/self'
const AUTHOR = 'did:plc:testauthor'
const COHOST = 'did:plc:testcohostunlinked'
// Fixed identifiers: a worker restart would re-evaluate a timestamp; cleanup runs before and after instead.
const RUN = 'spec'
const VALID_CID = 'bafyreigwnxqttkhzha2ig4io6wwht3qiugtor4ruglceyfdbnyq53a55fe' // strongRef.cid must be a real CID
const RKEY_NEW = `3ingest${RUN}a`
const RKEY_LINKED = `3ingest${RUN}b`
const RKEY_SCHED = `3ingest${RUN}c`
const RKEY_BAD = `3ingest${RUN}d`
const RKEY_COHOST = `3ingest${RUN}e`
const uriOf = (did: string, collection: string, rkey: string) => `at://${did}/${collection}/${rkey}`
const PROPOSAL = 'schellingpoint.draft.proposal'
const COHOST_NSID = 'schellingpoint.draft.cohost'

let eventId: string
let previousGatheringUri: string | null
let ownerId: string
const createdSessionIds: string[] = []

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    $type: PROPOSAL,
    gathering: GATHERING,
    title: `Ingest test ${RUN}`,
    description: 'A synthetic proposal written by a test',
    format: 'workshop',
    durationMinutes: 45,
    topics: ['testing', 'atproto'],
    expectedAttendance: 12,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function frame(did: string, collection: string, rkey: string, operation: 'create' | 'update' | 'delete', record?: Record<string, unknown>, cid?: string) {
  return {
    did,
    time_us: Date.now() * 1000,
    kind: 'commit' as const,
    commit: { rev: `3rev${RUN}`, operation, collection, rkey, ...(record ? { record } : {}), ...(cid ? { cid } : {}) },
  }
}

test.beforeAll(async () => {
  const { data: event } = await db.from('events').select('id, gathering_uri').eq('slug', SLUG).single()
  expect(event).not.toBeNull()
  eventId = event!.id
  previousGatheringUri = event!.gathering_uri
  const { error } = await db.from('events').update({ gathering_uri: GATHERING }).eq('id', eventId)
  expect(error).toBeNull()
  const { data: owner } = await db.from('event_members').select('user_id').eq('event_id', eventId).eq('role', 'owner').limit(1).single()
  expect(owner).not.toBeNull()
  ownerId = owner!.user_id
  await cleanup()
})

async function cleanup() {
  const uris = [RKEY_NEW, RKEY_LINKED, RKEY_SCHED, RKEY_BAD].map((r) => uriOf(AUTHOR, PROPOSAL, r))
  uris.push(uriOf(COHOST, COHOST_NSID, RKEY_COHOST))
  await db.from('at_records').delete().in('uri', uris)
  await db.from('at_audit').delete().in('uri', uris)
  const { data: leftovers } = await db.from('sessions').select('id').in('proposal_uri', uris)
  for (const s of (leftovers ?? []) as { id: string }[]) createdSessionIds.push(s.id)
  if (createdSessionIds.length) {
    await db.from('notifications').delete().in('data->>session_id', createdSessionIds)
    await db.from('session_cohosts').delete().in('session_id', createdSessionIds)
    await db.from('sessions').delete().in('id', createdSessionIds)
  }
  createdSessionIds.length = 0
}

test.afterAll(async () => {
  await cleanup()
  await db.from('events').update({ gathering_uri: previousGatheringUri }).eq('id', eventId)
})

test('a valid proposal frame is indexed and offered to the review queue', async () => {
  const uri = uriOf(AUTHOR, PROPOSAL, RKEY_NEW)
  const result = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, RKEY_NEW, 'create', proposal(), 'bafycid1'))
  expect(result?.outcome).toBe('indexed')

  const { data: indexed } = await db.from('at_records').select('did, collection, cid, record, source').eq('uri', uri).single()
  expect(indexed?.did).toBe(AUTHOR)
  expect(indexed?.collection).toBe(PROPOSAL)
  expect(indexed?.cid).toBe('bafycid1')
  expect(indexed?.source).toBe('jetstream')

  const { data: session } = await db
    .from('sessions')
    .select('id, host_id, host_name, host_did, imported_from, status, title, format, duration, topic_tags, proposal_uri')
    .eq('proposal_uri', uri)
    .maybeSingle()
  if (session) {
    // The database lets a host-less import through (e.g. the proposal trigger was relaxed).
    createdSessionIds.push(session.id)
    expect(result?.sideEffects).toContain('session-created')
    expect(session.host_id).toBeNull()
    expect(session.host_name).toBeNull()
    expect(session.host_did).toBe(AUTHOR)
    expect(session.imported_from).toBe('atproto')
    expect(session.status).toBe('pending')
    expect(session.title).toBe(`Ingest test ${RUN}`)
    expect(session.format).toBe('workshop')
    expect(session.duration).toBe(30) // 45 snapped to the nearest allowed duration (15/30/60/90, ties shorter)
    expect(session.topic_tags).toEqual(['testing', 'atproto'])
  } else {
    // `enforce_event_proposal_rules` (BEFORE INSERT) refuses a host-less insert
    // while proposals are closed / the author is not a member. The record must
    // still be indexed and the refusal recorded for the organiser.
    expect(result?.warnings.some((w) => w.startsWith('session not created:'))).toBe(true)
    const { data: audit } = await db.from('at_audit').select('action, decision, reason').eq('uri', uri).eq('action', 'proposal-ingest').maybeSingle()
    expect(audit?.decision).toBe('deny')
    expect(audit?.reason).toContain('sessions insert rejected')
  }
})

test('an update frame rewrites the linked session content and cid', async () => {
  const uri = uriOf(AUTHOR, PROPOSAL, RKEY_LINKED)
  // Fixture row the insert trigger accepts (an owner as host); ingest then owns its content.
  const { data: fixture, error } = await db
    .from('sessions')
    .insert({ event_id: eventId, title: 'before', format: 'talk', duration: 30, host_id: ownerId, host_did: AUTHOR, status: 'pending', proposal_uri: uri, proposal_cid: 'bafyold', imported_from: 'atproto' })
    .select('id')
    .single()
  expect(error).toBeNull()
  createdSessionIds.push(fixture!.id)

  const result = await ingest.ingestFromJetstreamFrame(
    frame(AUTHOR, PROPOSAL, RKEY_LINKED, 'update', proposal({ title: `Ingest updated ${RUN}`, durationMinutes: 60 }), 'bafynew'),
  )
  expect(result?.outcome).toBe('indexed')
  expect(result?.sideEffects).toContain('session-updated')
  const { data: session } = await db.from('sessions').select('title, duration, proposal_cid, host_name').eq('id', fixture!.id).single()
  expect(session?.title).toBe(`Ingest updated ${RUN}`)
  expect(session?.duration).toBe(60)
  expect(session?.proposal_cid).toBe('bafynew')
  expect(session?.host_name).toBeNull()
})

test('a delete frame withdraws the linked session and drops the index row', async () => {
  const uri = uriOf(AUTHOR, PROPOSAL, RKEY_LINKED)
  const result = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, RKEY_LINKED, 'delete'))
  expect(result?.outcome).toBe('deleted')
  expect(result?.sideEffects).toContain('session-withdrawn')
  const { data: gone } = await db.from('at_records').select('uri').eq('uri', uri).maybeSingle()
  expect(gone).toBeNull()
  // 'withdrawn' is not in the sessions status CHECK (pending/approved/rejected/scheduled): rejected + reason.
  const { data: session } = await db.from('sessions').select('status, rejection_reason').eq('proposal_uri', uri).single()
  expect(session?.status).toBe('rejected')
  expect(session?.rejection_reason).toBe(ingest.WITHDRAWN_REASON)
})

test('cid drift on a scheduled session is audited, not applied', async () => {
  const uri = uriOf(AUTHOR, PROPOSAL, RKEY_SCHED)
  const { data: fixture, error } = await db
    .from('sessions')
    .insert({ event_id: eventId, title: 'pinned title', format: 'talk', duration: 30, host_id: ownerId, host_did: AUTHOR, status: 'scheduled', proposal_uri: uri, proposal_cid: 'bafypinned', imported_from: 'atproto' })
    .select('id')
    .single()
  expect(error).toBeNull()
  createdSessionIds.push(fixture!.id)

  const result = await ingest.ingestFromJetstreamFrame(
    frame(AUTHOR, PROPOSAL, RKEY_SCHED, 'update', proposal({ title: 'edited after scheduling' }), 'bafydrifted'),
  )
  expect(result?.outcome).toBe('indexed')
  expect(result?.sideEffects).toContain('proposal-drift')
  const { data: session } = await db.from('sessions').select('title, proposal_cid').eq('id', fixture!.id).single()
  expect(session?.title).toBe('pinned title')
  expect(session?.proposal_cid).toBe('bafypinned')
  const { data: audit } = await db.from('at_audit').select('decision, reason').eq('uri', uri).eq('action', 'proposal-drift').maybeSingle()
  expect(audit?.decision).toBe('allow')
  expect(audit?.reason).toContain('bafydrifted')
  const { data: indexed } = await db.from('at_records').select('cid').eq('uri', uri).single()
  expect(indexed?.cid).toBe('bafydrifted') // the index always reflects the network
})

test('an invalid record (missing title) is skipped and never indexed', async () => {
  const uri = uriOf(AUTHOR, PROPOSAL, RKEY_BAD)
  const bad = proposal()
  delete (bad as Record<string, unknown>).title
  const result = await ingest.ingestFromJetstreamFrame(frame(AUTHOR, PROPOSAL, RKEY_BAD, 'create', bad, 'bafybad'))
  expect(result?.outcome).toBe('skipped:invalid')
  const { data } = await db.from('at_records').select('uri').eq('uri', uri).maybeSingle()
  expect(data).toBeNull()
  const { data: session } = await db.from('sessions').select('id').eq('proposal_uri', uri).maybeSingle()
  expect(session).toBeNull()
})

test('a cohost frame from an unlinked DID is indexed but pairs with nothing', async () => {
  const proposalUri = uriOf(AUTHOR, PROPOSAL, RKEY_SCHED)
  const uri = uriOf(COHOST, COHOST_NSID, RKEY_COHOST)
  const result = await ingest.ingestFromJetstreamFrame(
    frame(COHOST, COHOST_NSID, RKEY_COHOST, 'create', { $type: COHOST_NSID, proposal: { uri: proposalUri, cid: VALID_CID }, role: 'cohost', createdAt: new Date().toISOString() }, 'bafycohost'),
  )
  expect(result?.outcome).toBe('indexed')
  expect(result?.sideEffects).toContain('cohost:unlinked-did')
  const { data: indexed } = await db.from('at_records').select('did').eq('uri', uri).single()
  expect(indexed?.did).toBe(COHOST)
  const { data: rows } = await db.from('session_cohosts').select('id').eq('cohost_uri', uri)
  expect(rows).toEqual([])
})

test('frames outside the indexed collections and non-commit frames are ignored', async () => {
  expect(await ingest.ingestFromJetstreamFrame(frame(AUTHOR, 'app.bsky.feed.post', 'x', 'create', { text: 'hi' }))).toBeNull()
  expect(await ingest.ingestFromJetstreamFrame({ did: AUTHOR, time_us: 1, kind: 'identity', identity: { did: AUTHOR } })).toBeNull()
  expect(ingest.jetstreamSubscribeUrl(['a.b.c', 'd.e.f'], 42)).toMatch(/\?wantedCollections=a\.b\.c&wantedCollections=d\.e\.f&cursor=42$/)
})

test('GET /api/atproto/records serves the gathering’s proposals as public JSON', async ({ request }) => {
  const response = await request.get(`${base}/api/atproto/records?event=${SLUG}&collection=${PROPOSAL}`)
  expect(response.status()).toBe(200)
  expect(response.headers()['cache-control']).toContain('max-age=60')
  const body = await response.json()
  expect(Array.isArray(body)).toBe(true)
  const uris = body.map((r: { uri: string }) => r.uri)
  expect(uris).toContain(uriOf(AUTHOR, PROPOSAL, RKEY_NEW)) // matched by record.gathering
  expect(uris).toContain(uriOf(AUTHOR, PROPOSAL, RKEY_SCHED)) // matched by sessions.proposal_uri
  const row = body.find((r: { uri: string }) => r.uri === uriOf(AUTHOR, PROPOSAL, RKEY_NEW))
  expect(row.did).toBe(AUTHOR)
  expect(row.record.title).toBe(`Ingest test ${RUN}`)

  const bad = await request.get(`${base}/api/atproto/records?event=${SLUG}&collection=app.bsky.feed.post`)
  expect(bad.status()).toBe(400)
  const missing = await request.get(`${base}/api/atproto/records?event=no-such-gathering-${RUN}`)
  expect(missing.status()).toBe(404)
})

test('GET /api/atproto/sync runs reconciliation unauthenticated in development', async ({ request }) => {
  // Mirrors /api/notifications/dispatch: with CRON_SECRET unset the dev server allows
  // the call (production returns 503); with it set, a missing bearer is 401.
  const response = await request.get(`${base}/api/atproto/sync`)
  expect([200, 401]).toContain(response.status())
  if (response.status() === 200) {
    const body = await response.json()
    expect(typeof body.repos).toBe('number')
    expect(Array.isArray(body.errors)).toBe(true)
    const { data: cursor } = await db.from('at_sync_cursor').select('cursor').eq('source', ingest.RECONCILE_CURSOR_SOURCE).single()
    expect(cursor?.cursor).toBeTruthy()
  } else {
    expect(process.env.CRON_SECRET).toBeTruthy()
  }
})
