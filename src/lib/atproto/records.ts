/**
 * Pure record builders: plain inputs in, `{ $type, ... }` objects out. No I/O,
 * no Supabase types, so every builder is unit-testable and usable from client
 * code that wants to preview what will be written.
 *
 * Two rules every builder obeys (spec §3, §4.3):
 *
 *  R9 — NO PUBLIC RECORD NAMES A DID ITS HOLDER DID NOT WRITE. A proposal
 *       carries no host name, no co-host, no attendee. `assertNoForeignDid`
 *       enforces it mechanically; the allowed exceptions are listed on it.
 *
 *  SIDECAR — never add a field to a borrowed lexicon. `buildSessionCalendarEvent`
 *       emits only fields `community.lexicon.calendar.event` defines; vote counts,
 *       provenance, track and venue features live in `schellingpoint.draft.*`
 *       records that strongRef the event.
 *
 * Builders drop `undefined`, empty strings and empty arrays so the record that
 * reaches the PDS is exactly what a validating peer expects.
 */
import { EVENT_MODE, EVENT_STATUS, NSID, RSVP_STATUS } from './nsids'
import { deterministicRkey } from './rkey'
import type {
  AddressLocation,
  ApprovalRecord,
  EventListingRecord,
  MembershipRecord,
  OccurrenceRecord,
  SeriesFreq,
  SeriesRecord,
  TimePreferenceRecord,
  TimeWindow,
  WeekdayCode,
  CalendarEventRecord,
  CohostRecord,
  CohostRole,
  EndorsementRecord,
  EventConfigRecord,
  EventLocation,
  EventUri,
  GatheringPhase,
  GatheringRecord,
  PlaceLocation,
  PolicyRecord,
  PolicyThresholds,
  ProposalRecord,
  RsvpRecord,
  SlotGridRecord,
  SlotGridSlot,
  SlotRecord,
  SlotStatus,
  StrongRef,
  TallyEntry,
  TallyRecord,
  TallyRound,
  TrackRecord,
  VenueRecord,
  VotingMechanism,
} from './types'

/* ────────────────────────────── helpers ────────────────────────────── */

/** Empty string and whitespace both mean "not set" for an app-side text field. */
function text(value?: string | null): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function list<T>(value?: readonly T[] | null): T[] | undefined {
  if (!value) return undefined
  const cleaned = value.filter((v) => v !== undefined && v !== null && v !== ('' as unknown))
  return cleaned.length ? [...cleaned] : undefined
}

function int(value?: number | null): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : undefined
}

/** Strip `undefined` values so the wire record has no explicit-undefined keys. */
function compact<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out as T
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

const URL_RE = /^(https?:\/\/|meet\.|zoom\.us|www\.)/i
export function looksLikeUrl(value?: string | null): boolean {
  const v = value?.trim()
  return !!v && URL_RE.test(v)
}

/* ─────────────────────────── gathering repo ─────────────────────────── */

export interface GatheringInput {
  name: string
  description?: string | null
  region?: string | null
  startsAt?: string | Date | null
  endsAt?: string | Date | null
  /** The gathering's own community.lexicon.calendar.event, once written. */
  event?: StrongRef | null
  phase?: GatheringPhase | null
  /** AT-URI of the current freeschool.draft.policy. */
  policy?: string | null
  handleDomain?: string | null
  website?: string | null
  /** DIDs of peer gatherings/schools — organisations only. */
  peers?: string[] | null
  tags?: string[] | null
  createdAt: string | Date
}

export function buildGatheringRecord(input: GatheringInput): GatheringRecord {
  return compact({
    $type: NSID.gathering,
    name: input.name.trim(),
    description: text(input.description),
    region: text(input.region),
    startsAt: input.startsAt ? toIso(input.startsAt) : undefined,
    endsAt: input.endsAt ? toIso(input.endsAt) : undefined,
    event: input.event ?? undefined,
    phase: input.phase ?? undefined,
    policy: text(input.policy),
    handleDomain: text(input.handleDomain),
    website: text(input.website),
    peers: list(input.peers),
    tags: list(normalizeTags(input.tags).map((t) => t.slice(0, 40))),
    createdAt: toIso(input.createdAt),
  })
}

