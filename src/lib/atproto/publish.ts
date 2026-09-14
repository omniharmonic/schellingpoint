/**
 * Gathering-side publishing: every record the GATHERING writes about itself
 * and its programme, built from app rows and written through the actor port
 * (`putRecordAsGathering`) — never with a raw agent.
 *
 *  - `publishGathering`  policy, the gathering's calendar event + config, and
 *                        `schellingpoint.draft.gathering` at `self`
 *  - `publishVenues` / `publishTracks` / `publishSlotGrids`
 *  - `publishSchedule`   per scheduled session: calendar event, config, slot
 *                        (+ a gathering-written stub proposal when the proposer
 *                        has not published their own — spec §11 phase 3)
 *  - `cancelSession` / `moveSession` / `republishSession`  (spec §6)
 *
 * Every rkey is deterministic (`docs/ATPROTO_IMPLEMENTATION.md` §2), so a
 * re-run rewrites the same records. When we hold the cid of a record we wrote
 * before, the write is CAS'd on it (`swapRecord`); on `InvalidSwap` (cid drift:
 * someone else rewrote or removed it) the current record is re-read from the
 * PDS and the write retried once against what is actually there.
 *
 * Not `server-only`: the Playwright tests import it and inject fake deps. The
 * real deps (`actor.ts`, `write.ts`) are loaded lazily so importing this module
 * never pulls in a `server-only` module.
 */
import { createAdminClient } from '@/lib/supabase/server'
import { parseTimeInTimezone } from '@/lib/events/timezone'
import type { DeleteAsGatheringInput, GatheringAction, PutAsGatheringInput } from './actor'
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
  type ProposalSessionInput,
} from './records'
import { deterministicRkey, SELF_RKEY } from './rkey'
import type { GatheringPhase, SlotRecord, StrongRef } from './types'
import type { FetchedRecord } from './write'

/* ────────────────────────────── contracts ────────────────────────────── */

export interface PublishInput {
  eventId: string
  /** Supabase user id of the organizer acting; `null` only for trusted server jobs. */
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
    | 'tally'
  /** App-side id the record was built from (event, venue, track, session, grid key). */
  id: string
  uri?: string
  cid?: string
  error?: string
}

export interface PublishOutput {
  results: PublishResult[]
}

export type WriteResult = { uri: string; cid: string; auditId: string }

/**
 * The writer, injectable so tests run the whole pipeline against a fake PDS.
 * Defaults: the gathering actor port + unauthenticated `getRecord`.
 */
export interface PublishDeps {
  put: (input: PutAsGatheringInput) => Promise<WriteResult>
  del: (input: DeleteAsGatheringInput) => Promise<{ auditId: string }>
  getRecord: <T = Record<string, unknown>>(repo: string, collection: string, rkey: string) => Promise<FetchedRecord<T> | null>
  /** `events.actor_did` for the event; throws when the gathering is not linked. */
  actorDidFor: (eventId: string) => Promise<string>
  /** Write uris/cids back to app tables. Tests pass `false`. */
  persist: boolean
}

export class GatheringNotLinkedError extends Error {
  constructor(readonly eventId: string) {
    super(`event ${eventId} has no gathering actor (events.actor_did is null)`)
    this.name = 'GatheringNotLinkedError'
  }
}

let cachedDeps: PublishDeps | undefined

/** The production writer. Loaded lazily because `actor.ts` and `write.ts` are `server-only`. */
export async function defaultDeps(): Promise<PublishDeps> {
  if (!cachedDeps) {
    const [actor, write] = await Promise.all([import('./actor'), import('./write')])
    cachedDeps = {
      put: actor.putRecordAsGathering,
      del: actor.deleteRecordAsGathering,
      getRecord: write.getRecord,
      actorDidFor: async (eventId) => {
        const db = await createAdminClient()
        const { data, error } = await db.from('events').select('actor_did').eq('id', eventId).maybeSingle()
        if (error) throw new Error(`events get: ${error.message}`)
        const did = (data?.actor_did as string | null) ?? null
        if (!did) throw new GatheringNotLinkedError(eventId)
        return did
      },
      persist: true,
    }
  }
  return cachedDeps
}

