/**
 * Gathering-side publishing: every record the GATHERING writes about itself and its programme,
 * built from app rows and written through the gathering actor port — never with a raw agent.
 *
 *  - `publishGathering`   policy, the gathering's calendar event + config, `gathering@self`
 *                         (with `peers` and `tags`)
 *  - `publishPolicy`      `freeschool.draft.policy` alone; `setPolicyThresholds` edits + republishes
 *  - `publishVenues` / `publishTracks` / `publishSlotGrids`
 *  - `publishSchedule`    per scheduled session: calendar event, config, slot (+ a gathering-written
 *                         stub proposal only when the proposer has no DID-backed record), then
 *                         listing routing
 *  - `moveSession` / `cancelSession`   the DESTRUCTIVE writes; reached only through `approvals.ts`
 *
 * Idempotent: every rkey is deterministic, so a re-run rewrites the same records. Every write is
 * CAS'd (`swapRecord`) on the cid we last saw — the one stored on the app row, else the one in
 * `at_records` (read-your-writes), else `null` ("must not exist yet"). On `InvalidSwap` the live
 * record is re-read from the PDS and the write retried once against its actual cid.
 *
 * A session already on the published schedule whose time or venue changed is NOT rewritten by
 * `publishSchedule`: that is a move, and a move needs organiser approvals (spec §6).
 *
 * Server-only. The writer is injectable (`PublishDeps`) so failure-path tests can run the pipeline
 * against a fake PDS (tests resolve `server-only` to Next's empty stub).
 */
import 'server-only'
import { sql, type Sql } from '@/lib/db'
import { parseTimeInTimezone } from '@/lib/events/timezone'
import { readPolicyThresholds, validatePolicyThresholds, type GatheringPolicyThresholds } from '@/lib/events/policy'
import type { Approval, CreateAsGatheringInput, DeleteAsGatheringInput, GatheringAction, PutAsGatheringInput } from './actor'
import { APPLY_WRITES_MAX_OPS, GatheringNotLinkedError } from './actor'
import { actorDidForEvent, applyCreatesAsGathering, deleteRecordAsGathering, putRecordAsGathering } from './actors'
import { chunk, isRateLimitBudgetExceeded } from './rate-limit'
import { getIndexedCid } from './index-store'
import { getRecord } from './write'
// A function-only import cycle (listings uses publish's writer, publish routes listings after a slot).
import { routeSessionListing } from './listings'
import { EVENT_STATUS, NSID } from './nsids'
import {
  addressLocation,
  buildEventConfig,
  buildGatheringCalendarEvent,
  buildGatheringRecord,
  buildPolicyRecord,
  buildProposalRecord,
  buildSessionCalendarEvent,
  buildSlotGridRecord,
  buildSlotRecord,
  buildTrackRecord,
  buildVenueRecord,
  looksLikeUrl,
  normalizeTags,
  venueLocation,
  type ProposalSessionInput,
} from './records'
import { deterministicRkey, SELF_RKEY } from './rkey'
import type { CalendarEventRecord, GatheringPhase, SlotRecord, StrongRef } from './types'
import type { FetchedRecord } from './write'

export { GatheringNotLinkedError }

/* ────────────────────────────── contracts ────────────────────────────── */

export interface PublishInput {
  eventId: string
  /** `accounts.id` of the organiser acting; `null` only for trusted server jobs. */
  callerUserId: string | null
}

export interface PublishResult {
  kind:
    | 'policy'
    | 'gathering-event'
    | 'gathering-config'
    | 'gathering'
    | 'venue'
    | 'track'
    | 'slot-grid'
    | 'session-event'
    | 'session-config'
    | 'proposal-stub'
    | 'slot'
    | 'slot-superseded'
    | 'listing'
    | 'tally'
    | 'series'
    | 'occurrence'
  /** App-side id the record was built from (event, venue, track, session, grid key). */
  id: string
  uri?: string
  cid?: string
  error?: string
  /** A deliberate skip that is not a failure (e.g. a moved session awaiting approval). */
  skipped?: string
  /** Set when the write failed only because the repo is rate-limited: retry after this many ms. */
  retryAfterMs?: number
}

export interface PublishOutput {
  results: PublishResult[]
}

export type WriteResult = { uri: string; cid: string; auditId: string }

/** The writer, injectable so failure-path tests run the pipeline against a fake PDS. */
export interface PublishDeps {
  put: (input: PutAsGatheringInput) => Promise<WriteResult>
  del: (input: DeleteAsGatheringInput) => Promise<{ auditId: string }>
  getRecord: <T = Record<string, unknown>>(repo: string, collection: string, rkey: string) => Promise<FetchedRecord<T> | null>
  /** `events.actor_did`; throws `GatheringNotLinkedError`. */
  actorDidFor: (eventId: string) => Promise<string>
  /** The cid we last saw for a uri (read-your-writes index). */
  indexedCid: (uri: string) => Promise<string | null>
  /** Write uris/cids back to app tables. Tests pass `false`. */
  persist: boolean
  /**
   * Optional: create independent records in one commit (`com.atproto.repo.applyWrites`, creates
   * only). Absent → every write is a single CAS'd `putRecord`.
   */
  applyCreates?: (eventId: string, inputs: CreateAsGatheringInput[], opts: { maxOps: number }) => Promise<WriteResult[]>
  /** Operations per `applyWrites` call (default `APPLY_WRITES_MAX_OPS`, never above it). */
  applyWritesMaxOps?: number
}

/** The production writer: the gathering actor registry, unauthenticated reads, the index. */
export async function defaultDeps(): Promise<PublishDeps> {
  return {
    put: putRecordAsGathering,
    del: deleteRecordAsGathering,
    applyCreates: (eventId, inputs, opts) => applyCreatesAsGathering(eventId, inputs, opts),
    getRecord,
    actorDidFor: actorDidForEvent,
    indexedCid: (uri) => getIndexedCid(uri),
    persist: true,
  }
}

/* ─────────────────────────────── rows ─────────────────────────────── */

export interface EventRow {
  id: string
  slug: string
  name: string
  tagline: string | null
  description: string | null
  start_date: string
  end_date: string
  timezone: string
  location_name: string | null
  location_address: string | null
  status: string
  visibility: string
  vote_credits_per_user: number | null
  voting_mechanism: string | null
  voting_opens_at: string | null
  voting_closes_at: string | null
  proposals_open_at: string | null
  proposals_close_at: string | null
  allowed_formats: string[] | null
  allowed_durations: number[] | null
  max_proposals_per_user: number | null
  require_proposal_approval: boolean | null
  max_attendees: number | null
  created_at: string
  updated_at: string | null
  actor_did: string | null
  gathering_uri: string | null
  gathering_cid: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
  policy_uri: string | null
  atproto_tags: string[] | null
  policy_thresholds: unknown
}

interface VenueRow {
  id: string
  name: string
  slug: string | null
  capacity: number | null
  features: string[] | null
  style: string | null
  address: string | null
  locality: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  is_private_residence: boolean
  notes: string | null
  is_primary: boolean | null
  created_at: string
  at_uri: string | null
  at_cid: string | null
}

interface TrackRow {
  id: string
  name: string
  slug: string | null
  description: string | null
  color: string | null
  is_active: boolean | null
  max_sessions: number | null
  display_order: number | null
  skill_uris: string[] | null
  created_at: string
  at_uri: string | null
  at_cid: string | null
}