export interface GatheringCalendarEventInput {
  name: string
  /** PUBLIC description only. */
  description?: string | null
  startsAt: string | Date
  endsAt?: string | Date | null
  mode?: 'inperson' | 'virtual' | 'hybrid'
  locations?: EventLocation[] | null
  /** e.g. the gathering's public page. */
  uris?: EventUri[] | null
  rsvpExpected?: boolean
  createdAt: string | Date
}

/** The gathering itself as one canonical calendar event (spec §4.1). */
export function buildGatheringCalendarEvent(input: GatheringCalendarEventInput): CalendarEventRecord {
  return compact({
    $type: NSID.event,
    name: input.name.trim(),
    description: text(input.description),
    createdAt: toIso(input.createdAt),
    startsAt: toIso(input.startsAt),
    endsAt: input.endsAt ? toIso(input.endsAt) : undefined,
    mode: EVENT_MODE[input.mode ?? 'inperson'],
    status: EVENT_STATUS.scheduled,
    locations: list(input.locations),
    uris: list(input.uris),
    rsvpExpected: input.rsvpExpected,
  })
}

/**
 * Defaults from spec §3/§8 and plan §7.2: k=3, moving or cancelling a published session needs
 * TWO organisers, roles are not published. Mirrors `src/lib/events/policy.ts` (package A).
 */
export const DEFAULT_POLICY_THRESHOLDS: Required<
  Pick<PolicyThresholds, 'feedbackK' | 'destructiveActionStewards' | 'publishRoles'>
> = {
  feedbackK: 3,
  destructiveActionStewards: 2,
  publishRoles: false,
}

export interface PolicyVotingConfig {
  votingMechanism?: VotingMechanism | string | null
  creditsPerVoter?: number | null
  requireProposalApproval?: boolean | null
  allowedFormats?: string[] | null
  allowedDurations?: number[] | null
  maxProposalsPerUser?: number | null
  proposalsOpenAt?: string | Date | null
  proposalsCloseAt?: string | Date | null
  votingOpensAt?: string | Date | null
  votingClosesAt?: string | Date | null
}

export interface PolicyInput {
  title: string
  /** Full policy text. When absent, generated from `config`. */
  text?: string | null
  version: string
  effectiveAt: string | Date
  createdAt: string | Date
  config?: PolicyVotingConfig | null
  thresholds?: PolicyThresholds | null
}

/** Human-readable policy text derived from an event's voting/proposal config. */
export function policyTextFromConfig(cfg: PolicyVotingConfig, thresholds: PolicyThresholds): string {
  const lines: string[] = []
  const mech = cfg.votingMechanism ?? 'quadratic'
  const credits = int(cfg.creditsPerVoter)
  lines.push(
    `Session selection uses ${mech} voting${credits ? ` with ${credits} credits per voter` : ''}. ` +
      `Votes are private; only k-suppressed counts (k=${thresholds.feedbackK ?? DEFAULT_POLICY_THRESHOLDS.feedbackK}) are ever published.`,
  )
  lines.push(
    cfg.requireProposalApproval
      ? 'Proposals are reviewed by organisers before they appear on the public list.'
      : 'Proposals are public on write; organisers decline by not scheduling.',
  )
  if (cfg.allowedFormats?.length) lines.push(`Accepted formats: ${cfg.allowedFormats.join(', ')}.`)
  if (cfg.allowedDurations?.length) lines.push(`Accepted durations (minutes): ${cfg.allowedDurations.join(', ')}.`)
  if (int(cfg.maxProposalsPerUser)) lines.push(`Each person may offer up to ${int(cfg.maxProposalsPerUser)} sessions.`)
  if (cfg.proposalsOpenAt || cfg.proposalsCloseAt) {
    lines.push(
      `Proposals ${cfg.proposalsOpenAt ? `open ${toIso(cfg.proposalsOpenAt)}` : ''}${cfg.proposalsOpenAt && cfg.proposalsCloseAt ? ' and ' : ''}${cfg.proposalsCloseAt ? `close ${toIso(cfg.proposalsCloseAt)}` : ''}.`,
    )
  }
  if (cfg.votingOpensAt || cfg.votingClosesAt) {
    lines.push(
      `Voting ${cfg.votingOpensAt ? `opens ${toIso(cfg.votingOpensAt)}` : ''}${cfg.votingOpensAt && cfg.votingClosesAt ? ' and ' : ''}${cfg.votingClosesAt ? `closes ${toIso(cfg.votingClosesAt)}` : ''}.`,
    )
  }
  lines.push(
    `Moving or cancelling a published session requires ${thresholds.destructiveActionStewards ?? DEFAULT_POLICY_THRESHOLDS.destructiveActionStewards} organiser approval(s).`,
  )
  return lines.join('\n')
}

