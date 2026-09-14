/**
 * TypeScript shapes for every record we write — ours (`schellingpoint.draft.*`)
 * and borrowed (`community.lexicon.*`, `coop.lexicon.*`, `freeschool.draft.*`).
 *
 * These mirror the lexicon JSON under `lexicons/` field for field. The lexicon
 * is the source of truth; `validate.ts` checks a record against it at write
 * time. Keep these in sync by hand — there is no codegen step yet.
 *
 * Isomorphic and dependency-free.
 */
import type { NSID } from './nsids'

/** `com.atproto.repo.strongRef` — BOTH uri and cid, always. */
export interface StrongRef {
  uri: string
  cid: string
}

export type Did = `did:${string}`
export type AtUriString = `at://${string}`

/* ───────────────────────── community.lexicon.location.* ───────────────────────── */

export interface AddressLocation {
  $type: typeof NSID.locationAddress
  /** ISO 3166 country code, preferably 2 letters. */
  country: string
  postalCode?: string
  region?: string
  locality?: string
  street?: string
  name?: string
}

export interface GeoLocation {
  $type: typeof NSID.locationGeo
  latitude: string
  longitude: string
  altitude?: string
  name?: string
}

export interface FsqLocation {
  $type: typeof NSID.locationFsq
  fsq_place_id: string
  latitude?: string
  longitude?: string
  name?: string
}

export interface HthreeLocation {
  $type: typeof NSID.locationHthree
  value: string
  name?: string
}

/** `community.lexicon.calendar.event#uri` — also a member of the `locations` union. */
export interface EventUri {
  $type?: `${typeof NSID.event}#uri`
  uri: string
  name?: string
}

export type PlaceLocation = AddressLocation | GeoLocation | FsqLocation | HthreeLocation
export type EventLocation = PlaceLocation | (EventUri & { $type: `${typeof NSID.event}#uri` })

/* ───────────────────────── community.lexicon.calendar.* ───────────────────────── */

export type EventMode =
  | `${typeof NSID.event}#inperson`
  | `${typeof NSID.event}#virtual`
  | `${typeof NSID.event}#hybrid`

export type EventStatus =
  | `${typeof NSID.event}#planned`
  | `${typeof NSID.event}#scheduled`
  | `${typeof NSID.event}#rescheduled`
  | `${typeof NSID.event}#cancelled`
  | `${typeof NSID.event}#postponed`

export interface CalendarEventRecord {
  $type: typeof NSID.event
  name: string
  description?: string
  createdAt: string
  startsAt?: string
  endsAt?: string
  mode?: EventMode
  status?: EventStatus
  locations?: EventLocation[]
  uris?: EventUri[]
  rsvpExpected?: boolean
}

export type RsvpStatus =
  | `${typeof NSID.rsvp}#going`
  | `${typeof NSID.rsvp}#interested`
  | `${typeof NSID.rsvp}#notgoing`

/**
 * `community.lexicon.calendar.rsvp` has exactly two fields. There is no
 * `createdAt` in the vendored lexicon and the sidecar rule forbids adding one.
 */
export interface RsvpRecord {
  $type: typeof NSID.rsvp
  subject: StrongRef
  status: RsvpStatus
}

/* ───────────────────────────── coop.lexicon.* ───────────────────────────── */

export interface EventConfigRecord {
  $type: typeof NSID.eventConfig
  event: StrongRef
  timezone?: string
  capacity?: number
  visibility?: 'listed' | 'unlisted' | 'private'
  neighborhood?: string
  rsvpRequired?: boolean
  /** DID of the gathering (the lexicon calls it `school`; the field name is borrowed). */
  school?: string
  tags?: string[]
  createdAt?: string
}

export interface EventListingRecord {
  $type: typeof NSID.eventListing
  event: StrongRef
  /** DID of the curating actor — always the listing's own author. */
  school: string
  status?: 'listed' | 'removed'
  tags?: string[]
  createdAt?: string
}

export interface MembershipRecord {
  $type: typeof NSID.membership
  subject: string
  /** 10 member / 20 host / 30 facilitator / 40 steward. */
  role: number
  school?: string
  addedBy?: string
  createdAt?: string
}

/* ─────────────────────────── freeschool.draft.* ─────────────────────────── */

export interface PolicyThresholds {
  memberRequires?: 'none' | 'invite-or-vouch' | 'attended-one'
  hostMinAttended?: number
  facilitatorMinHosted?: number
  firstEventApproval?: boolean
  /** k-suppression threshold for tallies and feedback (2..10). */
  feedbackK?: number
  /** Stewards required for a destructive action (1..5). */
  destructiveActionStewards?: number
  publishRoles?: boolean
}

export interface PolicyRecord {
  $type: typeof NSID.policy
  title: string
  text: string
  version: string
  effectiveAt: string
  thresholds?: PolicyThresholds
  createdAt: string
}