/* ─────────────────────────────── rows ─────────────────────────────── */

interface EventRow {
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
  gathering_uri: string | null
  gathering_cid: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
  policy_uri: string | null
  atproto_tags: string[] | null
}

interface VenueRow {
  id: string
  name: string
  slug: string | null
  capacity: number | null
  features: string[] | null
  style: string | null
  address: string | null
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
  day_date: string
  created_at: string
}

export interface SessionRow {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  status: string
  venue_id: string | null
  time_slot_id: string | null
  track_id: string | null
  topic_tags: string[] | null
  expected_attendance: number | null
  required_features: string[] | null
  is_self_hosted: boolean | null
  self_hosted_start_time: string | null
  self_hosted_end_time: string | null
  custom_location: string | null
  created_at: string
  proposal_uri: string | null
  proposal_cid: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
  slot_uri: string | null
  slot_cid: string | null
}

const SESSION_COLUMNS =
  'id, title, description, format, duration, status, venue_id, time_slot_id, track_id, topic_tags, expected_attendance, ' +
  'required_features, is_self_hosted, self_hosted_start_time, self_hosted_end_time, custom_location, created_at, ' +
  'proposal_uri, proposal_cid, calendar_event_uri, calendar_event_cid, slot_uri, slot_cid'

const VENUE_COLUMNS = 'id, name, slug, capacity, features, style, address, notes, is_primary, created_at, at_uri, at_cid'
const TRACK_COLUMNS = 'id, name, slug, description, color, is_active, max_sessions, display_order, created_at, at_uri, at_cid'
const TIME_SLOT_COLUMNS = 'id, start_time, end_time, label, is_break, venue_id, day_date, created_at'

/* ─────────────────────────────── context ─────────────────────────────── */

type Db = Awaited<ReturnType<typeof createAdminClient>>

export interface PublishContext {
  deps: PublishDeps
  db: Db
  event: EventRow
  actorDid: string
  callerUserId: string | null
  appUrl: string
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://schellingpoint.app').replace(/\/+$/, '')
}