/** `freeschool.draft.policy`, reused verbatim: the gathering's rules and thresholds. */
export function buildPolicyRecord(input: PolicyInput): PolicyRecord {
  const thresholds: PolicyThresholds = compact({
    ...DEFAULT_POLICY_THRESHOLDS,
    firstEventApproval: input.config?.requireProposalApproval ?? undefined,
    ...(input.thresholds ? compact(input.thresholds) : {}),
  })
  return compact({
    $type: NSID.policy,
    title: input.title.trim(),
    text: text(input.text) ?? policyTextFromConfig(input.config ?? {}, thresholds),
    version: input.version,
    effectiveAt: toIso(input.effectiveAt),
    thresholds,
    createdAt: toIso(input.createdAt),
  })
}

export interface VenueInput {
  name: string
  slug?: string | null
  capacity?: number | null
  features?: string[] | null
  style?: string | null
  primary?: boolean | null
  locations?: PlaceLocation[] | null
  notes?: string | null
  createdAt: string | Date
}

export function buildVenueRecord(input: VenueInput): VenueRecord {
  const capacity = int(input.capacity)
  return compact({
    $type: NSID.venue,
    name: input.name.trim(),
    slug: text(input.slug),
    capacity: capacity && capacity > 0 ? capacity : undefined,
    features: list(input.features?.map((f) => f.trim()).filter(Boolean)),
    style: text(input.style),
    primary: input.primary ?? undefined,
    locations: list(input.locations),
    notes: text(input.notes),
    createdAt: toIso(input.createdAt),
  })
}

/** A `community.lexicon.location.address` from a free-text venue address. */
export function addressLocation(input: {
  name?: string | null
  street?: string | null
  locality?: string | null
  region?: string | null
  postalCode?: string | null
  /** ISO 3166; defaults to "US" because that is where every current gathering is. */
  country?: string | null
}): AddressLocation {
  return compact({
    $type: NSID.locationAddress,
    country: text(input.country) ?? 'US',
    name: text(input.name),
    street: text(input.street),
    locality: text(input.locality),
    region: text(input.region),
    postalCode: text(input.postalCode),
  })
}

export interface VenueAddressInput {
  name?: string | null
  /** Free-text street address (`venues.address`). */
  street?: string | null
  locality?: string | null
  region?: string | null
  postalCode?: string | null
  country?: string | null
  /** `venues.is_private_residence`: the record carries the locality and nothing finer. */
  privateResidence?: boolean | null
}

/**
 * The public location of a venue (spec §4.2 venue caveat, §10 "exact venue address"): a
 * `community.lexicon.location.address` with street and postal code for a public venue; for a
 * private residence ONLY the locality (plus region/country, which are coarser still) and no
 * venue name, since a named home is an address by another route. Returns null when there is
 * nothing publishable (no street, no locality).
 */
export function venueLocation(input: VenueAddressInput): AddressLocation | null {
  if (input.privateResidence) {
    const locality = text(input.locality)
    if (!locality) return null
    return addressLocation({ locality, region: input.region, country: input.country })
  }
  if (!text(input.street) && !text(input.locality)) return null
  return addressLocation({
    name: input.name,
    street: input.street,
    locality: input.locality,
    region: input.region,
    postalCode: input.postalCode,
    country: input.country,
  })
}

export interface TrackInput {
  name: string
  slug?: string | null
  description?: string | null
  color?: string | null
  skills?: string[] | null
  maxSessions?: number | null
  displayOrder?: number | null
  active?: boolean | null
  createdAt: string | Date
}

/** No lead_name, no lead_email, no lead_did — a track lead is app-side (spec §4.2). */
export function buildTrackRecord(input: TrackInput): TrackRecord {
  return compact({
    $type: NSID.track,
    name: input.name.trim(),
    slug: text(input.slug),
    description: text(input.description),
    color: text(input.color),
    skills: list(input.skills),
    maxSessions: int(input.maxSessions),
    displayOrder: int(input.displayOrder),
    active: input.active ?? undefined,
    createdAt: toIso(input.createdAt),
  })
}