interface TimeSlotRow {
  id: string
  start_time: string
  end_time: string
  label: string | null
  is_break: boolean | null
  venue_id: string | null
  day_date: string | null
  created_at: string
}

export interface SessionRow {
  id: string
  event_id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  status: string
  host_id: string | null
  venue_id: string | null
  time_slot_id: string | null
  track_id: string | null
  topic_tags: string[] | null
  skill_uris: string[] | null
  expected_attendance: number | null
  required_features: string[] | null
  is_self_hosted: boolean | null
  self_hosted_start_time: string | null
  self_hosted_end_time: string | null
  /** Exact address or meeting link: attendee-only, never written to a record (only `virtual` is derived). */
  custom_location: string | null
  public_place: string | null
  created_at: string
  proposal_uri: string | null
  proposal_cid: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
  slot_uri: string | null
  slot_cid: string | null
  cancelled_at: string | null
  proposal_withdrawn_at: string | null
  proposal_drift_cid: string | null
  /** The proposer's repo is not active (migration 0011): never newly pinned by a slot. */
  author_inactive_at?: string | null
}

/* ─────────────────────────────── context ─────────────────────────────── */

export interface PublishContext {
  deps: PublishDeps
  sql: Sql
  event: EventRow
  actorDid: string
  callerUserId: string | null
  appUrl: string
  thresholds: GatheringPolicyThresholds
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://unconference.events').replace(/\/+$/, '')
}

/** @internal Load the event, its actor DID and the writer. Shared with `tally.ts` and `approvals.ts`. */
export async function loadPublishContext(input: PublishInput, deps?: PublishDeps): Promise<PublishContext> {
  const d = deps ?? (await defaultDeps())
  const [event] = await sql<EventRow[]>`select * from events where id = ${input.eventId}`
  if (!event) throw new Error(`event ${input.eventId} not found`)
  const actorDid = await d.actorDidFor(input.eventId)
  return {
    deps: d,
    sql,
    event,
    actorDid,
    callerUserId: input.callerUserId,
    appUrl: appUrl(),
    thresholds: readPolicyThresholds(event.policy_thresholds),
  }
}

export function gatheringUriFor(actorDid: string): string {
  return `at://${actorDid}/${NSID.gathering}/${SELF_RKEY}`
}

function rkeyOf(uri: string): string {
  return uri.slice(uri.lastIndexOf('/') + 1)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function isInvalidSwap(e: unknown): boolean {
  const err = e as { error?: string; message?: string } | undefined
  return err?.error === 'InvalidSwap' || /InvalidSwap/.test(err?.message ?? '')
}

export interface CasWriteInput {
  action: GatheringAction
  collection: string
  rkey: string
  record: object
  reason: string
  approvals?: Approval[]
}

/**
 * @internal Write through the port with CAS. `storedCid` (from the app row) wins; otherwise the
 * index's cid; otherwise `null` = "must not exist". On `InvalidSwap` (someone else rewrote or
 * removed the record) the live record is re-read and the write retried ONCE against its cid.
 */
export async function putWithCas(ctx: PublishContext, input: CasWriteInput, storedCid?: string | null): Promise<WriteResult> {
  const uri = `at://${ctx.actorDid}/${input.collection}/${input.rkey}`
  const expected = storedCid ?? (await ctx.deps.indexedCid(uri))
  const base: PutAsGatheringInput = {
    eventId: ctx.event.id,
    callerUserId: ctx.callerUserId,
    action: input.action,
    collection: input.collection,
    rkey: input.rkey,
    record: input.record as Record<string, unknown>,
    reason: input.reason,
    ...(input.approvals ? { approvals: input.approvals } : {}),
  }
  try {
    return await ctx.deps.put({ ...base, swapRecord: expected ?? null })
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    const current = await ctx.deps.getRecord(ctx.actorDid, input.collection, input.rkey)
    return ctx.deps.put({
      ...base,
      reason: `${input.reason} (retried after CAS mismatch)`,
      swapRecord: current?.cid ?? null,
    })
  }
}

/** @internal Run one write, recording success or failure in `results`. */
export async function attempt(
  results: PublishResult[],
  kind: PublishResult['kind'],
  id: string,
  fn: () => Promise<WriteResult>,
): Promise<StrongRef | null> {
  try {
    const r = await fn()
    results.push({ kind, id, uri: r.uri, cid: r.cid })
    return { uri: r.uri, cid: r.cid }
  } catch (e) {
    results.push({ kind, id, error: errorMessage(e), ...(isRateLimitBudgetExceeded(e) ? { retryAfterMs: e.retryAfterMs } : {}) })
    return null
  }
}

/** One write a batched phase plans: created in a batch when the record must not exist yet, else CAS'd alone. */
interface PlannedWrite {
  kind: PublishResult['kind']
  id: string
  input: CasWriteInput
  /** The cid on the app row, when there is one (wins over the index). */
  storedCid?: string | null
}

/**
 * Write a phase of INDEPENDENT records. Those whose expected cid is `null` ("must not exist yet")
 * go out as `applyWrites` creates in chunks of at most `applyWritesMaxOps` (a create of an existing
 * key fails the chunk, which is the same CAS answer `swapRecord: null` gives); everything else keeps
 * its per-record `putRecord` + `swapRecord`. A chunk that fails for any reason but rate limiting
 * falls back to per-record CAS writes, which re-read on `InvalidSwap`. Refs come back in input order.
 */
async function writePlanned(ctx: PublishContext, planned: PlannedWrite[], results: PublishResult[]): Promise<Array<StrongRef | null>> {
  const refs: Array<StrongRef | null> = planned.map(() => null)
  const expected = await Promise.all(
    planned.map(async (p) => p.storedCid ?? (await ctx.deps.indexedCid(`at://${ctx.actorDid}/${p.input.collection}/${p.input.rkey}`))),
  )
  const creates = planned.map((p, i) => ({ p, i })).filter(({ i }) => expected[i] == null)
  const batched = new Set<number>()
  if (ctx.deps.applyCreates && creates.length > 1) {
    const maxOps = Math.max(1, Math.min(ctx.deps.applyWritesMaxOps ?? APPLY_WRITES_MAX_OPS, APPLY_WRITES_MAX_OPS))
    for (const group of chunk(creates, maxOps)) {
      try {
        const written = await ctx.deps.applyCreates(
          ctx.event.id,
          group.map(({ p }) => ({
            callerUserId: ctx.callerUserId,
            action: p.input.action,
            collection: p.input.collection,
            rkey: p.input.rkey,
            record: p.input.record as Record<string, unknown>,
            reason: `${p.input.reason} (batched create)`,
            ...(p.input.approvals ? { approvals: p.input.approvals } : {}),
          })),
          { maxOps },
        )
        group.forEach(({ p, i }, j) => {
          const w = written[j]!
          results.push({ kind: p.kind, id: p.id, uri: w.uri, cid: w.cid })
          refs[i] = { uri: w.uri, cid: w.cid }
          batched.add(i)
        })
      } catch (e) {
        if (isRateLimitBudgetExceeded(e)) {
          for (const { p, i } of group) {
            results.push({ kind: p.kind, id: p.id, error: errorMessage(e), retryAfterMs: e.retryAfterMs })
            batched.add(i)
          }
        }
        // Otherwise leave the group to the per-record path below.
      }
    }
  }
  for (const [i, p] of planned.entries()) {
    if (batched.has(i)) continue
    refs[i] = await attempt(results, p.kind, p.id, () => putWithCas(ctx, p.input, expected[i] ?? p.storedCid))
  }
  return refs
}

/* ───────────────────────────── gathering ───────────────────────────── */

export const PHASE_BY_STATUS: Record<string, GatheringPhase> = {
  draft: 'draft',
  published: 'draft',
  proposals_open: 'proposals',
  voting_open: 'voting',
  scheduling: 'scheduling',
  live: 'live',
  completed: 'completed',
  archived: 'archived',
}

/** Midnight (or the first existing minute) of a calendar day in the event's zone. */
function dayBoundary(day: string, timezone: string, edge: 'start' | 'end'): Date {
  const candidates = edge === 'start' ? ['00:00', '01:00'] : ['23:59', '22:59']
  for (const time of candidates) {
    try {
      return parseTimeInTimezone(time, day, timezone)
    } catch {
      // clock change skipped this local time; try the next candidate
    }
  }
  return new Date(`${day}T${edge === 'start' ? '00:00' : '23:59'}:00Z`)
}

export function policyRkey(eventId: string): string {
  return deterministicRkey('policy', eventId, 'v1')
}

function policyRecordFor(event: EventRow, thresholds: GatheringPolicyThresholds) {
  return buildPolicyRecord({
    title: `${event.name} — participation policy`,
    version: '1',
    effectiveAt: event.updated_at ?? event.created_at,
    createdAt: event.created_at,
    thresholds,
    config: {
      votingMechanism: event.voting_mechanism,
      creditsPerVoter: event.vote_credits_per_user,
      requireProposalApproval: event.require_proposal_approval,
      allowedFormats: event.allowed_formats,
      allowedDurations: event.allowed_durations,
      maxProposalsPerUser: event.max_proposals_per_user,
      proposalsOpenAt: event.proposals_open_at,
      proposalsCloseAt: event.proposals_close_at,
      votingOpensAt: event.voting_opens_at,
      votingClosesAt: event.voting_closes_at,
    },
  })
}

async function writePolicy(ctx: PublishContext, results: PublishResult[], reason: string): Promise<StrongRef | null> {
  const ref = await attempt(results, 'policy', ctx.event.id, () =>
    putWithCas(ctx, {
      action: 'write-policy',
      collection: NSID.policy,
      rkey: policyRkey(ctx.event.id),
      record: policyRecordFor(ctx.event, ctx.thresholds),
      reason,
    }),
  )
  if (ref && ctx.deps.persist) await ctx.sql`update events set policy_uri = ${ref.uri} where id = ${ctx.event.id}`
  return ref
}

/** Re-write the `freeschool.draft.policy` record in place (version "1"). */
export async function publishPolicy(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  await writePolicy(ctx, results, `publish policy for "${ctx.event.name}" (thresholds and participation rules)`)
  return { results }
}

export class PolicyThresholdsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'PolicyThresholdsError'
  }
}