/** @internal Load the event, its actor DID and the writer. Shared with `tally.ts`. */
export async function loadPublishContext(input: PublishInput, deps?: PublishDeps): Promise<PublishContext> {
  const d = deps ?? (await defaultDeps())
  const db = await createAdminClient()
  const { data, error } = await db.from('events').select('*').eq('id', input.eventId).maybeSingle()
  if (error) throw new Error(`events get: ${error.message}`)
  if (!data) throw new Error(`event ${input.eventId} not found`)
  const actorDid = await d.actorDidFor(input.eventId)
  return { deps: d, db, event: data as EventRow, actorDid, callerUserId: input.callerUserId, appUrl: appUrl() }
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

/**
 * @internal Write through the port with CAS on the cid we last stored. On cid
 * drift, re-read the live record and retry once against its current cid
 * (`null` when it was removed, which asserts "must not exist").
 */
export async function putWithCas(
  ctx: PublishContext,
  input: { action: GatheringAction; collection: string; rkey: string; record: object; reason: string },
  storedCid?: string | null,
): Promise<WriteResult> {
  const base: PutAsGatheringInput = {
    eventId: ctx.event.id,
    callerUserId: ctx.callerUserId,
    ...input,
    record: input.record as Record<string, unknown>,
  }
  try {
    return await ctx.deps.put(storedCid ? { ...base, swapRecord: storedCid } : base)
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    const current = await ctx.deps.getRecord(ctx.actorDid, input.collection, input.rkey)
    return ctx.deps.put({ ...base, swapRecord: current?.cid ?? null })
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
    results.push({ kind, id, error: errorMessage(e) })
    return null
  }
}

/* ───────────────────────────── gathering ───────────────────────────── */

const PHASE_BY_STATUS: Record<string, GatheringPhase> = {
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

function policyRkey(eventId: string): string {
  return deterministicRkey('policy', eventId, 'v1')
}

function policyRecordFor(event: EventRow) {
  return buildPolicyRecord({
    title: `${event.name} — participation policy`,
    version: '1',
    effectiveAt: event.updated_at ?? event.created_at,
    createdAt: event.created_at,
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

/**
 * Re-write the `freeschool.draft.policy` record in place (version "1"). Called
 * on its own when voting/proposal rules change; part of `publishGathering`.
 */
export async function publishPolicy(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const ref = await attempt(results, 'policy', ctx.event.id, () =>
    putWithCas(ctx, {
      action: 'publish-policy',
      collection: NSID.policy,
      rkey: policyRkey(ctx.event.id),
      record: policyRecordFor(ctx.event),
      reason: `publish policy for "${ctx.event.name}" (voting/proposal rules)`,
    }),
  )
  if (ref && ctx.deps.persist) await ctx.db.from('events').update({ policy_uri: ref.uri }).eq('id', ctx.event.id)
  return { results }
}

/**
 * Policy → the gathering's own calendar event → its config → the
 * `schellingpoint.draft.gathering` record at `self`. Persists uris/cids on
 * `events` and stamps `atproto_published_at`.
 */
export async function publishGathering(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const { event, actorDid } = ctx
  const results: PublishResult[] = []
  const update: Record<string, unknown> = {}
  const eventUrl = `${ctx.appUrl}/e/${event.slug}`
  const startsAt = dayBoundary(event.start_date, event.timezone, 'start')
  const endsAt = dayBoundary(event.end_date, event.timezone, 'end')

  const policy = await attempt(results, 'policy', event.id, () =>
    putWithCas(ctx, {
      action: 'publish-policy',
      collection: NSID.policy,
      rkey: policyRkey(event.id),
      record: policyRecordFor(event),
      reason: `publish gathering "${event.name}": policy`,
    }),
  )
  if (policy) update.policy_uri = policy.uri

  const calendar = await attempt(results, 'gathering-event', event.id, () =>
    putWithCas(
      ctx,
      {
        action: 'publish-event',
        collection: NSID.event,
        rkey: deterministicRkey('gathering', event.id),
        record: buildGatheringCalendarEvent({
          name: event.name,
          description: event.description ?? event.tagline,
          startsAt,
          endsAt,
          locations: event.location_address
            ? [addressLocation({ name: event.location_name, street: event.location_address })]
            : null,
          uris: [{ uri: eventUrl, name: 'Schelling Point' }],
          createdAt: event.created_at,
        }),
        reason: `publish gathering "${event.name}": calendar event`,
      },
      event.calendar_event_cid,
    ),
  )
  if (calendar) {
    update.calendar_event_uri = calendar.uri
    update.calendar_event_cid = calendar.cid

    await attempt(results, 'gathering-config', event.id, () =>
      putWithCas(ctx, {
        action: 'publish-event',
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
            phase: PHASE_BY_STATUS[event.status] ?? 'draft',
            policy: policy?.uri ?? event.policy_uri,
            website: eventUrl,
            tags: event.atproto_tags,
            createdAt: event.created_at,
          }),
          reason: `publish gathering "${event.name}": gathering record (phase ${PHASE_BY_STATUS[event.status] ?? 'draft'})`,
        },
        event.gathering_cid,
      ),
    )
    if (gathering) {
      update.gathering_uri = gathering.uri
      update.gathering_cid = gathering.cid
      update.atproto_published_at = new Date().toISOString()
    }
  }

  if (ctx.deps.persist && Object.keys(update).length) {
    const { error } = await ctx.db.from('events').update(update).eq('id', event.id)
    if (error) results.push({ kind: 'gathering', id: event.id, error: `persist: ${error.message}` })
  }
  return { results }
}

/* ─────────────────────────── venues / tracks ─────────────────────────── */

function venueLocation(venue: Pick<VenueRow, 'name' | 'address'>) {
  return addressLocation({ name: venue.name, street: venue.address })
}

export async function publishVenues(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const { data, error } = await ctx.db.from('venues').select(VENUE_COLUMNS).eq('event_id', ctx.event.id).order('created_at')
  if (error) throw new Error(`venues list: ${error.message}`)
  for (const venue of (data ?? []) as VenueRow[]) {
    const ref = await attempt(results, 'venue', venue.id, () =>
      putWithCas(
        ctx,
        {
          action: 'publish-venue',
          collection: NSID.venue,
          rkey: deterministicRkey('venue', venue.id),
          record: buildVenueRecord({
            name: venue.name,
            slug: venue.slug,
            capacity: venue.capacity,
            features: venue.features,
            style: venue.style,
            primary: venue.is_primary,
            locations: venue.address ? [venueLocation(venue)] : null,
            notes: venue.notes,
            createdAt: venue.created_at,
          }),
          reason: `publish venue "${venue.name}"`,
        },
        venue.at_cid,
      ),
    )
    if (ref && ctx.deps.persist) await ctx.db.from('venues').update({ at_uri: ref.uri, at_cid: ref.cid }).eq('id', venue.id)
  }
  return { results }
}

export async function publishTracks(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const { data, error } = await ctx.db.from('tracks').select(TRACK_COLUMNS).eq('event_id', ctx.event.id).order('display_order')
  if (error) throw new Error(`tracks list: ${error.message}`)
  for (const track of (data ?? []) as TrackRow[]) {
    const ref = await attempt(results, 'track', track.id, () =>
      putWithCas(
        ctx,
        {
          action: 'publish-track',
          collection: NSID.track,
          rkey: deterministicRkey('track', track.id),
          record: buildTrackRecord({
            name: track.name,
            slug: track.slug,
            description: track.description,
            color: track.color,
            maxSessions: track.max_sessions,
            displayOrder: track.display_order,
            active: track.is_active,
            createdAt: track.created_at,
          }),
          reason: `publish track "${track.name}"`,
        },
        track.at_cid,
      ),
    )
    if (ref && ctx.deps.persist) await ctx.db.from('tracks').update({ at_uri: ref.uri, at_cid: ref.cid }).eq('id', track.id)
  }
  return { results }
}

/* ───────────────────────────── slot grids ───────────────────────────── */

/** One `schellingpoint.draft.slotGrid` per (venue, day) built from `time_slots`. */
export async function publishSlotGrids(input: PublishInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const [slotsRes, venuesRes, gridsRes] = await Promise.all([
    ctx.db.from('time_slots').select(TIME_SLOT_COLUMNS).eq('event_id', ctx.event.id).order('start_time'),
    ctx.db.from('venues').select('id, at_uri').eq('event_id', ctx.event.id),
    ctx.db.from('at_slot_grids').select('id, venue_id, day_date, uri, cid').eq('event_id', ctx.event.id),
  ])
  if (slotsRes.error) throw new Error(`time_slots list: ${slotsRes.error.message}`)
  const venueUri = new Map<string, string | null>()
  for (const v of (venuesRes.data ?? []) as Array<{ id: string; at_uri: string | null }>) venueUri.set(v.id, v.at_uri)
  const existing = new Map<string, { id: string; uri: string | null; cid: string | null }>()
  for (const g of (gridsRes.data ?? []) as Array<{ id: string; venue_id: string | null; day_date: string; uri: string | null; cid: string | null }>) {
    existing.set(`${g.venue_id ?? ''}|${g.day_date}`, g)
  }

  const groups = new Map<string, { venueId: string | null; day: string; slots: TimeSlotRow[] }>()
  for (const slot of (slotsRes.data ?? []) as TimeSlotRow[]) {
    const key = `${slot.venue_id ?? ''}|${slot.day_date}`
    const group = groups.get(key) ?? { venueId: slot.venue_id, day: slot.day_date, slots: [] }
    group.slots.push(slot)
    groups.set(key, group)
  }

  for (const [key, group] of groups) {
    const prior = existing.get(key)
    const ref = await attempt(results, 'slot-grid', key, () =>
      putWithCas(
        ctx,
        {
          action: 'publish-slot-grid',
          collection: NSID.slotGrid,
          rkey: deterministicRkey('slotgrid', ctx.event.id, group.venueId ?? 'none', group.day),
          record: buildSlotGridRecord({
            gathering: gatheringUriFor(ctx.actorDid),
            venue: group.venueId ? venueUri.get(group.venueId) : null,
            day: group.day,
            timezone: ctx.event.timezone,
            slots: group.slots.map((s) => ({
              startsAt: s.start_time,
              endsAt: s.end_time,
              label: s.label,
              kind: s.is_break ? 'break' : 'session',
            })),
            createdAt: group.slots.reduce((min, s) => (s.created_at < min ? s.created_at : min), group.slots[0].created_at),
          }),
          reason: `publish slot grid for ${group.day}${group.venueId ? ` (venue ${group.venueId})` : ''}`,
        },
        prior?.cid,
      ),
    )
    if (ref && ctx.deps.persist) {
      if (prior) await ctx.db.from('at_slot_grids').update({ uri: ref.uri, cid: ref.cid }).eq('id', prior.id)
      else await ctx.db.from('at_slot_grids').insert({ event_id: ctx.event.id, venue_id: group.venueId, day_date: group.day, uri: ref.uri, cid: ref.cid })
    }
  }
  return { results }
}

/* ────────────────────────────── schedule ────────────────────────────── */

interface SessionBundle {
  session: SessionRow
  slot: TimeSlotRow | null
  venue: VenueRow | null
  track: TrackRow | null
}

async function loadSessions(ctx: PublishContext, sessionIds?: string[]): Promise<SessionBundle[]> {
  let query = ctx.db.from('sessions').select(SESSION_COLUMNS).eq('event_id', ctx.event.id)
  query = sessionIds ? query.in('id', sessionIds) : query.eq('status', 'scheduled').not('time_slot_id', 'is', null)
  const [sessionsRes, venuesRes, tracksRes] = await Promise.all([
    query.order('created_at'),
    ctx.db.from('venues').select(VENUE_COLUMNS).eq('event_id', ctx.event.id),
    ctx.db.from('tracks').select(TRACK_COLUMNS).eq('event_id', ctx.event.id),
  ])
  if (sessionsRes.error) throw new Error(`sessions list: ${sessionsRes.error.message}`)
  const sessions = (sessionsRes.data ?? []) as unknown as SessionRow[]
  const slotIds = sessions.map((s) => s.time_slot_id).filter((id): id is string => !!id)
  const slotsRes = slotIds.length ? await ctx.db.from('time_slots').select(TIME_SLOT_COLUMNS).in('id', slotIds) : { data: [], error: null }
  if (slotsRes.error) throw new Error(`time_slots list: ${slotsRes.error.message}`)
  const slots = new Map(((slotsRes.data ?? []) as TimeSlotRow[]).map((s) => [s.id, s]))
  const venues = new Map(((venuesRes.data ?? []) as VenueRow[]).map((v) => [v.id, v]))
  const tracks = new Map(((tracksRes.data ?? []) as TrackRow[]).map((t) => [t.id, t]))
  return sessions.map((session) => ({
    session,
    slot: session.time_slot_id ? (slots.get(session.time_slot_id) ?? null) : null,
    venue: session.venue_id ? (venues.get(session.venue_id) ?? null) : null,
    track: session.track_id ? (tracks.get(session.track_id) ?? null) : null,
  }))
}

function sessionUrl(ctx: PublishContext, sessionId: string): string {
  return `${ctx.appUrl}/e/${ctx.event.slug}/sessions/${sessionId}`
}

function sessionEventRkey(session: SessionRow): string {
  return session.calendar_event_uri ? rkeyOf(session.calendar_event_uri) : deterministicRkey('session', session.id)
}

/** The slot record currently standing for this session (after a move it is the superseding one). */
function currentSlotRkey(session: SessionRow): string {
  return session.slot_uri ? rkeyOf(session.slot_uri) : deterministicRkey('slot', session.id)
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
    custom_location: session.custom_location,
    created_at: session.created_at,
    imported_from: 'schellingpoint',
  }
}

/**
 * @internal The strongRef a slot/tally pins: the proposer's own published
 * proposal when there is one, else a gathering-written stub (`imported: true`,
 * no host name — spec §11 phase 3). The stub is idempotent, so callers simply
 * re-put it; its uri/cid are never stored in `sessions.proposal_*`, which is
 * reserved for the proposer's record.
 */
export async function ensureProposalRef(
  ctx: PublishContext,
  bundle: { session: SessionRow; track?: { at_uri: string | null } | null },
  results: PublishResult[],
): Promise<StrongRef | null> {
  const { session, track } = bundle
  if (session.proposal_uri && session.proposal_cid) return { uri: session.proposal_uri, cid: session.proposal_cid }
  return attempt(results, 'proposal-stub', session.id, () =>
    putWithCas(ctx, {
      action: 'publish-stub-proposal',
      collection: NSID.proposal,
      rkey: deterministicRkey('proposal-stub', session.id),
      record: buildProposalRecord({
        session: proposalInputFor(session),
        gatheringUri: gatheringUriFor(ctx.actorDid),
        trackUri: track?.at_uri,
      }),
      reason: `stub proposal for "${session.title}" (proposer has not published one)`,
    }),
  )
}

function sessionEventRecord(
  ctx: PublishContext,
  bundle: SessionBundle,
  times: { startsAt: string; endsAt: string },
  status: 'scheduled' | 'rescheduled' | 'cancelled',
) {
  const { session, venue } = bundle
  const record = buildSessionCalendarEvent({
    name: session.title,
    description: session.description,
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    cancelled: status === 'cancelled',
    customLocation: session.custom_location,
    venueAddress: venue ? venueLocation(venue) : null,
    sessionUrl: sessionUrl(ctx, session.id),
    createdAt: session.created_at,
  })
  return status === 'rescheduled' ? { ...record, status: EVENT_STATUS.rescheduled } : record
}

interface SessionWriteOptions {
  eventStatus: 'scheduled' | 'rescheduled'
  slotRkey: string
  slotCid?: string | null
  slotStatus: 'scheduled' | 'moved' | 'cancelled'
  supersedes?: StrongRef | null
  action: GatheringAction
  reasonPrefix: string
}

/** Calendar event → config → (stub) proposal → slot, then persist on `sessions`. */
async function writeSession(ctx: PublishContext, bundle: SessionBundle, results: PublishResult[], opts: SessionWriteOptions): Promise<void> {
  const { session, slot, venue, track } = bundle
  if (!slot) {
    results.push({ kind: 'session-event', id: session.id, error: 'session has no time slot' })
    return
  }
  const times = { startsAt: slot.start_time, endsAt: slot.end_time }
  const update: Record<string, unknown> = {}

  const calendar = await attempt(results, 'session-event', session.id, () =>
    putWithCas(
      ctx,
      {
        action: opts.action,
        collection: NSID.event,
        rkey: sessionEventRkey(session),
        record: sessionEventRecord(ctx, bundle, times, opts.eventStatus),
        reason: `${opts.reasonPrefix}: calendar event for "${session.title}"`,
      },
      session.calendar_event_cid,
    ),
  )
  if (calendar) {
    update.calendar_event_uri = calendar.uri
    update.calendar_event_cid = calendar.cid

    await attempt(results, 'session-config', session.id, () =>
      putWithCas(ctx, {
        action: opts.action,
        collection: NSID.eventConfig,
        rkey: deterministicRkey('config', session.id),
        record: buildEventConfig({
          event: calendar,
          timezone: ctx.event.timezone,
          capacity: venue?.capacity,
          gatheringDid: ctx.actorDid,
          tags: ctx.event.atproto_tags,
          createdAt: session.created_at,
        }),
        reason: `${opts.reasonPrefix}: event config for "${session.title}"`,
      }),
    )

    const proposal = await ensureProposalRef(ctx, bundle, results)
    if (proposal) {
      const slotRef = await attempt(results, 'slot', session.id, () =>
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
          },
          opts.slotCid,
        ),
      )
      if (slotRef) {
        update.slot_uri = slotRef.uri
        update.slot_cid = slotRef.cid
        update.atproto_published_at = new Date().toISOString()
      }
    }
  }

  if (ctx.deps.persist && Object.keys(update).length) {
    const { error } = await ctx.db.from('sessions').update(update).eq('id', session.id)
    if (error) results.push({ kind: 'slot', id: session.id, error: `persist: ${error.message}` })
  }
}

