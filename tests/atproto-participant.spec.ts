import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { loadEnvConfig } from '@next/env'
import { createClient } from '@supabase/supabase-js'
import type { Agent } from '@atproto/api'
import { NSID } from '../src/lib/atproto/nsids'
import { assertNoForeignDid } from '../src/lib/atproto/records'
import { assertValidRecord } from '../src/lib/atproto/validate'
import {
  endorse,
  ParticipantError,
  publicRsvp,
  publishCohost,
  publishProposal,
  unendorse,
  withdrawProposal,
  type ParticipantDeps,
  type ParticipantIndex,
} from '../src/lib/atproto/participant'
import type { DeleteRecordInput, PutRecordInput, WriteResult } from '../src/lib/atproto/write'

/**
 * Participant-side ATProto writes (proposal / cohost / endorsement / rsvp)
 * against the local Supabase with the network faked: `put`/`del` are recorded
 * instead of reaching a PDS. The seeded `ethboulder-2026` event is used with a
 * throwaway session and throwaway users, all removed afterwards.
 */

loadEnvConfig(process.cwd(), true)
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3001'
const DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const EVENT_SLUG = 'ethboulder-2026'

const local = !!SUPABASE_URL && ['127.0.0.1', 'localhost'].includes(new URL(SUPABASE_URL).hostname)
test.skip(!local, 'ATProto participant tests only run against local Supabase')
// The tests build on each other's state (publish → cohost → endorse → withdraw);
// serial mode re-runs the whole file from beforeAll on a retry.
test.describe.configure({ mode: 'serial' })

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })

const AUTHOR_DID = 'did:plc:testauthor'
const COHOST_DID = 'did:plc:testcohost'
const ENDORSER_DID = 'did:plc:testendorser'
const GATHERING_DID = 'did:plc:testgathering'
const TEST_GATHERING_URI = `at://${GATHERING_DID}/${NSID.gathering}/self`
const PASSWORD = 'atproto-participant-test-pw-1!'

/* ───────────────────────────── fake network ───────────────────────────── */

interface PutCall extends PutRecordInput {
  result: WriteResult
}

const puts: PutCall[] = []
const dels: DeleteRecordInput[] = []
const didByUser = new Map<string, string>()
let cidCounter = 0

/** A distinct, parseable CIDv1 per write: vary digest characters of a real CID. */
const BASE_CID = 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe'
function fakeCid(n: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let suffix = ''
  let v = n
  for (let i = 0; i < 5; i++) {
    suffix = alphabet[v % 32] + suffix
    v = Math.floor(v / 32)
  }
  return BASE_CID.slice(0, 20) + suffix + BASE_CID.slice(25)
}

const fakeIndex: ParticipantIndex = {
  // Same shape as index-store.upsertIndexedRecord, written with the test's service client.
  upsert: async (input) => {
    const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(input.uri)!
    const { error } = await db
      .from('at_records')
      .upsert(
        { uri: input.uri, did: m[1], collection: m[2], rkey: m[3], cid: input.cid ?? null, record: input.record, source: input.source ?? null, indexed_at: new Date().toISOString() },
        { onConflict: 'uri' },
      )
    if (error) throw new Error(error.message)
  },
  remove: async (uri) => {
    const { error } = await db.from('at_records').delete().eq('uri', uri)
    if (error) throw new Error(error.message)
  },
}

const deps: ParticipantDeps = {
  agentFor: async (userId) => {
    const did = didByUser.get(userId)
    if (!did) {
      const err = new Error(`profile ${userId} has no linked DID`)
      err.name = 'ProfileNotLinkedError'
      throw err
    }
    return { did } as unknown as Agent
  },
  put: async (agent, input) => {
    expect(input.repo).toBe((agent as unknown as { did: string }).did)
    const result = { uri: `at://${input.repo}/${input.collection}/${input.rkey}`, cid: fakeCid(++cidCounter) }
    puts.push({ ...input, result })
    return result
  },
  del: async (_agent, input) => {
    dels.push(input)
  },
  index: fakeIndex,
  db,
}

/* ───────────────────────────── fixtures ───────────────────────────── */

let eventId: string
let restoreGatheringUri = false
let sessionId: string
let authorId: string
let cohostId: string
let endorserId: string
let unlinkedId: string
const userIds: string[] = []

