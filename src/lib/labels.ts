/**
 * One vocabulary per status (spec §2.2).
 *
 * Every page that renders an event status, a session status or a notification type
 * imports its label/badge/dot from here. Never render `event.status` or `session.status`
 * raw, and never keep a local status map.
 *
 *   import { EVENT_STATUS, eventStatusBadge, SESSION_STATUS, sessionStatusLabel, NOTIFICATION_TYPE } from '@/lib/labels'
 *   const { label, badge } = eventStatusBadge(event.status)   // <Badge variant={badge}>{label}</Badge>
 *   sessionStatusLabel(session.status)                        // "Awaiting review"
 *   NOTIFICATION_TYPE[n.type].dot                              // "bg-success" (token classes only)
 *
 * `live` is `success`, never `destructive` (red is the error colour).
 */

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'success' | 'outline' | 'muted' | 'amber'

// Mirrors events_status_check in db/migrations/0001_baseline.sql.
export type EventStatus =
  | 'draft'
  | 'published'
  | 'proposals_open'
  | 'voting_open'
  | 'scheduling'
  | 'live'
  | 'completed'
  | 'archived'

export interface StatusLabel {
  label: string
  badge: BadgeVariant
}

export const EVENT_STATUS: Record<EventStatus, StatusLabel> = {
  draft: { label: 'Draft', badge: 'secondary' },
  published: { label: 'Open', badge: 'default' },
  proposals_open: { label: 'Proposals open', badge: 'success' },
  voting_open: { label: 'Voting open', badge: 'success' },
  scheduling: { label: 'Scheduling', badge: 'amber' },
  live: { label: 'Live now', badge: 'success' },
  completed: { label: 'Completed', badge: 'muted' },
  archived: { label: 'Archived', badge: 'outline' },
}

const UNKNOWN_STATUS: StatusLabel = { label: 'Unknown', badge: 'muted' }

/** Label + Badge variant for an event status; unknown values fall back to a muted "Unknown". */
export function eventStatusBadge(status: string | null | undefined): StatusLabel {
  return (status && (EVENT_STATUS as Record<string, StatusLabel>)[status]) || UNKNOWN_STATUS
}

// Mirrors sessions_status_check in db/migrations/0001_baseline.sql.
export type SessionStatus = 'pending' | 'approved' | 'scheduled' | 'rejected'

export const SESSION_STATUS: Record<SessionStatus, StatusLabel> = {
  pending: { label: 'Awaiting review', badge: 'amber' },
  approved: { label: 'Approved', badge: 'success' },
  scheduled: { label: 'Scheduled', badge: 'default' },
  rejected: { label: 'Not selected', badge: 'muted' },
}

/** Human label for a session status ("Awaiting review", "Not selected", …). */
export function sessionStatusLabel(status: string | null | undefined): string {
  return (status && (SESSION_STATUS as Record<string, StatusLabel>)[status]?.label) || 'Unknown'
}

/** Label + Badge variant for a session status; unknown values fall back to a muted "Unknown". */
export function sessionStatusBadge(status: string | null | undefined): StatusLabel {
  return (status && (SESSION_STATUS as Record<string, StatusLabel>)[status]) || UNKNOWN_STATUS
}

// Mirrors valid_notification_type in db/migrations/0001_baseline.sql (17 types).
export type NotificationType =
  | 'session_submitted'
  | 'session_approved'
  | 'session_rejected'
  | 'session_scheduled'
  | 'session_rescheduled'
  | 'session_cancelled'
  | 'vote_milestone'
  | 'cohost_invited'
  | 'cohost_accepted'
  | 'cohost_declined'
  | 'voting_opened'
  | 'voting_closed'
  | 'schedule_published'
  | 'event_reminder'
  | 'admin_announcement'
  | 'new_proposal'
  | 'proposal_needs_review'
  | 'event_published'
  | 'proposals_open'
  | 'rsvp_promoted'

export interface NotificationTypeLabel {
  label: string
  /** Tailwind background class for the unread/type dot. Tokens only, never the raw palette. */
  dot: string
}

export const NOTIFICATION_TYPE: Record<NotificationType, NotificationTypeLabel> = {
  session_submitted: { label: 'Session submitted', dot: 'bg-primary' },
  session_approved: { label: 'Session approved', dot: 'bg-success' },
  session_rejected: { label: 'Session not selected', dot: 'bg-muted-foreground' },
  session_scheduled: { label: 'Session scheduled', dot: 'bg-primary' },
  session_rescheduled: { label: 'Session rescheduled', dot: 'bg-signal-amber' },
  session_cancelled: { label: 'Session cancelled', dot: 'bg-destructive' },
  vote_milestone: { label: 'Vote milestone', dot: 'bg-success' },
  cohost_invited: { label: 'Co-host invitation', dot: 'bg-signal-cyan' },
  cohost_accepted: { label: 'Co-host accepted', dot: 'bg-success' },
  cohost_declined: { label: 'Co-host declined', dot: 'bg-muted-foreground' },
  voting_opened: { label: 'Voting opened', dot: 'bg-primary' },
  voting_closed: { label: 'Voting closed', dot: 'bg-muted-foreground' },
  schedule_published: { label: 'Schedule published', dot: 'bg-success' },
  event_reminder: { label: 'Reminder', dot: 'bg-signal-amber' },
  admin_announcement: { label: 'Announcement', dot: 'bg-signal-cyan' },
  new_proposal: { label: 'New proposal', dot: 'bg-primary' },
  proposal_needs_review: { label: 'Proposal needs review', dot: 'bg-signal-amber' },
  event_published: { label: 'Gathering published', dot: 'bg-success' },
  proposals_open: { label: 'Proposals open', dot: 'bg-primary' },
  rsvp_promoted: { label: 'Off the waitlist', dot: 'bg-success' },
}