export interface PublishScheduleInput extends PublishInput {
  /** Restrict to these sessions; otherwise every `scheduled` session with a time slot. */
  sessionIds?: string[]
}

/**
 * For every scheduled session: `community.lexicon.calendar.event`,
 * `coop.lexicon.event.config` and `schellingpoint.draft.slot` (pinning the
 * proposer's proposal or a stub). Idempotent; re-running rewrites in place.
 */
export async function publishSchedule(input: PublishScheduleInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  for (const bundle of await loadSessions(ctx, input.sessionIds)) {
    await writeSession(ctx, bundle, results, {
      eventStatus: 'scheduled',
      slotRkey: currentSlotRkey(bundle.session),
      slotCid: bundle.session.slot_cid,
      slotStatus: 'scheduled',
      action: 'publish-slot',
      reasonPrefix: 'publish schedule',
    })
  }
  return { results }
}

export interface SessionInput extends PublishInput {
  sessionId: string
}

/** `publishSchedule` for one session. */
export async function republishSession(input: SessionInput, deps?: PublishDeps): Promise<PublishOutput> {
  return publishSchedule({ eventId: input.eventId, callerUserId: input.callerUserId, sessionIds: [input.sessionId] }, deps)
}

async function loadOne(ctx: PublishContext, sessionId: string): Promise<SessionBundle | null> {
  const [bundle] = await loadSessions(ctx, [sessionId])
  return bundle ?? null
}

