import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { execFileSync } from 'node:child_process'
import Module from 'node:module'
import path from 'node:path'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

// The ATProto layer end to end against the REAL local stack — no fakes on the happy path:
//   dev server :3001 (RESEND_API_KEY unset), Postgres :55432, PLC :2582, PDS :2583 (handles *.test).
//
// Three custodial accounts sign in through the real email door (tests/helpers): an owner and an
// admin of a gathering this file creates (never a seeded one), and a proposer. The test mints the
// gathering's DID through the admin API, publishes the
// gathering, proposes a session into the proposer's own repo, schedules and publishes it, moves it
// through a two-organiser approval, drifts the proposal, publishes a tally, and checks the TLS gate,
// reconciliation and the privacy audit. Everything it created is removed afterwards — the gathering,
// its minted identity and every PDS account included.
loadEnvConfig(process.cwd(), true)

const base = 'http://localhost:3001'
const pds = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const migrationUrl = process.env.DATABASE_MIGRATION_URL || ''
const adminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const handleDomain = (process.env.PDS_HANDLE_DOMAIN || '').replace(/^\./, '')
const configured = Boolean(pds && migrationUrl && adminPassword && handleDomain && process.env.DATABASE_URL)

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

// `src/lib/**` starts with `import 'server-only'`; resolve it to Next's empty stub in this process.
type Resolver = (request: string, ...rest: unknown[]) => string
const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = moduleWithResolver._resolveFilename
const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
}

type Person = TestAccount