export interface SlotGridInput {
  gathering: string
  venue?: string | null
  /** YYYY-MM-DD in the gathering's timezone. */
  day: string
  timezone?: string | null
  slots: Array<{ startsAt: string | Date; endsAt: string | Date; label?: string | null; kind?: SlotGridSlot['kind'] | null }>
  createdAt: string | Date
}

export function buildSlotGridRecord(input: SlotGridInput): SlotGridRecord {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) throw new Error(`slotGrid day must be YYYY-MM-DD, got ${input.day}`)
  const slots: SlotGridSlot[] = [...input.slots]
    .map((s) =>
      compact({
        startsAt: toIso(s.startsAt),
        endsAt: toIso(s.endsAt),
        label: text(s.label),
        kind: s.kind ?? 'session',
      }),
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  return compact({
    $type: NSID.slotGrid,
    gathering: input.gathering,
    venue: text(input.venue),
    day: input.day,
    timezone: text(input.timezone),
    slots,
    createdAt: toIso(input.createdAt),
  })
}

export interface SessionCalendarEventInput {
  name: string
  /** PUBLIC description only — never attendee notes, meeting links or Telegram URLs. */
  description?: string | null
  startsAt: string | Date
  endsAt: string | Date
  cancelled?: boolean | null
  /**
   * The session happens online. The meeting link itself is attendee-only detail and is never an
   * input here (callers derive the flag from `sessions.custom_location` and pass only the boolean).
   */
  virtual?: boolean | null
  /**
   * The venue's PUBLIC location, already coarsened by `venueLocation` (a private residence
   * yields locality only). A self-hosted session's exact address never reaches this record.
   */
  venueAddress?: AddressLocation | null
  /** The public session page on Schelling Point. */
  sessionUrl: string
  createdAt: string | Date
}

/**
 * A scheduled session as one canonical `community.lexicon.calendar.event`,
 * containing ONLY fields that lexicon defines. A calendar client that has never
 * heard of `schellingpoint.draft.*` renders the schedule from these alone.
 */
export function buildSessionCalendarEvent(input: SessionCalendarEventInput): CalendarEventRecord {
  const virtual = input.virtual === true
  const locations: EventLocation[] = []
  if (!virtual && input.venueAddress) locations.push(input.venueAddress)
  return compact({
    $type: NSID.event,
    name: input.name.trim(),
    description: text(input.description),
    createdAt: toIso(input.createdAt),
    startsAt: toIso(input.startsAt),
    endsAt: toIso(input.endsAt),
    mode: virtual ? EVENT_MODE.virtual : EVENT_MODE.inperson,
    status: input.cancelled ? EVENT_STATUS.cancelled : EVENT_STATUS.scheduled,
    locations: list(locations),
    uris: [{ uri: input.sessionUrl, name: 'Session page' }],
  })
}

export interface EventConfigInput {
  event: StrongRef
  timezone?: string | null
  capacity?: number | null
  /** DID of the gathering actor. Goes in the borrowed `school` field. */
  gatheringDid: string
  tags?: string[] | null
  rsvpRequired?: boolean | null
  createdAt: string | Date
}

/** `coop.lexicon.event.config` sidecar: capacity, timezone, visibility, routing tags. */
export function buildEventConfig(input: EventConfigInput): EventConfigRecord {
  const capacity = int(input.capacity)
  return compact({
    $type: NSID.eventConfig,
    event: input.event,
    timezone: text(input.timezone),
    capacity: capacity && capacity > 0 ? capacity : undefined,
    visibility: 'listed' as const,
    rsvpRequired: input.rsvpRequired ?? undefined,
    school: input.gatheringDid,
    tags: normalizeTags(input.tags),
    createdAt: toIso(input.createdAt),
  })
}

/** Lowercase, trimmed, de-duplicated routing tags (max 20, each ≤ 64 chars). */
export function normalizeTags(tags?: readonly (string | null | undefined)[] | null): string[] {
  const out: string[] = []
  for (const t of tags ?? []) {
    const v = typeof t === 'string' ? t.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64) : ''
    if (v && !out.includes(v)) out.push(v)
    if (out.length === 20) break
  }
  return out
}