/**
 * Organisers set `destructiveActionStewards` (1..5), `feedbackK` (2..10) and `publishRoles`.
 * Owner/admin only. Stored on `events.policy_thresholds` (package A's column) and, when the
 * gathering is linked, re-published as the policy record in the same call. A partial object is
 * merged over the current thresholds.
 */
export async function setPolicyThresholds(
  eventId: string,
  callerUserId: string,
  thresholds: Partial<GatheringPolicyThresholds>,
  deps?: PublishDeps,
): Promise<{ thresholds: GatheringPolicyThresholds; results: PublishResult[] }> {
  const [row] = await sql<{ policy_thresholds: unknown; actor_did: string | null; role: string | null }[]>`
    select e.policy_thresholds, e.actor_did,
           (select m.role from event_members m where m.event_id = e.id and m.user_id = ${callerUserId}) as role
    from events e where e.id = ${eventId}
  `
  if (!row) throw new PolicyThresholdsError('Event not found', 404)
  if (row.role !== 'owner' && row.role !== 'admin') throw new PolicyThresholdsError('Only an owner or admin can change the policy', 403)
  const validated = validatePolicyThresholds(thresholds, readPolicyThresholds(row.policy_thresholds))
  if (!validated.ok) throw new PolicyThresholdsError(validated.error, 400, validated.field)
  await sql`update events set policy_thresholds = ${sql.json(validated.value as never)}, updated_at = now() where id = ${eventId}`
  if (!row.actor_did) return { thresholds: validated.value, results: [] }
  const { results } = await publishPolicy({ eventId, callerUserId }, deps)
  return { thresholds: validated.value, results }
}

/** `schellingpoint.draft.gathering#handleDomain` is format `handle`: a bare label (local `test`) is not one. */
function handleDomainForRecord(): string | null {
  const domain = (process.env.PDS_HANDLE_DOMAIN ?? '').trim().replace(/^\.+/, '').toLowerCase()
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(domain) ? domain : null
}

/**
 * Policy → the gathering's own calendar event → its config → `schellingpoint.draft.gathering`
 * at `self` with `peers` (peer gathering DIDs — organisations, never people) and `tags`.
 */
export async function publishGathering(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const { event, actorDid } = ctx
  const results: PublishResult[] = []
  const update: Record<string, unknown> = {}
  const eventUrl = `${ctx.appUrl}/e/${event.slug}`
  const startsAt = dayBoundary(event.start_date, event.timezone, 'start')
  const endsAt = dayBoundary(event.end_date, event.timezone, 'end')
  const phase = PHASE_BY_STATUS[event.status] ?? 'draft'

  const policy = await writePolicy(ctx, results, `publish gathering "${event.name}": policy`)

  const calendar = await attempt(results, 'gathering-event', event.id, () =>
    putWithCas(
      ctx,
      {
        action: 'publish-gathering',
        collection: NSID.event,
        rkey: deterministicRkey('gathering', event.id),
        record: buildGatheringCalendarEvent({
          name: event.name,
          description: event.description ?? event.tagline,
          startsAt,
          endsAt,
          locations: event.location_address ? [addressLocation({ name: event.location_name, street: event.location_address })] : null,
          uris: [{ uri: eventUrl, name: event.name.slice(0, 100) }],
          createdAt: event.created_at,
        }),
        reason: `publish gathering "${event.name}": calendar event`,
      },
      event.calendar_event_cid,
    ),
  )
  if (!calendar) return { results }
  update.calendar_event_uri = calendar.uri
  update.calendar_event_cid = calendar.cid

  await attempt(results, 'gathering-config', event.id, () =>
    putWithCas(ctx, {
      action: 'publish-gathering',
      collection: NSID.eventConfig,
      rkey: deterministicRkey('config', event.id),
      record: buildEventConfig({
        event: calendar,
        timezone: event.timezone,
        capacity: event.max_attendees,
        gatheringDid: actorDid,
        tags: event.atproto_tags,
        createdAt: event.created_at,
      }),
      reason: `publish gathering "${event.name}": event config`,
    }),
  )

  const peers = await ctx.sql<{ peer_did: string }[]>`
    select peer_did from peers where event_id = ${event.id} and peer_did <> ${actorDid} order by created_at limit 100
  `
  const gathering = await attempt(results, 'gathering', event.id, () =>
    putWithCas(
      ctx,
      {
        action: 'publish-gathering',
        collection: NSID.gathering,
        rkey: SELF_RKEY,
        record: buildGatheringRecord({
          name: event.name,
          description: event.description ?? event.tagline,
          region: event.location_name,
          startsAt,
          endsAt,
          event: calendar,
          phase,
          policy: policy?.uri ?? event.policy_uri,
          handleDomain: handleDomainForRecord(),
          website: eventUrl,
          peers: peers.map((p) => p.peer_did),
          tags: event.atproto_tags,
          createdAt: event.created_at,
        }),
        reason: `publish gathering "${event.name}": gathering record (phase ${phase}, ${peers.length} peers)`,
      },
      event.gathering_cid,
    ),
  )
  if (gathering) {
    update.gathering_uri = gathering.uri
    update.gathering_cid = gathering.cid
  }

  if (ctx.deps.persist) {
    await ctx.sql`
      update events set
        calendar_event_uri = ${(update.calendar_event_uri as string) ?? event.calendar_event_uri},
        calendar_event_cid = ${(update.calendar_event_cid as string) ?? event.calendar_event_cid},
        gathering_uri = ${(update.gathering_uri as string) ?? event.gathering_uri},
        gathering_cid = ${(update.gathering_cid as string) ?? event.gathering_cid},
        atproto_published_at = case when ${!!gathering} then now() else atproto_published_at end
      where id = ${event.id}
    `
  }
  return { results }
}