const UNKNOWN_NOTIFICATION: NotificationTypeLabel = { label: 'Notification', dot: 'bg-muted-foreground' }

/** Label + dot class for a notification type; unknown values fall back to a neutral entry. */
export function notificationType(type: string | null | undefined): NotificationTypeLabel {
  return (type && (NOTIFICATION_TYPE as Record<string, NotificationTypeLabel>)[type]) || UNKNOWN_NOTIFICATION
}

// ── Voting rounds (organizer controls, migration 0031) ───────────────────────

/** Mirrors `RoundPhase` in src/lib/voting/mechanism.ts. */
export type RoundPhaseName = 'pre-event' | 'attendance'

export const ROUND_PHASE: Record<RoundPhaseName, string> = {
  'pre-event': 'Pre-event voting',
  attendance: 'Attendance voting',
}

/** Mirrors `RoundStatus` in src/lib/voting/rounds.ts. */
export type RoundStatusName = 'none' | 'upcoming' | 'open' | 'closed'

export const ROUND_STATUS: Record<RoundStatusName, StatusLabel> = {
  none: { label: 'Not started', badge: 'muted' },
  upcoming: { label: 'Scheduled', badge: 'secondary' },
  open: { label: 'Open', badge: 'success' },
  closed: { label: 'Sealed', badge: 'outline' },
}

/** Mirrors `round_actions.action` (migration 0031). */
export type RoundActionName = 'open' | 'extend' | 'close'

export const ROUND_ACTION: Record<RoundActionName, StatusLabel> = {
  open: { label: 'Opened', badge: 'success' },
  extend: { label: 'Extended', badge: 'secondary' },
  close: { label: 'Closed', badge: 'outline' },
}

// ── Session mergers (PRD §4.4, migration 0031) ───────────────────────────────

/** Mirrors `session_merge_requests.status` (migration 0031). */
export type MergeRequestStatus = 'pending' | 'accepted' | 'declined' | 'withdrawn'

export const MERGE_REQUEST_STATUS: Record<MergeRequestStatus, StatusLabel> = {
  pending: { label: 'Awaiting an answer', badge: 'amber' },
  accepted: { label: 'Merged', badge: 'success' },
  declined: { label: 'Declined', badge: 'muted' },
  withdrawn: { label: 'Withdrawn', badge: 'muted' },
}

/** Badge for a proposal that was folded into another (`sessions.merged_into`). */
export const MERGED_SESSION: StatusLabel = { label: 'Merged', badge: 'muted' }

/**
 * The one sentence the merger UI says about votes. The PRD's ×1.1 collaboration bonus is not
 * applied: a bonus needs the two ballot sets to be told apart from the people behind them, and
 * after a round closes the ballot key is gone (spec §5.4). Combining what is there, once per
 * ballot token, is the honest arithmetic.
 */
export const MERGE_VOTE_COPY = 'Votes combine; no bonus, because votes are unlinkable.'

// ── Membership roles (people, design §3) ─────────────────────────────────────

/** Mirrors `event_members_role_check` (migration 0001). */
export type MemberRoleName = 'owner' | 'admin' | 'moderator' | 'track_lead' | 'volunteer' | 'attendee'

/**
 * How a person's role in a gathering is named wherever members see each other (the People
 * directory, the profile page). `attendee` has no badge — it is the default, and labelling it
 * would put a tag on everyone.
 */
export const MEMBER_ROLE: Record<MemberRoleName, string> = {
  owner: 'Owner',
  admin: 'Admin',
  moderator: 'Moderator',
  track_lead: 'Track lead',
  volunteer: 'Volunteer',
  attendee: 'Participant',
}

/** The roles shown as a badge on a member card: everything but the default. */
export const ORGANIZER_ROLES: readonly string[] = ['owner', 'admin', 'moderator']

/** The badge label for a role, or undefined for a plain participant (and for anything unknown). */
export function memberRoleBadge(role: string | null | undefined): string | undefined {
  if (!role || role === 'attendee') return undefined
  return (MEMBER_ROLE as Record<string, string>)[role]
}

// ── Where the explanation lives (design 2026-09-26 §6) ───────────────────────

/**
 * In-app copy says what happens now, in at most two sentences; the mechanism lives on
 * `/help/privacy` and is reached with a "Learn more" link. One place for the anchors, so a
 * renamed section is fixed once rather than in fifteen components.
 *
 *   <Link href={HELP_PRIVACY.never}>{LEARN_MORE}</Link>
 */
export const HELP_PRIVACY = {
  /** The page itself. */
  index: '/help/privacy',
  /** What is public. */
  public: '/help/privacy#public',
  /** What members of a gathering see. */
  members: '/help/privacy#members',
  /** What is never stored or shown. */
  never: '/help/privacy#never',
  /** Your identity on the open network. */
  identity: '/help/privacy#identity',
  /** AI assistants and transcripts. */
  assistants: '/help/privacy#assistants',
} as const

/** The one label used for every link into `/help`. Sentence case, never "Read more". */
export const LEARN_MORE = 'Learn more'