/** True when the event's config tags and the gathering's routing tags share at least one tag. */
export function routesOnTags(eventTags: readonly string[], gatheringTags: readonly string[]): boolean {
  const routing = new Set(normalizeTags(gatheringTags))
  return normalizeTags(eventTags).some((t) => routing.has(t))
}

export type ListingEditAction = 'create' | 'update' | 'remove' | 'none'

/**
 * Pure listing-routing decision (Free School `decideListingEdit`). `everListed` asks "have we
 * EVER written a listing for this event" (any status) — NOT "is it listed now" — so a removal is
 * sticky: only an explicit steward restore brings it back. `cidChanged` re-pins an active listing
 * to the event's current version.
 */
export function decideListingEdit(state: {
  everListed: boolean
  isActivelyListed: boolean
  routesNow: boolean
  cidChanged?: boolean
}): ListingEditAction {
  if (state.routesNow && !state.everListed) return 'create'
  if (!state.routesNow && state.isActivelyListed) return 'remove'
  if (state.routesNow && state.isActivelyListed && state.cidChanged) return 'update'
  return 'none'
}

export interface ListingInput {
  /** strongRef — BOTH uri and cid — to the community.lexicon.calendar.event being curated. */
  event: StrongRef
  /** The curating gathering's DID; always the listing's own author. */
  gatheringDid: string
  status?: 'listed' | 'removed'
  tags?: string[] | null
  createdAt: string | Date
}

/** `coop.lexicon.event.listing` written by the curating gathering (spec §6 step 3, interop gap 3). */
export function buildListingRecord(input: ListingInput): EventListingRecord {
  if (!input.event?.uri || !input.event?.cid) throw new Error('a listing strongRef needs both uri and cid')
  return compact({
    $type: NSID.eventListing,
    event: { uri: input.event.uri, cid: input.event.cid },
    school: input.gatheringDid,
    status: input.status ?? 'listed',
    tags: list(normalizeTags(input.tags)),
    createdAt: toIso(input.createdAt),
  })
}

/** Role ladder the membership claim publishes: 10 member / 20 host / 30 facilitator / 40 steward. */
export const ROLE = { member: 10, host: 20, facilitator: 30, steward: 40 } as const

/**
 * Deterministic rkey of a role claim: `base32(sha256(gatheringDid \0 subjectDid))[0..13]`, so two
 * derivations write one record and a retraction deletes exactly that slot.
 */
export function membershipClaimRkey(gatheringDid: string, subjectDid: string): string {
  return deterministicRkey(gatheringDid, subjectDid)
}

export interface MembershipInput {
  subjectDid: string
  role: number
  gatheringDid: string
  createdAt: string | Date
}

export function buildMembershipRecord(input: MembershipInput): MembershipRecord {
  return {
    $type: NSID.membership,
    subject: input.subjectDid,
    role: Math.trunc(input.role),
    school: input.gatheringDid,
    addedBy: input.gatheringDid,
    createdAt: toIso(input.createdAt),
  }
}

export interface ApprovalInput {
  /** AT-URI of the record the proposed action will write (the new slot, the removed listing). */
  proposal: string
  action: ApprovalRecord['action']
  /** AT-URI of the record acted upon (the current slot, the curated event). */
  subjectRecord?: string | null
  reason?: string | null
  createdAt: string | Date
}

/**
 * `freeschool.draft.approval`, written by an organiser in their OWN repo. Never carries
 * `subjectDid`: the approver names records, not people (R9).
 */
export function buildApprovalRecord(input: ApprovalInput): ApprovalRecord {
  return compact({
    $type: NSID.approval,
    proposal: input.proposal,
    action: input.action,
    subjectRecord: text(input.subjectRecord),
    reason: text(input.reason)?.slice(0, 2000),
    createdAt: toIso(input.createdAt),
  })
}

export interface TimePreferenceInput {
  proposal: StrongRef
  windows?: TimeWindow[] | null
  blackouts?: TimeWindow[] | null
  createdAt: string | Date
}

function cleanWindows(windows?: TimeWindow[] | null): TimeWindow[] | undefined {
  if (!windows?.length) return undefined
  return windows.slice(0, 40).map((w) =>
    compact({
      startsAt: toIso(w.startsAt),
      endsAt: toIso(w.endsAt),
      preference: w.preference,
    }),
  )
}