export interface ApprovalRecord {
  $type: typeof NSID.approval
  proposal: string
  action:
    | 'remove-listing'
    | 'restore-listing'
    | 'suspend-role'
    | 'restore-role'
    | 'require-approval'
    | 'close-request'
    | 'void-attendance'
    | 'write-policy'
    | 'other'
  subjectRecord?: string
  subjectDid?: string
  reason?: string
  createdAt: string
}

/* ────────────────────────── schellingpoint.draft.* ────────────────────────── */

export type GatheringPhase =
  | 'draft'
  | 'proposals'
  | 'voting'
  | 'scheduling'
  | 'live'
  | 'completed'
  | 'archived'

export interface GatheringRecord {
  $type: typeof NSID.gathering
  name: string
  description?: string
  region?: string
  startsAt?: string
  endsAt?: string
  event?: StrongRef
  phase?: GatheringPhase
  policy?: string
  handleDomain?: string
  website?: string
  /** DIDs of peer gatherings/schools — organisations, never people. */
  peers?: string[]
  tags?: string[]
  createdAt: string
}

export type ProposalFormat = 'talk' | 'workshop' | 'discussion' | 'panel' | 'demo' | (string & {})

export interface ProposalRecord {
  $type: typeof NSID.proposal
  gathering: string
  title: string
  description?: string
  format: ProposalFormat
  durationMinutes: number
  track?: string
  skills?: string[]
  topics?: string[]
  expectedAttendance?: number
  requiredFeatures?: string[]
  selfHosted?: boolean
  startsAt?: string
  endsAt?: string
  place?: string
  imported?: boolean
  importedFrom?: string
  createdAt: string
}

export type CohostRole = 'cohost' | 'facilitator' | 'notetaker'

export interface CohostRecord {
  $type: typeof NSID.cohost
  proposal: StrongRef
  role?: CohostRole
  displayOrder?: number
  createdAt: string
}

export interface TimeWindow {
  startsAt: string
  endsAt: string
  /** 1 prefer, 2 acceptable, 3 last resort. */
  preference?: 1 | 2 | 3
}

export interface TimePreferenceRecord {
  $type: typeof NSID.timePreference
  proposal: StrongRef
  windows?: TimeWindow[]
  blackouts?: TimeWindow[]
  createdAt: string
}

export interface TrackRecord {
  $type: typeof NSID.track
  name: string
  slug?: string
  description?: string
  color?: string
  skills?: string[]
  maxSessions?: number
  displayOrder?: number
  active?: boolean
  createdAt: string
}

export interface VenueRecord {
  $type: typeof NSID.venue
  name: string
  slug?: string
  capacity?: number
  features?: string[]
  style?: string
  primary?: boolean
  locations?: PlaceLocation[]
  notes?: string
  createdAt: string
}

export type SlotKind = 'session' | 'break'

export interface SlotGridSlot {
  startsAt: string
  endsAt: string
  label?: string
  kind: SlotKind
}

export interface SlotGridRecord {
  $type: typeof NSID.slotGrid
  gathering: string
  venue?: string
  /** YYYY-MM-DD in the gathering's timezone. */
  day: string
  timezone?: string
  slots: SlotGridSlot[]
  createdAt: string
}

export type SlotStatus = 'scheduled' | 'moved' | 'cancelled'

export interface SlotRecord {
  $type: typeof NSID.slot
  gathering: string
  event: StrongRef
  proposal: StrongRef
  venue?: string
  track?: string
  startsAt: string
  endsAt: string
  status?: SlotStatus
  supersedes?: StrongRef
  createdAt: string
}

export type TallyRound = 'pre-event' | 'attendance'
export type VotingMechanism = 'quadratic' | 'linear' | 'approval'

export type TallyEntry =
  | { proposal: StrongRef; suppressed: true }
  | { proposal: StrongRef; suppressed: false; voters: number; votes: number; credits: number }

export interface TallyRecord {
  $type: typeof NSID.tally
  gathering: string
  round: TallyRound
  mechanism: VotingMechanism
  creditsPerVoter?: number
  ballotsCast?: number
  k?: number
  entries?: TallyEntry[]
  closedAt: string
  createdAt: string
}

export interface EndorsementRecord {
  $type: typeof NSID.endorsement
  proposal: StrongRef
  note?: string
  createdAt: string
}

/** Any record this module knows how to build. */
export type AnyRecord =
  | CalendarEventRecord
  | RsvpRecord
  | EventConfigRecord
  | EventListingRecord
  | MembershipRecord
  | PolicyRecord
  | ApprovalRecord
  | GatheringRecord
  | ProposalRecord
  | CohostRecord
  | TimePreferenceRecord
  | TrackRecord
  | VenueRecord
  | SlotGridRecord
  | SlotRecord
  | TallyRecord
  | EndorsementRecord