async function createUser(tag: string, did: string | null): Promise<string> {
  const email = `atproto-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
  // Local GoTrue auto-confirms password signups; the `sb_secret_` service key
  // is not accepted as a bearer on the admin API, so sign up as the user.
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await anon.auth.signUp({ email, password: PASSWORD })
  if (error || !data.user) throw new Error(`signUp: ${error?.message}`)
  const id = data.user.id
  userIds.push(id)
  // The on_auth_user_created trigger creates the profile; make sure it is there before linking.
  await db.from('profiles').upsert({ id, email, display_name: `Test ${tag}` }, { onConflict: 'id' })
  if (did) {
    const { error: linkError } = await db.from('profiles').update({ did, atproto_handle: `${tag}.test`, atproto_linked_at: new Date().toISOString() }).eq('id', id)
    if (linkError) throw new Error(`link profile: ${linkError.message}`)
    didByUser.set(id, did)
  }
  return id
}

async function tokenFor(userId: string): Promise<string> {
  const { data: profile } = await db.from('profiles').select('email').eq('id', userId).single()
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email: profile!.email, password: PASSWORD })
  if (error || !data.session) throw new Error(`signIn: ${error?.message}`)
  return data.session.access_token
}

async function sessionRow() {
  const { data, error } = await db
    .from('sessions')
    .select('proposal_uri, proposal_cid, host_did, calendar_event_uri')
    .eq('id', sessionId)
    .single()
  if (error) throw new Error(error.message)
  return data
}

test.beforeAll(async () => {
  // Any stale DID links from an earlier aborted run would collide on the unique index.
  await db.from('profiles').update({ did: null, atproto_handle: null }).in('did', [AUTHOR_DID, COHOST_DID, ENDORSER_DID])
  await db.from('at_records').delete().in('did', [AUTHOR_DID, COHOST_DID, ENDORSER_DID])

  const { data: event } = await db.from('events').select('id, gathering_uri').eq('slug', EVENT_SLUG).single()
  if (!event) throw new Error(`seeded event ${EVENT_SLUG} missing`)
  eventId = event.id
  if (!event.gathering_uri) {
    await db.from('events').update({ gathering_uri: TEST_GATHERING_URI, actor_did: GATHERING_DID }).eq('id', eventId)
    restoreGatheringUri = true
  }

  authorId = await createUser('author', AUTHOR_DID)
  cohostId = await createUser('cohost', COHOST_DID)
  endorserId = await createUser('endorser', ENDORSER_DID)
  unlinkedId = await createUser('unlinked', null)

  // The seeded event is `completed`; `enforce_event_proposal_rules` only lets
  // owners/admins insert sessions outside the proposal window.
  const { error: memberError } = await db.from('event_members').insert([
    { event_id: eventId, user_id: authorId, role: 'admin' },
    { event_id: eventId, user_id: unlinkedId, role: 'admin' },
  ])
  if (memberError) throw new Error(`event_members insert: ${memberError.message}`)

  const { data: session, error } = await db
    .from('sessions')
    .insert({
      event_id: eventId,
      host_id: authorId,
      host_name: 'Test Author Person',
      title: 'Participant test session',
      description: 'A throwaway session for the participant tests.',
      format: 'talk',
      duration: 30,
      topic_tags: ['testing', 'atproto'],
      expected_attendance: 25,
      status: 'approved',
    })
    .select('id')
    .single()
  if (error || !session) throw new Error(`insert session: ${error?.message}`)
  sessionId = session.id
})

test.afterAll(async () => {
  if (sessionId) await db.from('sessions').delete().eq('id', sessionId)
  await db.from('at_records').delete().in('did', [AUTHOR_DID, COHOST_DID, ENDORSER_DID])
  if (restoreGatheringUri) await db.from('events').update({ gathering_uri: null, actor_did: null }).eq('id', eventId)
  // The admin API rejects the local `sb_secret_` key, so remove the throwaway
  // users straight from the database (profiles cascade). Best-effort.
  if (userIds.length) {
    await db.from('event_members').delete().eq('event_id', eventId).in('user_id', userIds)
    await db.from('profiles').update({ did: null, atproto_handle: null }).in('id', userIds)
    try {
      const ids = userIds.map((id) => `'${id}'`).join(',')
      execSync(`psql "${DATABASE_URL}" -q -c "delete from auth.users where id in (${ids})"`, { stdio: 'ignore' })
    } catch (e) {
      console.warn('could not delete throwaway auth users:', e instanceof Error ? e.message : e)
    }
  }
})

/* ─────────────────────────────── proposal ─────────────────────────────── */

test('publishProposal writes a valid, DID-free proposal into the author repo and persists the pointer', async () => {
  puts.length = 0
  const result = await publishProposal({ sessionId, userId: authorId }, deps)

  expect(puts).toHaveLength(1)
  const call = puts[0]
  expect(call.repo).toBe(AUTHOR_DID)
  expect(call.collection).toBe(NSID.proposal)
  expect(call.swapRecord).toBeUndefined()
  expect(result.uri).toBe(`at://${AUTHOR_DID}/${NSID.proposal}/${call.rkey}`)

  expect(() => assertValidRecord(NSID.proposal, call.record)).not.toThrow()
  expect(() => assertNoForeignDid(call.record, AUTHOR_DID, { gatheringDid: GATHERING_DID })).not.toThrow()
  const json = JSON.stringify(call.record)
  expect(json).not.toContain('Test Author Person')
  expect(json).not.toContain('host_name')
  expect(json).not.toContain(COHOST_DID)
  expect(call.record.gathering).toBe(TEST_GATHERING_URI)
  expect(call.record.imported).toBeUndefined()
  expect(call.record.importedFrom).toBeUndefined()

  const row = await sessionRow()
  expect(row.proposal_uri).toBe(result.uri)
  expect(row.proposal_cid).toBe(result.cid)
  expect(row.host_did).toBe(AUTHOR_DID)
})

