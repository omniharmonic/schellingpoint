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
}

const UNKNOWN_NOTIFICATION: NotificationTypeLabel = { label: 'Notification', dot: 'bg-muted-foreground' }

/** Label + dot class for a notification type; unknown values fall back to a neutral entry. */
export function notificationType(type: string | null | undefined): NotificationTypeLabel {
  return (type && (NOTIFICATION_TYPE as Record<string, NotificationTypeLabel>)[type]) || UNKNOWN_NOTIFICATION
}