export function buildTimePreferenceRecord(input: TimePreferenceInput): TimePreferenceRecord {
  return compact({
    $type: NSID.timePreference,
    proposal: input.proposal,
    windows: cleanWindows(input.windows),
    blackouts: cleanWindows(input.blackouts),
    createdAt: toIso(input.createdAt),
  })
}

export interface SeriesInput {
  firstEvent: StrongRef
  freq: SeriesFreq
  interval?: number | null
  byDay?: WeekdayCode[] | null
  count?: number | null
  until?: string | Date | null
  exdates?: Array<string | Date> | null
  timezone: string
  materializeAhead?: number | null
  createdAt: string | Date
}

/** The RFC 5545 RRULE (without `RRULE:`) the structured fields describe. */
export function rruleFor(input: Pick<SeriesInput, 'freq' | 'interval' | 'byDay' | 'count' | 'until'>): string {
  if (input.count && input.until) throw new Error('a series may set count or until, not both (RFC 5545)')
  const parts = [`FREQ=${input.freq.toUpperCase()}`]
  if (input.interval && input.interval > 1) parts.push(`INTERVAL=${Math.trunc(input.interval)}`)
  if (input.byDay?.length) parts.push(`BYDAY=${input.byDay.join(',')}`)
  if (input.count) parts.push(`COUNT=${Math.trunc(input.count)}`)
  if (input.until) parts.push(`UNTIL=${toIso(input.until).replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`)
  return parts.join(';')
}

export function buildSeriesRecord(input: SeriesInput): SeriesRecord {
  return compact({
    $type: NSID.series,
    firstEvent: input.firstEvent,
    rrule: rruleFor(input),
    freq: input.freq,
    interval: int(input.interval) && int(input.interval)! > 1 ? int(input.interval) : undefined,
    byDay: list(input.byDay),
    until: input.until ? toIso(input.until) : undefined,
    count: int(input.count),
    exdates: list(input.exdates?.map(toIso)),
    timezone: input.timezone,
    materializeAhead: int(input.materializeAhead),
    createdAt: toIso(input.createdAt),
  })
}

export interface OccurrenceInput {
  event: StrongRef
  series: StrongRef
  originalStartsAt: string | Date
  sequence?: number | null
  createdAt: string | Date
}

export function buildOccurrenceRecord(input: OccurrenceInput): OccurrenceRecord {
  return compact({
    $type: NSID.occurrence,
    event: input.event,
    series: input.series,
    originalStartsAt: toIso(input.originalStartsAt),
    sequence: int(input.sequence),
    createdAt: toIso(input.createdAt),
  })
}

export interface SlotInput {
  gathering: string
  event: StrongRef
  proposal: StrongRef
  venue?: string | null
  track?: string | null
  startsAt: string | Date
  endsAt: string | Date
  status?: SlotStatus | null
  supersedes?: StrongRef | null
  createdAt: string | Date
}

export function buildSlotRecord(input: SlotInput): SlotRecord {
  return compact({
    $type: NSID.slot,
    gathering: input.gathering,
    event: input.event,
    proposal: input.proposal,
    venue: text(input.venue),
    track: text(input.track),
    startsAt: toIso(input.startsAt),
    endsAt: toIso(input.endsAt),
    status: input.status ?? 'scheduled',
    supersedes: input.supersedes ?? undefined,
    createdAt: toIso(input.createdAt),
  })
}

/* ──────────────────────────── proposer repo ──────────────────────────── */

/**
 * The subset of a `sessions` row a proposal is built from. Deliberately
 * excludes host_id, host_name, cohosts, votes, venue_id, time_slot_id and
 * telegram_group_url: none of those belong in the proposer's public offer.
 */
export interface ProposalSessionInput {
  title: string
  description?: string | null
  format: string
  /** Minutes. */
  duration: number
  topic_tags?: string[] | null
  expected_attendance?: number | null
  required_features?: string[] | null
  is_self_hosted?: boolean | null
  self_hosted_start_time?: string | Date | null
  self_hosted_end_time?: string | Date | null
  /**
   * `sessions.public_place`: a COARSE label the proposer chose knowingly for the public record
   * ("Near Pearl St, Boulder"). `sessions.custom_location` — the exact address or meeting link,
   * attendee-only detail (spec §10) — is deliberately not an input: it can never reach a record.
   */
  public_place?: string | null
  created_at: string | Date
  /** Set only on a migration stub written by the gathering actor (§11 phase 3). */
  imported_from?: string | null
}