/**
 * Cancel a published session: the calendar event gets the base lexicon's
 * `status: cancelled`, the current slot `status: 'cancelled'`. The proposal is
 * never touched — it belongs to the proposer (spec §6).
 */
export async function cancelSession(input: SessionInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const bundle = await loadOne(ctx, input.sessionId)
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
    ctx.deps.getRecord<{ startsAt?: string; endsAt?: string }>(ctx.actorDid, NSID.event, sessionEventRkey(session)),
    ctx.deps.getRecord<SlotRecord>(ctx.actorDid, NSID.slot, currentSlotRkey(session)),
  ])
  const times =
    bundle.slot ? { startsAt: bundle.slot.start_time, endsAt: bundle.slot.end_time }
    : liveEvent?.value.startsAt && liveEvent.value.endsAt ? { startsAt: liveEvent.value.startsAt, endsAt: liveEvent.value.endsAt }
    : liveSlot ? { startsAt: liveSlot.value.startsAt, endsAt: liveSlot.value.endsAt }
    : null
  if (!times) {
    results.push({ kind: 'session-event', id: session.id, error: 'cannot determine the published times to cancel' })
    return { results }
  }
  const update: Record<string, unknown> = {}
  const reason = `cancel session "${session.title}"`

  const calendar = await attempt(results, 'session-event', session.id, () =>
    putWithCas(
      ctx,
      {
        action: 'cancel-slot',
        collection: NSID.event,
        rkey: sessionEventRkey(session),
        record: sessionEventRecord(ctx, bundle, times, 'cancelled'),
        reason: `${reason}: calendar event status cancelled`,
      },
      session.calendar_event_cid,
    ),
  )
  if (calendar) {
    update.calendar_event_uri = calendar.uri
    update.calendar_event_cid = calendar.cid
    const proposal = liveSlot?.value.proposal ?? (await ensureProposalRef(ctx, bundle, results))
    if (proposal) {
      const slotRef = await attempt(results, 'slot', session.id, () =>
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
          },
          session.slot_cid,
        ),
      )
      if (slotRef) {
        update.slot_uri = slotRef.uri
        update.slot_cid = slotRef.cid
      }
    }
  }
  if (ctx.deps.persist && Object.keys(update).length) {
    const { error } = await ctx.db.from('sessions').update(update).eq('id', session.id)
    if (error) results.push({ kind: 'slot', id: session.id, error: `persist: ${error.message}` })
  }
  return { results }
}