test('a second publish updates the same rkey with swapRecord set to the stored cid', async () => {
  const before = await sessionRow()
  puts.length = 0
  const result = await publishProposal({ sessionId, userId: authorId }, deps)
  expect(puts).toHaveLength(1)
  expect(puts[0].rkey).toBe(before.proposal_uri!.split('/').pop())
  expect(puts[0].swapRecord).toBe(before.proposal_cid)
  expect(result.uri).toBe(before.proposal_uri)
  const after = await sessionRow()
  expect(after.proposal_cid).toBe(result.cid)
  expect(after.proposal_cid).not.toBe(before.proposal_cid)
})

test('only the author can publish, and only a linked profile can', async () => {
  await expect(publishProposal({ sessionId, userId: endorserId }, deps)).rejects.toMatchObject({ code: 'forbidden', status: 403 })
  const { data: unlinkedSession } = await db
    .from('sessions')
    .insert({ event_id: eventId, host_id: unlinkedId, host_name: 'Nobody', title: 'Unlinked session', format: 'talk', duration: 15, status: 'approved' })
    .select('id')
    .single()
  try {
    await expect(publishProposal({ sessionId: unlinkedSession!.id, userId: unlinkedId }, deps)).rejects.toMatchObject({ code: 'link_atproto_first', status: 409 })
  } finally {
    await db.from('sessions').delete().eq('id', unlinkedSession!.id)
  }
})

/* ──────────────────────────────── cohost ──────────────────────────────── */

test('publishCohost strongRefs the proposal cid and persists cohost_uri', async () => {
  await expect(publishCohost({ sessionId, userId: cohostId }, deps)).rejects.toMatchObject({ code: 'not_cohost', status: 403 })

  const { error } = await db.from('session_cohosts').insert({ session_id: sessionId, user_id: cohostId, event_id: eventId, display_order: 1 })
  expect(error).toBeNull()

  const proposal = await sessionRow()
  puts.length = 0
  const result = await publishCohost({ sessionId, userId: cohostId }, deps)
  expect(puts).toHaveLength(1)
  expect(puts[0].repo).toBe(COHOST_DID)
  expect(puts[0].collection).toBe(NSID.cohost)
  expect(puts[0].record.proposal).toEqual({ uri: proposal.proposal_uri, cid: proposal.proposal_cid })
  expect(() => assertValidRecord(NSID.cohost, puts[0].record)).not.toThrow()
  expect(() => assertNoForeignDid(puts[0].record, COHOST_DID)).not.toThrow()

  const { data: row } = await db.from('session_cohosts').select('cohost_uri').eq('session_id', sessionId).eq('user_id', cohostId).single()
  expect(row?.cohost_uri).toBe(result.uri)
})

/* ───────────────────────────── endorsement ───────────────────────────── */