async function xrpcGet<T = { uri: string; cid: string; value: Record<string, unknown> }>(nsid: string, params: Record<string, string>): Promise<{ status: number; body: T }> {
  const url = new URL(`${pds}/xrpc/${nsid}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const res = await fetch(url)
  return { status: res.status, body: (await res.json()) as T }
}

async function getRecordLive(uri: string) {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) throw new Error(`not an at-uri: ${uri}`)
  return xrpcGet('com.atproto.repo.getRecord', { repo: m[1]!, collection: m[2]!, rkey: m[3]! })
}

async function api<T = Record<string, unknown>>(person: Person, method: string, pathname: string, json?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { cookie: person.cookie, origin: base, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
  const text = await res.text()
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T }
}

function bareDids(node: unknown, found: string[] = []): string[] {
  if (typeof node === 'string') {
    if (!node.startsWith('at://') && /did:[a-z]+:/.test(node)) found.push(node)
  } else if (Array.isArray(node)) node.forEach((n) => bareDids(n, found))
  else if (node && typeof node === 'object') Object.values(node).forEach((n) => bareDids(n, found))
  return found
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('ATProto layer against the local PDS', () => {
  test.skip(!configured, 'the local stack env (PDS_URL, DATABASE_MIGRATION_URL, PDS_ADMIN_PASSWORD, PDS_HANDLE_DOMAIN) is not set')
  test.setTimeout(180_000)

  let raw: postgres.Sql
  let lib: {
    rkey: typeof import('../src/lib/atproto/rkey')
    publish: typeof import('../src/lib/atproto/publish')
    tally: typeof import('../src/lib/atproto/tally')
    agent: typeof import('../src/lib/atproto/agent')
    nsids: typeof import('../src/lib/atproto/nsids')
    db: typeof import('../src/lib/db')
  }
  const people: Record<'owner' | 'admin' | 'proposer', Person> = {} as never
  let gathering: TestGathering | null = null
  let SLUG = ''
  let eventId = ''
  let eventName = ''
  let actorDid = ''
  let sessionId = ''
  let slotA: { id: string; start_time: string; venue_id: string }
  let slotB: { id: string; start_time: string; venue_id: string }
  const gatheringUrisToRemove = new Set<string>()

  test.beforeAll(async () => {
    // require (not import) so Playwright's TypeScript loader handles the files after the shim.
    /* eslint-disable @typescript-eslint/no-require-imports */
    lib = {
      rkey: require('../src/lib/atproto/rkey'),
      publish: require('../src/lib/atproto/publish'),
      tally: require('../src/lib/atproto/tally'),
      agent: require('../src/lib/atproto/agent'),
      nsids: require('../src/lib/atproto/nsids'),
      db: require('../src/lib/db'),
    }
    /* eslint-enable @typescript-eslint/no-require-imports */
    raw = postgres(migrationUrl, { max: 2, onnotice: () => {} })

    // No identity yet: the first test mints it through the admin API.
    gathering = await createTestGathering(raw, { tag: 'e2e', status: 'proposals_open', withProgram: true, policyThresholds: { destructiveActionStewards: 2 } })
    eventId = gathering.id
    eventName = gathering.name
    SLUG = gathering.slug

    for (const role of ['owner', 'admin', 'proposer'] as const) {
      people[role] = await createTestAccount(`e2e-${role}`, { sql: raw, base })
      await raw`
        insert into event_members (event_id, user_id, role) values (${eventId}, ${people[role].id}, ${role === 'proposer' ? 'attendee' : role})
      `
    }
    const slots = await raw<{ id: string; start_time: Date; venue_id: string }[]>`
      select id, start_time, venue_id from time_slots
      where event_id = ${eventId} and venue_id is not null and coalesce(is_break, false) = false
      order by start_time, id limit 2 offset 3
    `
    slotA = { ...slots[0]!, start_time: slots[0]!.start_time.toISOString() }
    slotB = { ...slots[1]!, start_time: slots[1]!.start_time.toISOString() }
  })

  test.afterAll(async () => {
    if (!raw) return
    try {
      // The gathering (sessions, series, listings, grids, approvals, audit rows) and the identity
      // minted for it — its PDS repo with every record this run wrote — go first; then the people.
      await gathering?.cleanup()
      for (const p of Object.values(people)) await p.cleanup()
    } finally {
      moduleWithResolver._resolveFilename = originalResolve
      await raw.end({ timeout: 5 })
      await lib?.db.sql.end({ timeout: 5 }).catch(() => undefined)
    }
  })

  test('an organiser mints the gathering DID and publishes gathering, policy, venues, tracks and slot grids', async () => {
    const minted = await api<{ actorDid: string; actorHandle: string; health: { state: string } }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto`, { action: 'mint' })
    expect(minted.status, JSON.stringify(minted.body)).toBe(200)
    expect(minted.body.actorDid).toMatch(/^did:plc:/)
    actorDid = minted.body.actorDid
    expect(minted.body.actorHandle).toBe(`${SLUG}.${handleDomain}`)
    const again = await api<{ minted: boolean; actorDid: string }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto`, { action: 'mint' })
    expect(again.body).toMatchObject({ minted: false, actorDid })

    const published = await api<{ published: number; failed: number; results: Array<{ kind: string; error?: string }> }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto/publish`, { what: 'all' })
    expect(published.status, JSON.stringify(published.body)).toBe(200)
    expect(published.body.results.filter((r) => r.error)).toEqual([])
    expect(published.body.published).toBeGreaterThan(5)

    const gathering = await xrpcGet('com.atproto.repo.getRecord', { repo: actorDid, collection: 'schellingpoint.draft.gathering', rkey: 'self' })
    expect(gathering.status).toBe(200)
    expect(gathering.body.value.name).toBe(eventName)
    const policy = await getRecordLive(gathering.body.value.policy as string)
    expect(policy.body.value.thresholds).toMatchObject({ destructiveActionStewards: 2, feedbackK: 3, publishRoles: false })
    const calendar = gathering.body.value.event as { uri: string; cid: string }
    expect((await getRecordLive(calendar.uri)).body.cid).toBe(calendar.cid)

    const [{ venues }] = await raw<{ venues: number }[]>`select count(*)::int as venues from venues where event_id = ${eventId}`
    const listed = await xrpcGet<{ records: unknown[] }>('com.atproto.repo.listRecords', { repo: actorDid, collection: 'schellingpoint.draft.venue', limit: '100' })
    expect(listed.body.records.length).toBe(venues)
    const grids = await xrpcGet<{ records: unknown[] }>('com.atproto.repo.listRecords', { repo: actorDid, collection: 'schellingpoint.draft.slotGrid', limit: '100' })
    expect(grids.body.records.length).toBeGreaterThan(0)

    // Read-your-writes: the index already holds what was just written.
    const [{ indexed }] = await raw<{ indexed: number }[]>`select count(*)::int as indexed from at_records where uri = ${gathering.body.uri} and cid = ${gathering.body.cid}`
    expect(indexed).toBe(1)
  })

  test('a custodial author’s proposal lands in THEIR repo', async () => {
    const [{ allowed_formats, allowed_durations }] = await raw<{ allowed_formats: string[]; allowed_durations: number[] }[]>`
      select allowed_formats, allowed_durations from events where id = ${eventId}
    `
    const [session] = await raw<{ id: string }[]>`
      insert into sessions (event_id, title, description, format, duration, host_id, status, topic_tags)
      values (${eventId}, ${`Commons governance lab ${RUN}`}, 'Designing shared rules together.', ${allowed_formats[0]!}, ${allowed_durations[allowed_durations.length - 1]!},
              ${people.proposer.id}, 'pending', ${['governance']})
      returning id
    `
    sessionId = session!.id

    const res = await api<{ uri: string; cid: string }>(people.proposer, 'POST', `/api/v1/events/${SLUG}/sessions/${sessionId}/atproto`, { action: 'publish-proposal' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.uri.startsWith(`at://${people.proposer.did}/schellingpoint.draft.proposal/`)).toBe(true)

    const live = await getRecordLive(res.body.uri)
    expect(live.status).toBe(200)
    expect(live.body.cid).toBe(res.body.cid)
    expect(live.body.value.title).toBe(`Commons governance lab ${RUN}`)
    expect(live.body.value.gathering).toBe(`at://${actorDid}/schellingpoint.draft.gathering/self`)
    expect(bareDids(live.body.value)).toEqual([])

    // Nobody else can publish it.
    const forged = await api(people.owner, 'POST', `/api/v1/events/${SLUG}/sessions/${sessionId}/atproto`, { action: 'publish-proposal' })
    expect(forged.status).toBe(403)
  })

  test('publishing the schedule writes calendar event, config and slot whose strongRefs match', async () => {
    await raw`update sessions set status = 'scheduled', time_slot_id = ${slotA.id}, venue_id = ${slotA.venue_id} where id = ${sessionId}`
    const res = await api<{ results: Array<{ kind: string; id: string; error?: string; uri?: string }> }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto/publish`, { what: 'schedule' })
    expect(res.status).toBe(200)
    const mine = res.body.results.filter((r) => r.id === sessionId)
    expect(mine.filter((r) => r.error)).toEqual([])
    expect(mine.map((r) => r.kind).sort()).toEqual(['session-config', 'session-event', 'slot'])

    const [row] = await raw<{ calendar_event_uri: string; calendar_event_cid: string; slot_uri: string; slot_cid: string; proposal_uri: string; proposal_cid: string }[]>`
      select calendar_event_uri, calendar_event_cid, slot_uri, slot_cid, proposal_uri, proposal_cid from sessions where id = ${sessionId}
    `
    const calendar = await getRecordLive(row!.calendar_event_uri)
    expect(calendar.body.cid).toBe(row!.calendar_event_cid)
    expect(calendar.body.value.status).toBe('community.lexicon.calendar.event#scheduled')
    expect(calendar.body.value.startsAt).toBe(slotA.start_time)
    const config = await xrpcGet('com.atproto.repo.getRecord', { repo: actorDid, collection: 'coop.lexicon.event.config', rkey: lib.rkey.deterministicRkey('config', sessionId) })
    expect(config.body.value.event).toEqual({ uri: row!.calendar_event_uri, cid: row!.calendar_event_cid })
    const slot = await getRecordLive(row!.slot_uri)
    expect(slot.body.cid).toBe(row!.slot_cid)
    expect(slot.body.value.event).toEqual({ uri: row!.calendar_event_uri, cid: row!.calendar_event_cid })
    expect(slot.body.value.proposal).toEqual({ uri: row!.proposal_uri, cid: row!.proposal_cid })
    for (const r of [calendar, config, slot]) expect(bareDids(r.body.value).filter((d) => d !== actorDid)).toEqual([])
    gatheringUrisToRemove.add(row!.calendar_event_uri).add(row!.slot_uri).add(config.body.uri)

    // A second publish is idempotent: the same records, the same cids.
    await api(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto/publish`, { what: 'schedule' })
    const [after] = await raw<{ slot_cid: string; calendar_event_cid: string }[]>`select slot_cid, calendar_event_cid from sessions where id = ${sessionId}`
    expect(after).toEqual({ slot_cid: row!.slot_cid, calendar_event_cid: row!.calendar_event_cid })
  })

  test('the actor port refuses a destructive write without organiser approvals', async () => {
    const out = await lib.publish.moveSession({ eventId, callerUserId: people.owner.id, sessionId, target: { timeSlotId: slotB.id } })
    const event = out.results.find((r) => r.kind === 'session-event')
    expect(event?.error).toMatch(/needs 2 organiser approvals, have 0/)
    const [deny] = await raw<{ n: number }[]>`
      select count(*)::int as n from at_audit where event_id = ${eventId} and action = 'move-slot' and decision = 'deny' and created_at > now() - interval '1 minute'
    `
    expect(deny!.n).toBeGreaterThan(0)
  })

  test('moving a published session waits for a second organiser; approvals live in each organiser’s repo', async () => {
    const [before] = await raw<{ slot_uri: string; slot_cid: string; calendar_event_uri: string }[]>`select slot_uri, slot_cid, calendar_event_uri from sessions where id = ${sessionId}`
    const requested = await api<{ status: string; approvalsNeeded: number; requestId: string }>(people.owner, 'POST', `/api/v1/events/${SLUG}/approvals`, {
      action: 'request-move',
      sessionId,
      reason: 'The Workshop Room has the projector this session needs',
      target: { timeSlotId: slotB.id },
    })
    expect(requested.status, JSON.stringify(requested.body)).toBe(200)
    expect(requested.body).toMatchObject({ status: 'awaiting_approval', approvalsNeeded: 1 })
    const [still] = await raw<{ time_slot_id: string; slot_cid: string }[]>`select time_slot_id, slot_cid from sessions where id = ${sessionId}`
    expect(still).toEqual({ time_slot_id: slotA.id, slot_cid: before!.slot_cid })

    const [ownerApproval] = await raw<{ record_uri: string; record_cid: string }[]>`
      select record_uri, record_cid from approval_request_approvals where request_id = ${requested.body.requestId} and account_id = ${people.owner.id}
    `
    expect(ownerApproval!.record_uri.startsWith(`at://${people.owner.did}/freeschool.draft.approval/`)).toBe(true)
    const ownerRecord = await getRecordLive(ownerApproval!.record_uri)
    expect(ownerRecord.body.cid).toBe(ownerApproval!.record_cid)
    expect(ownerRecord.body.value.proposal).toBe(`at://${actorDid}/schellingpoint.draft.slot/${lib.publish.movedSlotRkey(sessionId, slotB.start_time)}`)
    expect(ownerRecord.body.value.subjectRecord).toBe(before!.slot_uri)
    expect(bareDids(ownerRecord.body.value)).toEqual([])
    const [askedAdmin] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${people.admin.id} and type = 'approval_requested'`
    expect(askedAdmin!.n).toBe(1)

    // The requester approving again changes nothing.
    const repeat = await api<{ status: string; approvalsNeeded: number }>(people.owner, 'POST', `/api/v1/events/${SLUG}/approvals`, { action: 'approve', requestId: requested.body.requestId })
    expect(repeat.body).toMatchObject({ status: 'awaiting_approval', approvalsNeeded: 1 })

    const approved = await api<{ status: string; approvalsNeeded: number }>(people.admin, 'POST', `/api/v1/events/${SLUG}/approvals`, { action: 'approve', requestId: requested.body.requestId })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
    expect(approved.body).toMatchObject({ status: 'applied', approvalsNeeded: 0 })

    const [adminApproval] = await raw<{ record_uri: string }[]>`
      select record_uri from approval_request_approvals where request_id = ${requested.body.requestId} and account_id = ${people.admin.id}
    `
    expect(adminApproval!.record_uri.startsWith(`at://${people.admin.did}/freeschool.draft.approval/`)).toBe(true)
    expect((await getRecordLive(adminApproval!.record_uri)).status).toBe(200)

    const [moved] = await raw<{ time_slot_id: string; slot_uri: string; slot_cid: string; calendar_event_uri: string }[]>`
      select time_slot_id, slot_uri, slot_cid, calendar_event_uri from sessions where id = ${sessionId}
    `
    expect(moved!.time_slot_id).toBe(slotB.id)
    expect(moved!.calendar_event_uri).toBe(before!.calendar_event_uri)
    expect(moved!.slot_uri).not.toBe(before!.slot_uri)
    gatheringUrisToRemove.add(moved!.slot_uri)
    const newSlot = await getRecordLive(moved!.slot_uri)
    expect(newSlot.body.value.supersedes).toEqual({ uri: before!.slot_uri, cid: before!.slot_cid })
    expect(newSlot.body.value.startsAt).toBe(slotB.start_time)
    expect(newSlot.body.value.status).toBe('scheduled')
    const oldSlot = await getRecordLive(before!.slot_uri)
    expect(oldSlot.body.value.status).toBe('moved')
    const calendar = await getRecordLive(moved!.calendar_event_uri)
    expect(calendar.body.value.status).toBe('community.lexicon.calendar.event#rescheduled')
    expect(calendar.body.value.startsAt).toBe(slotB.start_time)

    const [audit] = await raw<{ approvals: unknown[] }[]>`
      select approvals from at_audit where event_id = ${eventId} and action = 'move-slot' and decision = 'allow' order by created_at desc limit 1
    `
    expect(audit!.approvals).toHaveLength(2)
    const [told] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${people.proposer.id} and type = 'session_rescheduled'`
    expect(told!.n).toBe(1)
  })

  test('a proposer’s edit after publishing is cid drift: flagged, then adopted on re-publish', async () => {
    await raw`update sessions set title = ${`Commons governance lab ${RUN} (revised)`} where id = ${sessionId}`
    const edit = await api<{ cid: string }>(people.proposer, 'POST', `/api/v1/events/${SLUG}/sessions/${sessionId}/atproto`, { action: 'publish-proposal' })
    expect(edit.status).toBe(200)
    const [flagged] = await raw<{ proposal_drift_cid: string | null; proposal_cid: string }[]>`select proposal_drift_cid, proposal_cid from sessions where id = ${sessionId}`
    expect(flagged!.proposal_drift_cid).toBe(edit.body.cid)
    const [notice] = await raw<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${people.owner.id} and type = 'proposal_changed'`
    expect(notice!.n).toBe(1)

    const republished = await api<{ results: Array<{ kind: string; error?: string }> }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto/sessions/${sessionId}`, { action: 'republish' })
    expect(republished.status, JSON.stringify(republished.body)).toBe(200)
    expect(republished.body.results.filter((r) => r.error)).toEqual([])
    const [cleared] = await raw<{ proposal_drift_cid: string | null; slot_uri: string; calendar_event_uri: string }[]>`select proposal_drift_cid, slot_uri, calendar_event_uri from sessions where id = ${sessionId}`
    expect(cleared!.proposal_drift_cid).toBeNull()
    const slot = await getRecordLive(cleared!.slot_uri)
    expect((slot.body.value.proposal as { cid: string }).cid).toBe(edit.body.cid)
    const calendar = await getRecordLive(cleared!.calendar_event_uri)
    expect(calendar.body.value.name).toBe(`Commons governance lab ${RUN} (revised)`)
    expect(calendar.body.value.status).toBe('community.lexicon.calendar.event#rescheduled')
  })

  test('the published tally carries counts and strongRefs, never a DID', async () => {
    const out = await lib.tally.publishTally({ eventId, callerUserId: people.owner.id, round: 'pre-event' }, undefined, {
      loadTally: async () => ({
        roundId: `e2e-${RUN}`,
        mechanism: 'quadratic',
        creditsPerVoter: 100,
        closedAt: new Date().toISOString(),
        k: 3,
        ballotsCast: 4,
        entries: [{ sessionId, suppressed: false, voters: 4, votes: 7, credits: 19 }],
      }),
      loadSessions: async (id, ids) =>
        lib.db.sql`
          select s.*, t.at_uri as track_at_uri from sessions s left join tracks t on t.id = s.track_id
          where s.event_id = ${id} and s.id in ${lib.db.sql(ids)}
        ` as never,
    })
    const written = out.results.find((r) => r.kind === 'tally')
    expect(written?.error).toBeUndefined()
    gatheringUrisToRemove.add(written!.uri!)
    const tally = await getRecordLive(written!.uri!)
    expect(tally.status).toBe(200)
    expect(bareDids(tally.body.value)).toEqual([])
    const json = JSON.stringify(tally.body.value)
    for (const p of Object.values(people)) {
      expect(json).not.toContain(p.id)
      expect(json).not.toContain(p.handle)
    }
    expect((tally.body.value.entries as Array<Record<string, unknown>>)[0]).toMatchObject({ suppressed: false, voters: 4, votes: 7, credits: 19 })
  })

  test('a recurring gathering materializes tagged occurrences with back-pointers, once', async () => {
    await raw`update events set atproto_tags = ${['unconference', `f-e2e-${RUN}`]} where id = ${eventId}`
    const republished = await api<{ results: Array<{ error?: string }> }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto/publish`, { what: 'gathering' })
    expect(republished.body.results.filter((r) => r.error)).toEqual([])
    const created = await api<{ seriesId: string; uri: string; results: Array<{ kind: string; id: string; uri?: string; error?: string }> }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto`, {
      action: 'create-series',
      series: { freq: 'weekly', count: 3, materializeAheadDays: 730 },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    gatheringUrisToRemove.add(created.body.uri)
    for (const r of created.body.results) if (r.uri) gatheringUrisToRemove.add(r.uri)
    expect(created.body.results.filter((r) => r.error)).toEqual([])
    const events = created.body.results.filter((r) => r.kind === 'occurrence' && !/:(config|sidecar)$/.test(r.id))
    expect(events).toHaveLength(2) // count 3 = the first event plus two occurrences

    const series = await getRecordLive(created.body.uri)
    expect(series.body.value).toMatchObject({ rrule: 'FREQ=WEEKLY;COUNT=3', freq: 'weekly', timezone: expect.any(String) })
    const sidecar = created.body.results.find((r) => r.id.endsWith(':sidecar'))!
    const occurrence = await getRecordLive(sidecar.uri!)
    expect((occurrence.body.value.series as { uri: string }).uri).toBe(created.body.uri)
    const occEvent = occurrence.body.value.event as { uri: string; cid: string }
    expect((await getRecordLive(occEvent.uri)).body.cid).toBe(occEvent.cid)
    const config = created.body.results.find((r) => r.id.endsWith(':config'))!
    expect((await getRecordLive(config.uri!)).body.value.tags).toEqual(['unconference', `f-e2e-${RUN}`])

    const again = await api<{ results: unknown[] }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto`, { action: 'materialize-series', seriesId: created.body.seriesId })
    expect(again.body.results).toEqual([])
    await raw`update events set atproto_tags = '{}' where id = ${eventId}`
  })

  test('a session whose tags route is listed with a full strongRef; withdrawal is sticky', async () => {
    const publishSchedule = () => api<{ results: Array<{ kind: string; id: string; uri?: string; error?: string }> }>(people.owner, 'POST', `/api/v1/events/${SLUG}/admin/atproto/publish`, { what: 'schedule' })
    await raw`update events set atproto_tags = ${['governance']} where id = ${eventId}`
    const listed = await publishSchedule()
    const listing = listed.body.results.find((r) => r.kind === 'listing' && r.id === sessionId)
    expect(listing?.error).toBeUndefined()
    expect(listing?.uri).toBeTruthy()
    gatheringUrisToRemove.add(listing!.uri!)
    const [row] = await raw<{ calendar_event_uri: string; calendar_event_cid: string }[]>`select calendar_event_uri, calendar_event_cid from sessions where id = ${sessionId}`
    const record = await getRecordLive(listing!.uri!)
    expect(record.body.value).toMatchObject({ event: { uri: row!.calendar_event_uri, cid: row!.calendar_event_cid }, school: actorDid, status: 'listed', tags: ['governance'] })

    await raw`update events set atproto_tags = ${['something-else']} where id = ${eventId}`
    await publishSchedule()
    expect((await getRecordLive(listing!.uri!)).body.value.status).toBe('removed')
    await raw`update events set atproto_tags = ${['governance']} where id = ${eventId}`
    const back = await publishSchedule()
    expect(back.body.results.find((r) => r.kind === 'listing' && r.id === sessionId)).toBeUndefined()
    expect((await getRecordLive(listing!.uri!)).body.value.status).toBe('removed')
    await raw`update events set atproto_tags = '{}' where id = ${eventId}`
  })

  test('a public role claim needs policy, opt-in and host role, and retracts when consent ends', async () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const claims = require('../src/lib/atproto/role-claims') as typeof import('../src/lib/atproto/role-claims')
    const records = require('../src/lib/atproto/records') as typeof import('../src/lib/atproto/records')
    /* eslint-enable @typescript-eslint/no-require-imports */
    const rkey = records.membershipClaimRkey(actorDid, people.proposer.did)
    const uri = `at://${actorDid}/coop.lexicon.membership/${rkey}`
    gatheringUrisToRemove.add(uri)

    expect((await claims.setRoleClaimOptIn(people.proposer.id, eventId, true)).outcome).toBe('policy-off')
    await raw`update events set policy_thresholds = jsonb_set(policy_thresholds, '{publishRoles}', 'true') where id = ${eventId}`
    expect((await claims.setRoleClaimOptIn(people.admin.id, eventId, false)).outcome).toBe('not-opted-in')
    const published = await claims.syncRoleClaim(eventId, people.proposer.id)
    expect(published).toMatchObject({ outcome: 'published', role: 20, uri })
    const record = await getRecordLive(uri)
    expect(record.body.value).toMatchObject({ subject: people.proposer.did, role: 20, school: actorDid, addedBy: actorDid })
    expect((await claims.syncRoleClaim(eventId, people.proposer.id)).outcome).toBe('unchanged')

    // The audit's single exemption holds while all three gates are open…
    const audit = execFileSync('npx', ['tsx', 'scripts/atproto-privacy-audit.ts'], { encoding: 'utf8' })
    expect(audit).toContain('PASS')

    // …and consent ending removes the claim.
    expect((await claims.setRoleClaimOptIn(people.proposer.id, eventId, false)).outcome).toBe('retracted')
    expect((await getRecordLive(uri)).status).toBe(400)
    await raw`update events set policy_thresholds = jsonb_set(policy_thresholds, '{publishRoles}', 'false') where id = ${eventId}`
  })

  test('the on-demand TLS gate answers from closed sets', async () => {
    const ask = async (domain: string) => (await fetch(`${base}/internal/tls-check?domain=${encodeURIComponent(domain)}`)).status
    const web = new URL(process.env.NEXT_PUBLIC_APP_URL || base).hostname
    expect(await ask(`www.${web}`)).toBe(200)
    expect(await ask(new URL(process.env.PDS_URL || pds).hostname)).toBe(200)
    expect(await ask(`${SLUG}.${handleDomain}`)).toBe(200)
    expect(await ask(people.proposer.handle)).toBe(200)
    expect(await ask(`nobody-${RUN}.${handleDomain}`)).toBe(403)
    expect(await ask('example.com')).toBe(403)
    expect(await ask(`a.b.${handleDomain}`)).toBe(403)
    expect(await ask('')).toBe(403)
  })

  test('reconciliation indexes our PDS repos, and the public records API applies visibility', async () => {
    const sync = await fetch(`${base}/api/atproto/sync`, { headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} })
    const body = await sync.json()
    expect(sync.status, JSON.stringify(body)).toBe(200)
    expect(body.repos).toBeGreaterThanOrEqual(4)
    const [proposal] = await raw<{ n: number }[]>`
      select count(*)::int as n from at_records where did = ${people.proposer.did} and collection = 'schellingpoint.draft.proposal'
    `
    expect(proposal!.n).toBe(1)
    const records = await fetch(`${base}/api/atproto/records?event=${SLUG}&collection=schellingpoint.draft.proposal`)
    const list = (await records.json()) as Array<{ did: string }>
    expect(list.some((r) => r.did === people.proposer.did)).toBe(true)
    expect((await fetch(`${base}/api/atproto/records?event=draft-gathering`)).status).toBe(404)
  })

  test('the privacy audit passes over everything this run published', async () => {
    const out = execFileSync('npx', ['tsx', 'scripts/atproto-privacy-audit.ts'], { encoding: 'utf8' })
    expect(out).toContain('PASS')
    expect(out).toMatch(/gathering records \(live PDS\):\s+[1-9]/)
  })
})