/**
 * After the organizer moved a session in the app: a NEW slot record keyed on
 * the new start (`supersedes` → the previous slot), the calendar event updated
 * in place with `status: rescheduled` so subscribed calendars follow, and the
 * previous slot marked `moved`. Falls back to a plain (re)publish when the
 * session was never published or nothing actually changed.
 */
export async function moveSession(input: SessionInput, deps?: PublishDeps): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []
  const bundle = await loadOne(ctx, input.sessionId)
  if (!bundle) {
    results.push({ kind: 'session-event', id: input.sessionId, error: 'session not found in this event' })
    return { results }
  }
  const { session, slot, venue } = bundle
  if (!slot) {
    results.push({ kind: 'session-event', id: session.id, error: 'session has no time slot; cancel it or schedule it first' })
    return { results }
  }
  if (!session.slot_uri || !session.slot_cid) {
    await writeSession(ctx, bundle, results, {
      eventStatus: 'scheduled',
      slotRkey: currentSlotRkey(session),
      slotCid: session.slot_cid,
      slotStatus: 'scheduled',
      action: 'publish-slot',
      reasonPrefix: 'publish schedule (move requested but session was not yet published)',
    })
    return { results }
  }

  const previous = await ctx.deps.getRecord<SlotRecord>(ctx.actorDid, NSID.slot, currentSlotRkey(session))
  const newStartsAt = new Date(slot.start_time).toISOString()
  const unchanged =
    previous &&
    previous.value.startsAt === newStartsAt &&
    previous.value.endsAt === new Date(slot.end_time).toISOString() &&
    (previous.value.venue ?? null) === (venue?.at_uri ?? null)
  if (unchanged) {
    await writeSession(ctx, bundle, results, {
      eventStatus: 'scheduled',
      slotRkey: currentSlotRkey(session),
      slotCid: session.slot_cid,
      slotStatus: 'scheduled',
      action: 'publish-slot',
      reasonPrefix: 're-publish (move requested but the slot is unchanged)',
    })
    return { results }
  }

  const supersedes: StrongRef = { uri: session.slot_uri, cid: session.slot_cid }
  await writeSession(ctx, bundle, results, {
    eventStatus: 'rescheduled',
    slotRkey: deterministicRkey('slot', session.id, newStartsAt),
    slotCid: null,
    slotStatus: 'scheduled',
    supersedes,
    action: 'move-slot',
    reasonPrefix: `move session "${session.title}" to ${newStartsAt}`,
  })

  // Mark the slot people already have as superseded. Best effort: the new
  // slot's `supersedes` link is the authoritative history either way.
  if (previous) {
    await attempt(results, 'slot-superseded', session.id, () =>
      putWithCas(
        ctx,
        {
          action: 'move-slot',
          collection: NSID.slot,
          rkey: rkeyOf(previous.uri),
          record: { ...previous.value, status: 'moved' },
          reason: `move session "${session.title}": previous slot marked moved`,
        },
        previous.cid,
      ),
    )
  }
  return { results }
}