export interface ProposalInput {
  session: ProposalSessionInput
  /** AT-URI of the schellingpoint.draft.gathering. */
  gatheringUri: string
  /** AT-URI of a suggested schellingpoint.draft.track. */
  trackUri?: string | null
  /** freeschool.draft.skill URIs, max 5. */
  skills?: string[] | null
}

export function buildProposalRecord(input: ProposalInput): ProposalRecord {
  const s = input.session
  const selfHosted = !!s.is_self_hosted
  const imported = text(s.imported_from)
  return compact({
    $type: NSID.proposal,
    gathering: input.gatheringUri,
    title: s.title.trim(),
    description: text(s.description),
    format: s.format,
    durationMinutes: Math.trunc(s.duration),
    track: text(input.trackUri),
    skills: list(input.skills)?.slice(0, 5),
    topics: list(s.topic_tags?.map((t) => t.trim()).filter(Boolean))?.slice(0, 10),
    expectedAttendance: int(s.expected_attendance) && int(s.expected_attendance)! > 0 ? int(s.expected_attendance) : undefined,
    requiredFeatures: list(s.required_features?.map((f) => f.trim()).filter(Boolean))?.slice(0, 10),
    selfHosted: selfHosted || undefined,
    startsAt: selfHosted && s.self_hosted_start_time ? toIso(s.self_hosted_start_time) : undefined,
    endsAt: selfHosted && s.self_hosted_end_time ? toIso(s.self_hosted_end_time) : undefined,
    place: selfHosted ? text(s.public_place)?.slice(0, 200) : undefined,
    imported: imported ? true : undefined,
    importedFrom: imported,
    createdAt: toIso(s.created_at),
  })
}

export interface CohostInput {
  proposal: StrongRef
  role?: CohostRole | null
  displayOrder?: number | null
  createdAt: string | Date
}

/** Written by the CO-HOST in their own repo: names only its author. */
export function buildCohostRecord(input: CohostInput): CohostRecord {
  return compact({
    $type: NSID.cohost,
    proposal: input.proposal,
    role: input.role ?? 'cohost',
    displayOrder: int(input.displayOrder),
    createdAt: toIso(input.createdAt),
  })
}

export interface EndorsementInput {
  proposal: StrongRef
  note?: string | null
  createdAt: string | Date
}

export function buildEndorsementRecord(input: EndorsementInput): EndorsementRecord {
  return compact({
    $type: NSID.endorsement,
    proposal: input.proposal,
    note: text(input.note),
    createdAt: toIso(input.createdAt),
  })
}

export interface RsvpInput {
  /** strongRef to the session's community.lexicon.calendar.event. */
  subject: StrongRef
  status: 'going' | 'interested' | 'notgoing'
}

/**
 * Opt-in `community.lexicon.calendar.rsvp`, written by the ATTENDEE in their
 * own repo. The vendored lexicon defines only `subject` and `status`; no
 * `createdAt` is emitted because the sidecar rule forbids adding one.
 */
export function buildRsvpRecord(input: RsvpInput): RsvpRecord {
  return {
    $type: NSID.rsvp,
    subject: input.subject,
    status: RSVP_STATUS[input.status],
  }
}

/* ─────────────────────────────── tally ─────────────────────────────── */

export interface TallyEntryInput {
  proposal: StrongRef
  /** Distinct ballots that named this proposal. */
  voters: number
  votes: number
  credits: number
}

export interface TallyInput {
  gathering: string
  round: TallyRound
  mechanism: VotingMechanism
  creditsPerVoter?: number | null
  ballotsCast?: number | null
  /** Suppression threshold; entries with fewer than k voters publish no counts. */
  k: number
  entries: TallyEntryInput[]
  closedAt: string | Date
  createdAt: string | Date
}

/**
 * The only public artifact of a vote round (spec §5.3 step 5–6). Counts and
 * presence only — never an average, never a rank. An entry below k is
 * `{ proposal, suppressed: true }` with NO counts, not zeros.
 */