/* ─────────────────────────── venues / tracks ─────────────────────────── */

const venueSelect = (db: Sql) => db`
  id, name, slug, capacity, features, style, address, locality, region, postal_code, country,
  is_private_residence, notes, is_primary, created_at, at_uri, at_cid
`

function locationOfVenue(venue: VenueRow) {
  return venueLocation({
    name: venue.name,
    street: venue.address,
    locality: venue.locality,
    region: venue.region,
    postalCode: venue.postal_code,
    country: venue.country,
    privateResidence: venue.is_private_residence,
  })
}

export async function publishVenues(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const venues = await ctx.sql<VenueRow[]>`select ${venueSelect(ctx.sql)} from venues where event_id = ${ctx.event.id} order by created_at, id`
  // Independent records: new ones share `applyWrites` commits; existing ones stay CAS'd one by one.
  const refs = await writePlanned(
    ctx,
    venues.map((venue) => {
      const location = locationOfVenue(venue)
      return {
        kind: 'venue' as const,
        id: venue.id,
        storedCid: venue.at_cid,
        input: {
          action: 'publish-venue' as const,
          collection: NSID.venue,
          rkey: deterministicRkey('venue', venue.id),
          record: buildVenueRecord({
            name: venue.name,
            slug: venue.slug,
            capacity: venue.capacity,
            features: venue.features,
            style: venue.style,
            primary: venue.is_primary,
            locations: location ? [location] : null,
            // Notes on a private home are exactly where a door code ends up: never published.
            notes: venue.is_private_residence ? null : venue.notes,
            createdAt: venue.created_at,
          }),
          reason: `publish venue "${venue.name}"${venue.is_private_residence ? ' (private residence: locality only)' : ''}`,
        },
      }
    }),
    results,
  )
  for (const [i, venue] of venues.entries()) {
    const ref = refs[i]
    if (ref && ctx.deps.persist) await ctx.sql`update venues set at_uri = ${ref.uri}, at_cid = ${ref.cid} where id = ${venue.id}`
  }
  return { results }
}

export async function publishTracks(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const tracks = await ctx.sql<TrackRow[]>`
    select id, name, slug, description, color, is_active, max_sessions, display_order, skill_uris, created_at, at_uri, at_cid
    from tracks where event_id = ${ctx.event.id} order by display_order nulls last, created_at, id
  `
  const refs = await writePlanned(
    ctx,
    tracks.map((track) => ({
      kind: 'track' as const,
      id: track.id,
      storedCid: track.at_cid,
      input: {
        action: 'publish-track' as const,
        collection: NSID.track,
        rkey: deterministicRkey('track', track.id),
        record: buildTrackRecord({
          name: track.name,
          slug: track.slug,
          description: track.description,
          color: track.color,
          skills: track.skill_uris,
          maxSessions: track.max_sessions,
          displayOrder: track.display_order,
          active: track.is_active,
          createdAt: track.created_at,
        }),
        reason: `publish track "${track.name}"`,
      },
    })),
    results,
  )
  for (const [i, track] of tracks.entries()) {
    const ref = refs[i]
    if (ref && ctx.deps.persist) await ctx.sql`update tracks set at_uri = ${ref.uri}, at_cid = ${ref.cid} where id = ${track.id}`
  }
  return { results }
}

/* ───────────────────────────── slot grids ───────────────────────────── */

function localDay(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
  return parts
}

/** One `schellingpoint.draft.slotGrid` per (venue, day) built from `time_slots`. */
export async function publishSlotGrids(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const [slots, venues, grids] = await Promise.all([
    ctx.sql<TimeSlotRow[]>`
      select id, start_time, end_time, label, is_break, venue_id, day_date, created_at
      from time_slots where event_id = ${ctx.event.id} order by start_time, id
    `,
    ctx.sql<{ id: string; at_uri: string | null }[]>`select id, at_uri from venues where event_id = ${ctx.event.id}`,
    ctx.sql<{ id: string; venue_id: string | null; day_date: string; uri: string | null; cid: string | null }[]>`
      select id, venue_id, day_date, uri, cid from at_slot_grids where event_id = ${ctx.event.id}
    `,
  ])
  const venueUri = new Map(venues.map((v) => [v.id, v.at_uri]))
  const existing = new Map(grids.map((g) => [`${g.venue_id ?? ''}|${g.day_date}`, g]))

  const groups = new Map<string, { venueId: string | null; day: string; slots: TimeSlotRow[] }>()
  for (const slot of slots) {
    const day = slot.day_date ?? localDay(slot.start_time, ctx.event.timezone)
    const key = `${slot.venue_id ?? ''}|${day}`
    const group = groups.get(key) ?? { venueId: slot.venue_id, day, slots: [] }
    group.slots.push(slot)
    groups.set(key, group)
  }

  const entries = [...groups.entries()]
  const refs = await writePlanned(
    ctx,
    entries.map(([key, group]) => ({
      kind: 'slot-grid' as const,
      id: key,
      storedCid: existing.get(key)?.cid,
      input: {
        action: 'publish-slot-grid' as const,
        collection: NSID.slotGrid,
        rkey: deterministicRkey('slotgrid', ctx.event.id, group.venueId ?? 'none', group.day),
        record: buildSlotGridRecord({
          gathering: gatheringUriFor(ctx.actorDid),
          venue: group.venueId ? venueUri.get(group.venueId) : null,
          day: group.day,
          timezone: ctx.event.timezone,
          slots: group.slots.map((s) => ({ startsAt: s.start_time, endsAt: s.end_time, label: s.label, kind: s.is_break ? 'break' : 'session' })),
          createdAt: group.slots.reduce((min, s) => (s.created_at < min ? s.created_at : min), group.slots[0]!.created_at),
        }),
        reason: `publish slot grid for ${group.day}`,
      },
    })),
    results,
  )
  for (const [i, [key, group]] of entries.entries()) {
    const ref = refs[i]
    const prior = existing.get(key)
    if (ref && ctx.deps.persist) {
      if (prior) await ctx.sql`update at_slot_grids set uri = ${ref.uri}, cid = ${ref.cid} where id = ${prior.id}`
      else {
        await ctx.sql`
          insert into at_slot_grids (event_id, venue_id, day_date, uri, cid)
          values (${ctx.event.id}, ${group.venueId}, ${group.day}, ${ref.uri}, ${ref.cid})
        `
      }
    }
  }
  return { results }
}

