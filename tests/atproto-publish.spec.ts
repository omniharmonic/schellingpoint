import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import type { PutAsGatheringInput } from '../src/lib/atproto/actor'
import { NSID } from '../src/lib/atproto/nsids'
import { base32, deterministicRkey, SELF_RKEY, sha256 } from '../src/lib/atproto/rkey'
import { publishGathering, publishSchedule, type PublishDeps } from '../src/lib/atproto/publish'
import { computeTally, publishTally, type VoteRow } from '../src/lib/atproto/tally'
import { assertNoUnknownFields, assertValidRecord } from '../src/lib/atproto/validate'

// The publish pipeline reads the seeded event from the local Supabase instance
// (service role) and writes through an injected fake PDS: nothing is persisted
// (`persist: false`) and no gathering credential is needed.
loadEnvConfig(process.cwd(), true)

const base = 'http://127.0.0.1:3001'
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceKey = process.env.TEST_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''
const local = supabaseUrl ? ['127.0.0.1', 'localhost'].includes(new URL(supabaseUrl).hostname) : false

const EVENT_SLUG = 'ethboulder-2026'
const ACTOR_DID = 'did:plc:testgathering2026'
const FAKE_SESSION = '00000000-0000-0000-0000-000000000000'

const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }

/** A syntactically valid CIDv1 (dag-cbor, sha2-256) derived from the record's JSON. */
function fakeCid(record: unknown): string {
  const digest = sha256(new TextEncoder().encode(JSON.stringify(record)))
  const bytes = new Uint8Array(4 + digest.length)
  bytes.set([0x01, 0x71, 0x12, 0x20])
  bytes.set(digest, 4)
  return `b${base32(bytes)}`
}

/** A fake PDS: records every put, answers getRecord from what was put, mints a content-derived cid. */
function fakeDeps(did = ACTOR_DID) {
  const calls: PutAsGatheringInput[] = []
  const store = new Map<string, { cid: string; value: Record<string, unknown> }>()
  const deps: PublishDeps = {
    put: async (input) => {
      calls.push(input)
      const uri = `at://${did}/${input.collection}/${input.rkey}`
      const cid = fakeCid(input.record)
      store.set(uri, { cid, value: input.record })
      return { uri, cid, auditId: 'audit-fake' }
    },
    del: async () => ({ auditId: 'audit-fake' }),
    getRecord: async <T,>(repo: string, collection: string, rkey: string) => {
      const uri = `at://${repo}/${collection}/${rkey}`
      const hit = store.get(uri)
      return hit ? { uri, cid: hit.cid, value: hit.value as T } : null
    },
    actorDidFor: async () => did,
    persist: false,
  }
  return { deps, calls, store }
}

async function seededEvent(request: Parameters<Parameters<typeof test>[2]>[0]['request']) {
  const res = await request.get(`${supabaseUrl}/rest/v1/events?slug=eq.${EVENT_SLUG}&select=id,name`, { headers: restHeaders })
  expect(res.ok(), await res.text()).toBe(true)
  const [event] = await res.json()
  expect(event?.id).toBeTruthy()
  return event as { id: string; name: string }
}

test('admin atproto routes reject unsigned requests', async ({ request }) => {
  const url = `${base}/api/v1/events/${EVENT_SLUG}/admin/atproto`
  expect((await request.get(url)).status()).toBe(401)
  expect((await request.post(url, { data: { handle: 'x.bsky.social', appPassword: 'nope' } })).status()).toBe(401)
  expect((await request.delete(url)).status()).toBe(401)
  expect((await request.post(`${url}/publish`, { data: { what: 'all' } })).status()).toBe(401)
  expect((await request.post(`${url}/sessions/${FAKE_SESSION}`, { data: { action: 'republish' } })).status()).toBe(401)
})

test('computeTally suppresses sessions with fewer than k voters and never leaks who voted', async () => {
  const rows: VoteRow[] = [
    { session_id: 's-popular', user_id: 'u1', vote_count: 3, credits_spent: 9 },
    { session_id: 's-popular', user_id: 'u2', vote_count: 1, credits_spent: 1 },
    { session_id: 's-popular', user_id: 'u3', vote_count: 2, credits_spent: 4 },
    { session_id: 's-quiet', user_id: 'u1', vote_count: 5, credits_spent: 25 },
    { session_id: 's-quiet', user_id: 'u2', vote_count: 1, credits_spent: 1 },
  ]
  const tally = await computeTally('any-event', 3, async () => rows)
  expect(tally.k).toBe(3)
  expect(tally.ballotsCast).toBe(3)
  const popular = tally.entries.find((e) => e.sessionId === 's-popular')
  const quiet = tally.entries.find((e) => e.sessionId === 's-quiet')
  expect(popular).toEqual({ sessionId: 's-popular', suppressed: false, voters: 3, votes: 6, credits: 14 })
  expect(quiet).toEqual({ sessionId: 's-quiet', suppressed: true })
  expect(JSON.stringify(tally)).not.toMatch(/u[123]/)

  // k=2 lifts the suppression on the quiet one.
  const loose = await computeTally('any-event', 2, async () => rows)
  expect(loose.entries.find((e) => e.sessionId === 's-quiet')).toMatchObject({ suppressed: false, voters: 2, votes: 6 })
})