test('endorse / unendorse round trip, visible in the public index and the GET count', async () => {
  await expect(endorse({ sessionId, userId: authorId }, deps)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(endorse({ sessionId, userId: endorserId, note: 'x'.repeat(151) }, deps)).rejects.toMatchObject({ code: 'invalid_note', status: 400 })

  puts.length = 0
  const result = await endorse({ sessionId, userId: endorserId, note: 'Would love to see this.' }, deps)
  expect(puts[0].repo).toBe(ENDORSER_DID)
  expect(puts[0].collection).toBe(NSID.endorsement)
  expect(() => assertValidRecord(NSID.endorsement, puts[0].record)).not.toThrow()

  const { data: indexed } = await db.from('at_records').select('did, collection, record').eq('uri', result.uri).single()
  expect(indexed?.did).toBe(ENDORSER_DID)
  expect(indexed?.collection).toBe(NSID.endorsement)

  const res = await fetch(`${BASE_URL}/api/v1/events/${EVENT_SLUG}/sessions/${sessionId}/atproto`)
  expect(res.status).toBe(200)
  const body = await res.json()
  expect(body.endorsements).toBe(1)

  // Endorsing again rewrites the same record rather than adding a second one.
  puts.length = 0
  const again = await endorse({ sessionId, userId: endorserId, note: 'Updated note' }, deps)
  expect(again.uri).toBe(result.uri)

  dels.length = 0
  const removed = await unendorse({ sessionId, userId: endorserId }, deps)
  expect(removed.uri).toBe(result.uri)
  expect(dels).toHaveLength(1)
  expect(dels[0]).toMatchObject({ repo: ENDORSER_DID, collection: NSID.endorsement })
  const { data: gone } = await db.from('at_records').select('uri').eq('uri', result.uri).maybeSingle()
  expect(gone).toBeNull()
  await expect(unendorse({ sessionId, userId: endorserId }, deps)).rejects.toMatchObject({ code: 'nothing_to_withdraw' })
})

/* ──────────────────────────────── rsvp ──────────────────────────────── */

test('publicRsvp requires a published calendar event (409 otherwise)', async () => {
  await db.from('session_rsvps').upsert({ session_id: sessionId, user_id: endorserId, event_id: eventId, status: 'confirmed' }, { onConflict: 'session_id,user_id' })
  await expect(publicRsvp({ sessionId, userId: endorserId, status: 'going' }, deps)).rejects.toMatchObject({ code: 'calendar_event_not_published', status: 409 })

  const token = await tokenFor(endorserId)
  const res = await fetch(`${BASE_URL}/api/v1/events/${EVENT_SLUG}/sessions/${sessionId}/atproto`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rsvp-public', status: 'going' }),
  })
  expect(res.status).toBe(409)
  const body = await res.json()
  expect(body.error).toBe('calendar_event_not_published')
})

/* ─────────────────────────────── route ─────────────────────────────── */

test('GET …/atproto returns the public shape, plus viewer state when signed in', async () => {
  const anon = await fetch(`${BASE_URL}/api/v1/events/${EVENT_SLUG}/sessions/${sessionId}/atproto`)
  expect(anon.status).toBe(200)
  const body = await anon.json()
  expect(body.proposal).toMatchObject({ uri: expect.stringContaining(`at://${AUTHOR_DID}/${NSID.proposal}/`), handle: 'author.test' })
  expect(body.calendarEvent).toBeNull()
  expect(typeof body.endorsements).toBe('number')
  expect(body.viewer).toBeUndefined()

  const token = await tokenFor(authorId)
  const signed = await fetch(`${BASE_URL}/api/v1/events/${EVENT_SLUG}/sessions/${sessionId}/atproto`, { headers: { Authorization: `Bearer ${token}` } })
  expect(signed.status).toBe(200)
  const viewer = (await signed.json()).viewer
  expect(viewer).toMatchObject({ linked: true, isAuthor: true, isCohost: false, hasProposalRecord: true, endorsed: false, publicRsvp: null })
})

test('POST …/atproto unauthenticated -> 401; unknown action -> 400', async () => {
  const res = await fetch(`${BASE_URL}/api/v1/events/${EVENT_SLUG}/sessions/${sessionId}/atproto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'publish-proposal' }),
  })
  expect(res.status).toBe(401)

  const token = await tokenFor(authorId)
  const bad = await fetch(`${BASE_URL}/api/v1/events/${EVENT_SLUG}/sessions/${sessionId}/atproto`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'nope' }),
  })
  expect(bad.status).toBe(400)
})

test('withdrawProposal deletes the record and clears the pointer, keeping the session', async () => {
  dels.length = 0
  const before = await sessionRow()
  const removed = await withdrawProposal({ sessionId, userId: authorId }, deps)
  expect(removed.uri).toBe(before.proposal_uri)
  expect(dels).toHaveLength(1)
  expect(dels[0]).toMatchObject({ repo: AUTHOR_DID, collection: NSID.proposal, rkey: before.proposal_uri!.split('/').pop() })
  const after = await sessionRow()
  expect(after.proposal_uri).toBeNull()
  expect(after.proposal_cid).toBeNull()
  await expect(withdrawProposal({ sessionId, userId: authorId }, deps)).rejects.toBeInstanceOf(ParticipantError)
  const { data: still } = await db.from('sessions').select('id, status').eq('id', sessionId).single()
  expect(still?.status).toBe('approved')
})