/* ────────────────────────────── schedule ────────────────────────────── */

export interface SessionBundle {
  session: SessionRow
  slot: TimeSlotRow | null
  venue: VenueRow | null
  track: TrackRow | null
}

const sessionSelect = (db: Sql) => db`
  id, event_id, title, description, format, duration, status, host_id, venue_id, time_slot_id, track_id, topic_tags,
  skill_uris, expected_attendance, required_features, is_self_hosted, self_hosted_start_time, self_hosted_end_time,
  custom_location, public_place, created_at, proposal_uri, proposal_cid, calendar_event_uri, calendar_event_cid, slot_uri, slot_cid,
  cancelled_at, proposal_withdrawn_at, proposal_drift_cid, author_inactive_at
`

export async function loadSessionBundles(
  ctx: PublishContext,
  sessionIds?: string[],
  overrideSlot?: { sessionId: string; timeSlotId: string; venueId: string | null },
): Promise<SessionBundle[]> {
  const sessions = sessionIds
    ? await ctx.sql<SessionRow[]>`
        select ${sessionSelect(ctx.sql)} from sessions where event_id = ${ctx.event.id} and id in ${ctx.sql(sessionIds)} order by created_at, id
      `
    : await ctx.sql<SessionRow[]>`
        select ${sessionSelect(ctx.sql)} from sessions
        where event_id = ${ctx.event.id} and status = 'scheduled' and time_slot_id is not null
        order by created_at, id
      `
  if (!sessions.length) return []
  const slotIds = [
    ...new Set(
      sessions
        .map((s) => (overrideSlot && s.id === overrideSlot.sessionId ? overrideSlot.timeSlotId : s.time_slot_id))
        .filter((id): id is string => !!id),
    ),
  ]
  const [slots, venues, tracks] = await Promise.all([
    slotIds.length
      ? ctx.sql<TimeSlotRow[]>`
          select id, start_time, end_time, label, is_break, venue_id, day_date, created_at
          from time_slots where event_id = ${ctx.event.id} and id in ${ctx.sql(slotIds)}
        `
      : Promise.resolve([] as TimeSlotRow[]),
    ctx.sql<VenueRow[]>`select ${venueSelect(ctx.sql)} from venues where event_id = ${ctx.event.id}`,
    ctx.sql<TrackRow[]>`
      select id, name, slug, description, color, is_active, max_sessions, display_order, skill_uris, created_at, at_uri, at_cid
      from tracks where event_id = ${ctx.event.id}
    `,
  ])
  const slotById = new Map(slots.map((s) => [s.id, s]))
  const venueById = new Map(venues.map((v) => [v.id, v]))
  const trackById = new Map(tracks.map((t) => [t.id, t]))
  return sessions.map((session) => {
    const override = overrideSlot && session.id === overrideSlot.sessionId ? overrideSlot : null
    const slot = slotById.get(override ? override.timeSlotId : (session.time_slot_id ?? '')) ?? null
    const venueId = override ? (override.venueId ?? slot?.venue_id ?? null) : (session.venue_id ?? slot?.venue_id ?? null)
    return {
      session,
      slot,
      venue: venueId ? (venueById.get(venueId) ?? null) : null,
      track: session.track_id ? (trackById.get(session.track_id) ?? null) : null,
    }
  })
}

function sessionUrl(ctx: PublishContext, sessionId: string): string {
  return `${ctx.appUrl}/e/${ctx.event.slug}/sessions/${sessionId}`
}

export function sessionEventRkey(session: Pick<SessionRow, 'id' | 'calendar_event_uri'>): string {
  return session.calendar_event_uri ? rkeyOf(session.calendar_event_uri) : deterministicRkey('session', session.id)
}

/** The slot record currently standing for this session (after a move it is the superseding one). */
export function currentSlotRkey(session: Pick<SessionRow, 'id' | 'slot_uri'>): string {
  return session.slot_uri ? rkeyOf(session.slot_uri) : deterministicRkey('slot', session.id)
}

/** The rkey a move to `startsAt` writes its new slot under (so an approval can name it in advance). */
export function movedSlotRkey(sessionId: string, startsAt: string): string {
  return deterministicRkey('slot', sessionId, new Date(startsAt).toISOString())
}

function proposalInputFor(session: SessionRow): ProposalSessionInput {
  return {
    title: session.title,
    description: session.description,
    format: session.format || 'talk',
    duration: session.duration ?? 30,
    topic_tags: session.topic_tags,
    expected_attendance: session.expected_attendance,
    required_features: session.required_features,
    is_self_hosted: session.is_self_hosted,
    self_hosted_start_time: session.self_hosted_start_time,
    self_hosted_end_time: session.self_hosted_end_time,
    public_place: session.public_place,
    created_at: session.created_at,
    imported_from: 'unconference.events',
  }
}

/**
 * @internal The strongRef a slot/tally pins: the proposer's own DID-backed proposal when there is
 * one, else a gathering-written stub (`imported: true`, no host name — spec §11 phase 3). The
 * stub's uri/cid are never stored in `sessions.proposal_*`, which is reserved for the proposer.
 */
export async function ensureProposalRef(
  ctx: PublishContext,
  bundle: { session: SessionRow; track?: { at_uri: string | null } | null },
  results: PublishResult[],
): Promise<StrongRef | null> {
  const { session, track } = bundle
  if (session.proposal_uri && session.proposal_cid && !session.proposal_withdrawn_at) {
    return { uri: session.proposal_uri, cid: session.proposal_cid }
  }
  return attempt(results, 'proposal-stub', session.id, () =>
    putWithCas(ctx, {
      action: 'publish-stub-proposal',
      collection: NSID.proposal,
      rkey: deterministicRkey('proposal-stub', session.id),
      record: buildProposalRecord({
        session: proposalInputFor(session),
        gatheringUri: gatheringUriFor(ctx.actorDid),
        trackUri: track?.at_uri,
        skills: session.skill_uris,
      }),
      reason: `stub proposal for "${session.title}" (no DID-backed proposal from its author)`,
    }),
  )
}

/** Routing tags a scheduled session's config carries: its topics and its track's slug. */
export function sessionTags(bundle: Pick<SessionBundle, 'session' | 'track'>): string[] {
  return normalizeTags([...(bundle.session.topic_tags ?? []), bundle.track?.slug ?? null])
}

type EventStatusWord = 'scheduled' | 'rescheduled' | 'cancelled'