test.describe('publish pipeline against the seeded event (fake PDS, nothing persisted)', () => {
  test.skip(!local, 'Publish tests only run against local Supabase')

  test('gathering records use deterministic rkeys and validate', async ({ request }) => {
    expect(serviceKey, 'TEST_SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required').not.toBe('')
    const event = await seededEvent(request)

    const first = fakeDeps()
    const a = await publishGathering({ eventId: event.id, callerUserId: null }, first.deps)
    expect(a.results.filter((r) => r.error)).toEqual([])
    expect(a.results.map((r) => r.kind)).toEqual(['policy', 'gathering-event', 'gathering-config', 'gathering'])

    const second = fakeDeps()
    await publishGathering({ eventId: event.id, callerUserId: null }, second.deps)
    expect(second.calls.map((c) => `${c.collection}/${c.rkey}`)).toEqual(first.calls.map((c) => `${c.collection}/${c.rkey}`))

    const gathering = first.calls.find((c) => c.collection === NSID.gathering)!
    expect(gathering.rkey).toBe(SELF_RKEY)
    expect(gathering.action).toBe('publish-gathering')
    expect(gathering.reason).toContain(event.name)
    assertValidRecord(NSID.gathering, gathering.record)
    expect(gathering.record.event).toMatchObject({ uri: expect.stringContaining(NSID.event), cid: expect.stringMatching(/^bafy/) })
    const policy = first.calls.find((c) => c.collection === NSID.policy)!
    expect(policy.rkey).toBe(deterministicRkey('policy', event.id, 'v1'))
    assertValidRecord(NSID.policy, policy.record)
    expect(gathering.record.policy).toBe(`at://${ACTOR_DID}/${NSID.policy}/${policy.rkey}`)

    const calendar = first.calls.find((c) => c.collection === NSID.event)!
    expect(calendar.rkey).toBe(deterministicRkey('gathering', event.id))
    assertValidRecord(NSID.event, calendar.record)
    assertNoUnknownFields(NSID.event, calendar.record)
    expect(calendar.record.uris).toEqual([{ uri: expect.stringContaining(`/e/${EVENT_SLUG}`), name: 'Schelling Point' }])

    const config = first.calls.find((c) => c.collection === NSID.eventConfig)!
    assertValidRecord(NSID.eventConfig, config.record)
    assertNoUnknownFields(NSID.eventConfig, config.record)
    expect(config.record.school).toBe(ACTOR_DID)
  })

  test('schedule publish writes valid session events, pins the stub proposal cid, and names no host', async ({ request }) => {
    const event = await seededEvent(request)
    const sessionsRes = await request.get(
      `${supabaseUrl}/rest/v1/sessions?event_id=eq.${event.id}&status=eq.scheduled&time_slot_id=not.is.null&select=id,host_name,description&order=created_at&limit=3`,
      { headers: restHeaders },
    )
    expect(sessionsRes.ok()).toBe(true)
    const sessions = (await sessionsRes.json()) as Array<{ id: string; host_name: string | null; description: string | null }>
    expect(sessions.length, 'the seed must contain scheduled sessions with time slots').toBeGreaterThan(0)
    const sessionIds = sessions.map((s) => s.id)

    const run1 = fakeDeps()
    const out1 = await publishSchedule({ eventId: event.id, callerUserId: null, sessionIds }, run1.deps)
    expect(out1.results.filter((r) => r.error)).toEqual([])
    const run2 = fakeDeps()
    await publishSchedule({ eventId: event.id, callerUserId: null, sessionIds }, run2.deps)

    // Idempotent: same collections, same rkeys, same order, both runs.
    const keys = (calls: PutAsGatheringInput[]) => calls.map((c) => `${c.collection}/${c.rkey}`)
    expect(keys(run2.calls)).toEqual(keys(run1.calls))
    expect(new Set(keys(run1.calls)).size).toBe(run1.calls.length)

    for (const session of sessions) {
      const calendar = run1.calls.find((c) => c.collection === NSID.event && c.rkey === deterministicRkey('session', session.id))!
      expect(calendar, `calendar event for ${session.id}`).toBeTruthy()
      assertValidRecord(NSID.event, calendar.record)
      assertNoUnknownFields(NSID.event, calendar.record)
      expect(calendar.action).toBe('publish-slot')
      expect(calendar.record.uris).toEqual([{ uri: expect.stringContaining(`/sessions/${session.id}`), name: 'Schelling Point' }])

      const config = run1.calls.find((c) => c.collection === NSID.eventConfig && c.rkey === deterministicRkey('config', session.id))!
      assertValidRecord(NSID.eventConfig, config.record)
      assertNoUnknownFields(NSID.eventConfig, config.record)
      expect(config.record.event).toEqual({ uri: `at://${ACTOR_DID}/${NSID.event}/${calendar.rkey}`, cid: run1.store.get(`at://${ACTOR_DID}/${NSID.event}/${calendar.rkey}`)!.cid })

      // No proposer-published proposal in the seed, so the slot pins a gathering-written stub.
      const stubRkey = deterministicRkey('proposal-stub', session.id)
      const stub = run1.calls.find((c) => c.collection === NSID.proposal && c.rkey === stubRkey)!
      expect(stub.action).toBe('publish-stub-proposal')
      assertValidRecord(NSID.proposal, stub.record)
      expect(stub.record).toMatchObject({ imported: true, importedFrom: 'schellingpoint', gathering: `at://${ACTOR_DID}/${NSID.gathering}/self` })
      for (const key of Object.keys(stub.record)) expect(key.toLowerCase()).not.toMatch(/host|speaker|cohost/)
      if (session.host_name) {
        const { description: _description, ...rest } = stub.record
        void _description
        expect(JSON.stringify(rest)).not.toContain(session.host_name)
      }

      const slot = run1.calls.find((c) => c.collection === NSID.slot && c.rkey === deterministicRkey('slot', session.id))!
      assertValidRecord(NSID.slot, slot.record)
      const stubCid = run1.store.get(`at://${ACTOR_DID}/${NSID.proposal}/${stubRkey}`)!.cid
      expect(slot.record.proposal).toEqual({ uri: `at://${ACTOR_DID}/${NSID.proposal}/${stubRkey}`, cid: stubCid })
      expect(slot.record.event).toEqual(config.record.event)
      expect(slot.record).toMatchObject({ status: 'scheduled', startsAt: calendar.record.startsAt, endsAt: calendar.record.endsAt })
    }

    // Nothing the gathering writes carries a user id or a DID other than its own.
    // (Session page URLs legitimately carry the session's own uuid; nothing else may.)
    const everything = JSON.stringify(run1.calls.map((c) => c.record)).replace(/\/sessions\/[0-9a-f-]{36}/gi, '/sessions/X')
    expect(everything).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    expect(everything.match(/did:plc:[a-z0-9]+/g)?.every((d) => d === ACTOR_DID)).toBe(true)
  })

  test('the tally record validates, suppresses under k and carries no user ids', async ({ request }) => {
    const event = await seededEvent(request)
    const sessionsRes = await request.get(
      `${supabaseUrl}/rest/v1/sessions?event_id=eq.${event.id}&select=id&order=created_at&limit=2`,
      { headers: restHeaders },
    )
    const [popular, quiet] = (await sessionsRes.json()) as Array<{ id: string }>
    expect(popular?.id && quiet?.id).toBeTruthy()
    const voters = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
    const rows: VoteRow[] = [
      ...voters.map((user_id) => ({ session_id: popular.id, user_id, vote_count: 2, credits_spent: 4 })),
      { session_id: quiet.id, user_id: voters[0], vote_count: 9, credits_spent: 81 },
    ]

    const run = fakeDeps()
    const out = await publishTally({ eventId: event.id, callerUserId: null, round: 'pre-event' }, run.deps, { loadVotes: async () => rows })
    expect(out.results.filter((r) => r.error)).toEqual([])

    const tallyCall = run.calls.find((c) => c.collection === NSID.tally)!
    expect(tallyCall.rkey).toBe(deterministicRkey('tally', event.id, 'pre-event'))
    expect(tallyCall.action).toBe('publish-tally')
    assertValidRecord(NSID.tally, tallyCall.record)
    const record = tallyCall.record as { k: number; ballotsCast: number; entries: Array<Record<string, unknown>> }
    expect(record.k).toBe(3)
    expect(record.ballotsCast).toBe(3)
    expect(record.entries).toHaveLength(2)
    const stubUri = (id: string) => `at://${ACTOR_DID}/${NSID.proposal}/${deterministicRkey('proposal-stub', id)}`
    const popularEntry = record.entries.find((e) => (e.proposal as { uri: string }).uri === stubUri(popular.id))!
    const quietEntry = record.entries.find((e) => (e.proposal as { uri: string }).uri === stubUri(quiet.id))!
    expect(popularEntry).toMatchObject({ suppressed: false, voters: 3, votes: 6, credits: 12 })
    expect(quietEntry).toEqual({ proposal: { uri: stubUri(quiet.id), cid: expect.stringMatching(/^bafy/) }, suppressed: true })
    expect(Object.keys(quietEntry)).not.toContain('votes')

    const text = JSON.stringify(tallyCall.record)
    for (const v of voters) expect(text).not.toContain(v)
    expect(text).not.toContain(popular.id)
    expect(text).not.toContain(quiet.id)
  })
})