export function buildTallyRecord(input: TallyInput): TallyRecord {
  if (!Number.isInteger(input.k) || input.k < 1) throw new Error(`tally k must be a positive integer, got ${input.k}`)
  const entries: TallyEntry[] = input.entries.map((e) =>
    e.voters < input.k
      ? { proposal: e.proposal, suppressed: true }
      : {
          proposal: e.proposal,
          suppressed: false,
          voters: Math.trunc(e.voters),
          votes: Math.trunc(e.votes),
          credits: Math.trunc(e.credits),
        },
  )
  return compact({
    $type: NSID.tally,
    gathering: input.gathering,
    round: input.round,
    mechanism: input.mechanism,
    creditsPerVoter: int(input.creditsPerVoter),
    ballotsCast: int(input.ballotsCast),
    k: input.k,
    entries,
    closedAt: toIso(input.closedAt),
    createdAt: toIso(input.createdAt),
  })
}

/* ──────────────────────────── R9 invariant ──────────────────────────── */

/**
 * Fields allowed to carry a DID other than the author's, and whose.
 *
 *  - `school`    (coop.lexicon.event.config / .listing / .membership): the
 *                gathering actor's DID — a borrowed field name, our meaning.
 *  - `addedBy`   (coop.lexicon.membership): always the gathering DID itself.
 *  - `gathering` (schellingpoint.draft.proposal / slot / slotGrid / tally):
 *                normally an at-uri (which is not a bare DID and passes
 *                anyway); a bare gathering DID is tolerated here too.
 *  - `peers`     (schellingpoint.draft.gathering): DIDs of peer gatherings or
 *                schools — organisations, never people.
 *
 * At-URIs (`at://did:.../collection/rkey`) are record REFERENCES, not claims
 * about a person, and are allowed everywhere: a cohost, endorsement or slot
 * necessarily points at a proposal in the proposer's repo.
 */
export const FOREIGN_DID_ALLOWED_FIELDS: Readonly<Record<string, 'gathering' | 'any'>> = {
  school: 'gathering',
  addedBy: 'gathering',
  gathering: 'gathering',
  peers: 'any',
}

const BARE_DID_RE = /^did:[a-z]+:[A-Za-z0-9._:%-]*[A-Za-z0-9._-]$/
const EMBEDDED_DID_RE = /\bdid:(?:plc|web):[A-Za-z0-9._:%-]*[A-Za-z0-9._-]/g

export class ForeignDidError extends Error {
  constructor(
    readonly path: string,
    readonly did: string,
    readonly authorDid: string,
  ) {
    super(`R9: record names DID ${did} at ${path}, but its author is ${authorDid}`)
    this.name = 'ForeignDidError'
  }
}

export interface AssertNoForeignDidOptions {
  /** When given, `school`/`addedBy`/`gathering` may only carry THIS DID. */
  gatheringDid?: string
  /**
   * The one exemption R9 admits (interop audit gap 11): a `coop.lexicon.membership` claim's
   * top-level `subject`, for a subject who opted in, a policy that allows it and a role ≥ Host.
   * Only `role-claims.ts` passes this, after checking all three gates.
   */
  consentedSubjectDid?: string
}

/**
 * Throws `ForeignDidError` if any string in `record` names a DID other than
 * `authorDid`, outside the fields listed in `FOREIGN_DID_ALLOWED_FIELDS`.
 * Also catches DIDs smuggled inside free text ("cohost: did:plc:…").
 */
export function assertNoForeignDid(record: unknown, authorDid: string, opts: AssertNoForeignDidOptions = {}): void {
  const visit = (node: unknown, path: string, field: string | undefined): void => {
    if (typeof node === 'string') {
      if (node.startsWith('at://')) return
      const allowance = field ? FOREIGN_DID_ALLOWED_FIELDS[field] : undefined
      if (BARE_DID_RE.test(node)) {
        if (node === authorDid) return
        if (path === 'subject' && opts.consentedSubjectDid && node === opts.consentedSubjectDid) return
        if (allowance === 'any') return
        if (allowance === 'gathering' && (!opts.gatheringDid || node === opts.gatheringDid)) return
        throw new ForeignDidError(path, node, authorDid)
      }
      for (const m of node.matchAll(EMBEDDED_DID_RE)) {
        if (m[0] !== authorDid) throw new ForeignDidError(path, m[0], authorDid)
      }
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, field))
      return
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) visit(v, path ? `${path}.${k}` : k, k)
    }
  }
  visit(record, '', undefined)
}