function sessionEventRecord(ctx: PublishContext, bundle: SessionBundle, times: { startsAt: string; endsAt: string }, status: EventStatusWord): CalendarEventRecord {
  const { session, venue } = bundle
  const record = buildSessionCalendarEvent({
    name: session.title,
    description: session.description,
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    cancelled: status === 'cancelled',
    virtual: looksLikeUrl(session.custom_location),
    // A self-hosted session has no venue; its exact address stays app-side.
    venueAddress: venue && !session.is_self_hosted ? locationOfVenue(venue) : null,
    sessionUrl: sessionUrl(ctx, session.id),
    createdAt: session.created_at,
  })
  return status === 'rescheduled' ? { ...record, status: EVENT_STATUS.rescheduled } : record
}

interface SessionWriteOptions {
  eventStatus: EventStatusWord
  slotRkey: string
  slotCid?: string | null
  slotStatus: 'scheduled' | 'moved' | 'cancelled'
  supersedes?: StrongRef | null
  action: GatheringAction
  reasonPrefix: string
  approvals?: Approval[]
}

/** Calendar event → config → (stub) proposal → slot → listing, then persist on `sessions`. */
async function writeSession(ctx: PublishContext, bundle: SessionBundle, results: PublishResult[], opts: SessionWriteOptions): Promise<boolean> {
  const { session, slot, venue, track } = bundle
  if (!slot) {
    results.push({ kind: 'session-event', id: session.id, error: 'session has no time slot' })
    return false
  }
  const times = { startsAt: new Date(slot.start_time).toISOString(), endsAt: new Date(slot.end_time).toISOString() }
  const tags = sessionTags(bundle)

  const calendar = await attempt(results, 'session-event', session.id, () =>
    putWithCas(
      ctx,
      {
        action: opts.action,
        collection: NSID.event,
        rkey: sessionEventRkey(session),
        record: sessionEventRecord(ctx, bundle, times, opts.eventStatus),
        reason: `${opts.reasonPrefix}: calendar event for "${session.title}"`,
        approvals: opts.approvals,
      },
      session.calendar_event_cid,
    ),
  )
  if (!calendar) return false

  await attempt(results, 'session-config', session.id, () =>
    putWithCas(ctx, {
      action: opts.action === 'move-slot' || opts.action === 'cancel-slot' ? 'publish-event' : opts.action,
      collection: NSID.eventConfig,
      rkey: deterministicRkey('config', session.id),
      record: buildEventConfig({
        event: calendar,
        timezone: ctx.event.timezone,
        capacity: venue?.capacity,
        gatheringDid: ctx.actorDid,
        tags,
        createdAt: session.created_at,
      }),
      reason: `${opts.reasonPrefix}: event config for "${session.title}"`,
    }),
  )

  let slotRef: StrongRef | null = null
  let pinnedProposal: StrongRef | null = null
  const proposal = await ensureProposalRef(ctx, bundle, results)
  if (proposal) {
    pinnedProposal = proposal
    slotRef = await attempt(results, 'slot', session.id, () =>
      putWithCas(
        ctx,
        {
          action: opts.action,
          collection: NSID.slot,
          rkey: opts.slotRkey,
          record: buildSlotRecord({
            gathering: gatheringUriFor(ctx.actorDid),
            event: calendar,
            proposal,
            venue: venue?.at_uri,
            track: track?.at_uri,
            startsAt: times.startsAt,
            endsAt: times.endsAt,
            status: opts.slotStatus,
            supersedes: opts.supersedes,
            createdAt: session.created_at,
          }),
          reason: `${opts.reasonPrefix}: slot for "${session.title}"`,
          approvals: opts.approvals,
        },
        opts.slotCid,
      ),
    )
  }

  if (ctx.deps.persist) {
    const pinsCurrent = !!(pinnedProposal && session.proposal_cid && pinnedProposal.cid === session.proposal_cid)
    await ctx.sql`
      update sessions set
        calendar_event_uri = ${calendar.uri},
        calendar_event_cid = ${calendar.cid},
        slot_uri = ${slotRef?.uri ?? session.slot_uri},
        slot_cid = ${slotRef?.cid ?? session.slot_cid},
        atproto_published_at = case when ${!!slotRef} then now() else atproto_published_at end,
        proposal_drift_cid = case when ${!!slotRef && pinsCurrent} then null else proposal_drift_cid end,
        proposal_drift_at = case when ${!!slotRef && pinsCurrent} then null else proposal_drift_at end
      where id = ${session.id} and event_id = ${ctx.event.id}
    `
  }

  if (slotRef && opts.eventStatus !== 'cancelled') {
    await routeSessionListing(ctx, { sessionId: session.id, event: calendar, tags }, results)
  }
  return !!slotRef
}

export interface PublishScheduleInput extends PublishInput {
  /** Restrict to these sessions; otherwise every `scheduled` session with a time slot. */
  sessionIds?: string[]
}

/** True when a published slot and the app row disagree on time or venue: a MOVE, not a republish. */
function differsFromPublished(live: SlotRecord, bundle: SessionBundle): boolean {
  if (!bundle.slot) return false
  return (
    live.startsAt !== new Date(bundle.slot.start_time).toISOString() ||
    live.endsAt !== new Date(bundle.slot.end_time).toISOString() ||
    (live.venue ?? null) !== (bundle.venue?.at_uri ?? null)
  )
}

/**
 * For every scheduled session: `community.lexicon.calendar.event`, `coop.lexicon.event.config`
 * and `schellingpoint.draft.slot` pinning the proposer's proposal (or a stub), then listing
 * routing. Idempotent. Sessions already published whose slot changed are skipped with
 * `skipped: 'requires-approval'` — route them through `requestSessionMove`.
 */
export async function publishSchedule(input: PublishScheduleInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const bundles = await loadSessionBundles(ctx, input.sessionIds)
  for (const group of chunk(bundles, SCHEDULE_BATCH_SESSIONS)) {
    const ready: Array<{ bundle: SessionBundle; opts: SessionWriteOptions }> = []
    for (const bundle of group) {
      const { session } = bundle
      let status: EventStatusWord = session.cancelled_at ? 'cancelled' : 'scheduled'
      let supersedes: StrongRef | undefined
      if (session.proposal_withdrawn_at && status !== 'cancelled') {
        // We cannot resurrect someone else's record: the organisers cancel or re-fill the slot.
        results.push({ kind: 'slot', id: session.id, skipped: 'proposal-withdrawn' })
        continue
      }
      if (session.author_inactive_at && status !== 'cancelled') {
        // The proposer's repo is taken down / deactivated: do not pin (or re-pin) their record.
        results.push({ kind: 'slot', id: session.id, skipped: 'author-inactive' })
        continue
      }
      if (session.slot_uri) {
        const live = await ctx.deps.getRecord<SlotRecord>(ctx.actorDid, NSID.slot, currentSlotRkey(session))
        if (live && differsFromPublished(live.value, bundle)) {
          results.push({ kind: 'slot', id: session.id, skipped: 'requires-approval' })
          continue
        }
        supersedes = live?.value.supersedes
        if (supersedes && status === 'scheduled') status = 'rescheduled'
        if (live?.value.status === 'cancelled') status = 'cancelled'
      }
      if (session.proposal_drift_cid) await adoptDriftedProposal(ctx, bundle)
      ready.push({
        bundle,
        opts: {
          eventStatus: status,
          slotRkey: currentSlotRkey(session),
          slotCid: session.slot_cid,
          slotStatus: status === 'cancelled' ? 'cancelled' : 'scheduled',
          supersedes,
          action: 'publish-slot',
          reasonPrefix: 'publish schedule',
        },
      })
    }
    if (ctx.deps.applyCreates) await writeSessionsBatched(ctx, ready, results)
    else for (const { bundle, opts } of ready) await writeSession(ctx, bundle, results, opts)
  }
  return { results }
}

/** Sessions per batched round of `publishSchedule` (≤ 2 ops each per `applyWrites` phase). */
export const SCHEDULE_BATCH_SESSIONS = 25

/**
 * `writeSession` for many sessions, in phases so independent creates share commits:
 *   A  every calendar event (a slot strongRefs its cid, so these land first)
 *   B  stub proposals where needed (one at a time — rare), then every config and slot
 *   C  persist + listing routing per session
 * Updates keep per-record CAS; results carry the same kinds and ids as `writeSession`.
 */
async function writeSessionsBatched(ctx: PublishContext, items: Array<{ bundle: SessionBundle; opts: SessionWriteOptions }>, results: PublishResult[]): Promise<void> {
  const timed = items.filter(({ bundle }) => {
    if (bundle.slot) return true
    results.push({ kind: 'session-event', id: bundle.session.id, error: 'session has no time slot' })
    return false
  })
  const times = new Map(timed.map(({ bundle }) => [bundle.session.id, { startsAt: new Date(bundle.slot!.start_time).toISOString(), endsAt: new Date(bundle.slot!.end_time).toISOString() }]))

  // Phase A — calendar events.
  const events = await writePlanned(
    ctx,
    timed.map(({ bundle, opts }) => ({
      kind: 'session-event' as const,
      id: bundle.session.id,
      storedCid: bundle.session.calendar_event_cid,
      input: {
        action: opts.action,
        collection: NSID.event,
        rkey: sessionEventRkey(bundle.session),
        record: sessionEventRecord(ctx, bundle, times.get(bundle.session.id)!, opts.eventStatus),
        reason: `${opts.reasonPrefix}: calendar event for "${bundle.session.title}"`,
        approvals: opts.approvals,
      },
    })),
    results,
  )

  // Phase B — (stub) proposal refs, then configs and slots.
  const withEvent: Array<{ bundle: SessionBundle; opts: SessionWriteOptions; calendar: StrongRef; proposal: StrongRef | null }> = []
  for (const [i, item] of timed.entries()) {
    const calendar = events[i]
    if (!calendar) continue
    withEvent.push({ ...item, calendar, proposal: await ensureProposalRef(ctx, item.bundle, results) })
  }
  const planned: PlannedWrite[] = []
  const slotIndex = new Map<string, number>()
  for (const { bundle, opts, calendar, proposal } of withEvent) {
    const { session, venue, track } = bundle
    const t = times.get(session.id)!
    planned.push({
      kind: 'session-config',
      id: session.id,
      input: {
        action: opts.action === 'move-slot' || opts.action === 'cancel-slot' ? 'publish-event' : opts.action,
        collection: NSID.eventConfig,
        rkey: deterministicRkey('config', session.id),
        record: buildEventConfig({ event: calendar, timezone: ctx.event.timezone, capacity: venue?.capacity, gatheringDid: ctx.actorDid, tags: sessionTags(bundle), createdAt: session.created_at }),
        reason: `${opts.reasonPrefix}: event config for "${session.title}"`,
      },
    })
    if (!proposal) continue
    slotIndex.set(session.id, planned.length)
    planned.push({
      kind: 'slot',
      id: session.id,
      storedCid: opts.slotCid,
      input: {
        action: opts.action,
        collection: NSID.slot,
        rkey: opts.slotRkey,
        record: buildSlotRecord({
          gathering: gatheringUriFor(ctx.actorDid),
          event: calendar,
          proposal,
          venue: venue?.at_uri,
          track: track?.at_uri,
          startsAt: t.startsAt,
          endsAt: t.endsAt,
          status: opts.slotStatus,
          supersedes: opts.supersedes,
          createdAt: session.created_at,
        }),
        reason: `${opts.reasonPrefix}: slot for "${session.title}"`,
        approvals: opts.approvals,
      },
    })
  }
  const refs = await writePlanned(ctx, planned, results)

  // Phase C — persist and route listings.
  for (const { bundle, opts, calendar, proposal } of withEvent) {
    const { session } = bundle
    const at = slotIndex.get(session.id)
    const slotRef = at === undefined ? null : refs[at]
    if (ctx.deps.persist) {
      const pinsCurrent = !!(proposal && session.proposal_cid && proposal.cid === session.proposal_cid)
      await ctx.sql`
        update sessions set
          calendar_event_uri = ${calendar.uri},
          calendar_event_cid = ${calendar.cid},
          slot_uri = ${slotRef?.uri ?? session.slot_uri},
          slot_cid = ${slotRef?.cid ?? session.slot_cid},
          atproto_published_at = case when ${!!slotRef} then now() else atproto_published_at end,
          proposal_drift_cid = case when ${!!slotRef && pinsCurrent} then null else proposal_drift_cid end,
          proposal_drift_at = case when ${!!slotRef && pinsCurrent} then null else proposal_drift_at end
        where id = ${session.id} and event_id = ${ctx.event.id}
      `
    }
    if (slotRef && opts.eventStatus !== 'cancelled') {
      await routeSessionListing(ctx, { sessionId: session.id, event: calendar, tags: sessionTags(bundle) }, results)
    }
  }
}

/**
 * "Review and re-publish" (spec §6): re-publishing a drifted session adopts the proposer's
 * current record. The indexed record at the drifted cid replaces the public content on the app
 * row, so the calendar event and the slot's strongRef move to the same version together.
 */
async function adoptDriftedProposal(ctx: PublishContext, bundle: SessionBundle): Promise<void> {
  const { session } = bundle
  if (!session.proposal_uri || !session.proposal_drift_cid) return
  const [row] = await ctx.sql<{ cid: string | null; record: Record<string, unknown> }[]>`
    select cid, record from at_records where uri = ${session.proposal_uri}
  `
  if (!row || row.cid !== session.proposal_drift_cid) return
  const r = row.record as { title?: string; description?: string; topics?: string[]; skills?: string[]; expectedAttendance?: number; requiredFeatures?: string[] }
  if (typeof r.title !== 'string') return
  session.title = r.title
  session.description = r.description ?? null
  session.topic_tags = r.topics ?? []
  session.skill_uris = (r.skills ?? []).slice(0, 5)
  session.expected_attendance = r.expectedAttendance ?? null
  session.required_features = r.requiredFeatures ?? []
  session.proposal_cid = row.cid
  if (ctx.deps.persist) {
    await ctx.sql`
      update sessions set title = ${session.title}, description = ${session.description}, topic_tags = ${session.topic_tags},
        skill_uris = ${session.skill_uris}, expected_attendance = ${session.expected_attendance},
        required_features = ${session.required_features}, proposal_cid = ${row.cid}, updated_at = now()
      where id = ${session.id} and event_id = ${ctx.event.id}
    `
  }
}

export interface SessionInput extends PublishInput {
  sessionId: string
  /** Organiser approvals backing a destructive write (`approvals.ts` collects them). */
  approvals?: Approval[]
}

/** `publishSchedule` for one session. */
export async function republishSession(input: SessionInput, deps?: PublishDeps): Promise<PublishOutput> {
  return publishSchedule({ eventId: input.eventId, callerUserId: input.callerUserId, sessionIds: [input.sessionId] }, deps)
}

/**
 * DESTRUCTIVE. Cancel a published session: the calendar event gets the base lexicon's
 * `#cancelled` status, the current slot `status: 'cancelled'`. The proposal is never touched —
 * it belongs to the proposer (spec §6). Needs `approvals` meeting the policy threshold.
 */
export async function cancelSession(input: SessionInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const [bundle] = await loadSessionBundles(ctx, [input.sessionId])
  if (!bundle) {
    results.push({ kind: 'session-event', id: input.sessionId, error: 'session not found in this event' })
    return { results }
  }
  const { session } = bundle
  if (!session.calendar_event_uri) {
    results.push({ kind: 'session-event', id: session.id, error: 'session has not been published; nothing to cancel' })
    return { results }
  }
  const [liveEvent, liveSlot] = await Promise.all([
    ctx.deps.getRecord<CalendarEventRecord>(ctx.actorDid, NSID.event, sessionEventRkey(session)),
    ctx.deps.getRecord<SlotRecord>(ctx.actorDid, NSID.slot, currentSlotRkey(session)),
  ])
  const times =
    liveSlot ? { startsAt: liveSlot.value.startsAt, endsAt: liveSlot.value.endsAt }
    : liveEvent?.value.startsAt && liveEvent.value.endsAt ? { startsAt: liveEvent.value.startsAt, endsAt: liveEvent.value.endsAt }
    : bundle.slot ? { startsAt: bundle.slot.start_time, endsAt: bundle.slot.end_time }
    : null
  if (!times) {
    results.push({ kind: 'session-event', id: session.id, error: 'cannot determine the published times to cancel' })
    return { results }
  }
  const reason = `cancel session "${session.title}"`

  const calendar = await attempt(results, 'session-event', session.id, () =>
    putWithCas(
      ctx,
      {
        action: 'cancel-slot',
        collection: NSID.event,
        rkey: sessionEventRkey(session),
        record: liveEvent
          ? { ...liveEvent.value, status: EVENT_STATUS.cancelled }
          : sessionEventRecord(ctx, bundle, times, 'cancelled'),
        reason: `${reason}: calendar event status cancelled`,
        approvals: input.approvals,
      },
      session.calendar_event_cid ?? liveEvent?.cid,
    ),
  )
  if (!calendar) return { results }

  let slotRef: StrongRef | null = null
  const proposal = liveSlot?.value.proposal ?? (await ensureProposalRef(ctx, bundle, results))
  if (proposal) {
    slotRef = await attempt(results, 'slot', session.id, () =>
      putWithCas(
        ctx,
        {
          action: 'cancel-slot',
          collection: NSID.slot,
          rkey: currentSlotRkey(session),
          record: buildSlotRecord({
            gathering: gatheringUriFor(ctx.actorDid),
            event: calendar,
            proposal,
            venue: liveSlot?.value.venue ?? bundle.venue?.at_uri,
            track: liveSlot?.value.track ?? bundle.track?.at_uri,
            startsAt: times.startsAt,
            endsAt: times.endsAt,
            status: 'cancelled',
            supersedes: liveSlot?.value.supersedes,
            createdAt: liveSlot?.value.createdAt ?? session.created_at,
          }),
          reason: `${reason}: slot status cancelled`,
          approvals: input.approvals,
        },
        session.slot_cid ?? liveSlot?.cid,
      ),
    )
  }
  if (ctx.deps.persist) {
    await ctx.sql`
      update sessions set
        calendar_event_uri = ${calendar.uri}, calendar_event_cid = ${calendar.cid},
        slot_uri = ${slotRef?.uri ?? session.slot_uri}, slot_cid = ${slotRef?.cid ?? session.slot_cid},
        cancelled_at = case when ${!!slotRef} then coalesce(cancelled_at, now()) else cancelled_at end
      where id = ${session.id} and event_id = ${ctx.event.id}
    `
  }
  return { results }
}

export interface MoveSessionInput extends SessionInput {
  /**
   * Where the session moves to. When omitted, the session row's current `time_slot_id` /
   * `venue_id` (an organiser already moved it in the schedule draft).
   */
  target?: { timeSlotId: string; venueId?: string | null }
}

/**
 * DESTRUCTIVE. A NEW slot record keyed on the new start (`supersedes` → the previous slot), the
 * calendar event updated in place with `#rescheduled` so subscribed calendars follow, and the
 * previous slot marked `moved`. Needs `approvals` meeting the policy threshold.
 */
export async function moveSession(input: MoveSessionInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const override = input.target
    ? { sessionId: input.sessionId, timeSlotId: input.target.timeSlotId, venueId: input.target.venueId ?? null }
    : undefined
  const [bundle] = await loadSessionBundles(ctx, [input.sessionId], override)
  if (!bundle) {
    results.push({ kind: 'session-event', id: input.sessionId, error: 'session not found in this event' })
    return { results }
  }
  const { session, slot } = bundle
  if (!slot) {
    results.push({ kind: 'session-event', id: session.id, error: 'the target time slot does not exist in this event' })
    return { results }
  }
  if (!session.slot_uri || !session.slot_cid) {
    results.push({ kind: 'slot', id: session.id, error: 'session is not on the published schedule; publish it instead of moving it' })
    return { results }
  }

  const previous = await ctx.deps.getRecord<SlotRecord>(ctx.actorDid, NSID.slot, currentSlotRkey(session))
  if (previous && !differsFromPublished(previous.value, bundle)) {
    results.push({ kind: 'slot', id: session.id, skipped: 'unchanged' })
    return { results }
  }
  const newStartsAt = new Date(slot.start_time).toISOString()
  const supersedes: StrongRef = previous ? { uri: previous.uri, cid: previous.cid } : { uri: session.slot_uri, cid: session.slot_cid }
  const moved = await writeSession(ctx, bundle, results, {
    eventStatus: 'rescheduled',
    slotRkey: movedSlotRkey(session.id, newStartsAt),
    slotCid: null,
    slotStatus: 'scheduled',
    supersedes,
    action: 'move-slot',
    reasonPrefix: `move session "${session.title}" to ${newStartsAt}`,
    approvals: input.approvals,
  })

  if (moved && previous && rkeyOf(previous.uri) !== movedSlotRkey(session.id, newStartsAt)) {
    // Mark the slot people already have as superseded. The new slot's `supersedes` link is the
    // authoritative history either way.
    await attempt(results, 'slot-superseded', session.id, () =>
      putWithCas(
        ctx,
        {
          action: 'move-slot',
          collection: NSID.slot,
          rkey: rkeyOf(previous.uri),
          record: { ...previous.value, status: 'moved' },
          reason: `move session "${session.title}": previous slot marked moved`,
          approvals: input.approvals,
        },
        previous.cid,
      ),
    )
  }
  if (moved && ctx.deps.persist) {
    await ctx.sql`
      update sessions set
        time_slot_id = ${slot.id},
        venue_id = ${bundle.venue?.id ?? null},
        published_slot_id = ${slot.id}
      where id = ${session.id} and event_id = ${ctx.event.id}
    `
  }
  return { results }
}
