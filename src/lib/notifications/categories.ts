/**
 * Notification types, categories and their labels. Safe for the browser: no server imports.
 *
 * NOTIFICATION_CATEGORY mirrors `public.get_notification_category()` in
 * db/migrations/0003_notifications_outbox.sql; tests/notifications.spec.ts asserts they agree.
 */

/**
 * Values of the notifications.type CHECK. `vote_milestone` is deliberately absent: a
 * milestone notification leaks a live tally while a round is open (spec §5.3), so it is
 * never emitted again.
 */
export const NOTIFICATION_TYPES = [
  'session_submitted',
  'session_approved',
  'session_rejected',
  'session_scheduled',
  'session_rescheduled',
  'session_cancelled',
  'cohost_invited',
  'cohost_accepted',
  'cohost_declined',
  'voting_opened',
  'voting_closed',
  'schedule_published',
  'event_reminder',
  'admin_announcement',
  'new_proposal',
  'proposal_needs_review',
  'proposal_changed', // cid drift or withdrawal of a scheduled session's proposal (spec §6)
  'approval_requested', // a destructive action awaits another organizer (spec §6)
  'event_invitation',
  'ticket_confirmed',
  'ticket_refunded',
  'payments_paused',
  // 0030: the two lifecycle announcements members were never told about, and the
  // waitlist promotion that used to happen silently inside a trigger.
  'event_published',
  'proposals_open',
  'rsvp_promoted',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]

export const NOTIFICATION_CATEGORIES = [
  'session_updates',
  'voting_updates',
  'collaboration',
  'event_announcements',
  'admin_alerts',
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export const NOTIFICATION_CATEGORY: Record<NotificationType, NotificationCategory> = {
  session_submitted: 'session_updates',
  session_approved: 'session_updates',
  session_rejected: 'session_updates',
  session_scheduled: 'session_updates',
  session_rescheduled: 'session_updates',
  session_cancelled: 'session_updates',
  rsvp_promoted: 'session_updates',
  cohost_invited: 'collaboration',
  cohost_accepted: 'collaboration',
  cohost_declined: 'collaboration',
  // `voting_updates` used to control nothing (the milestone it was written for is
  // forbidden by spec §5.3). The two notices a voter acts on live here instead.
  voting_opened: 'voting_updates',
  voting_closed: 'voting_updates',
  schedule_published: 'event_announcements',
  event_reminder: 'event_announcements',
  admin_announcement: 'event_announcements',
  event_invitation: 'event_announcements',
  ticket_confirmed: 'event_announcements',
  ticket_refunded: 'event_announcements',
  event_published: 'event_announcements',
  proposals_open: 'event_announcements',
  payments_paused: 'admin_alerts',
  new_proposal: 'admin_alerts',
  proposal_needs_review: 'admin_alerts',
  proposal_changed: 'admin_alerts',
  approval_requested: 'admin_alerts',
}

/**
 * Types whose email is a receipt for something the recipient did, sent regardless of the
 * category's email preference (still shown in the feed only if in-app is on).
 */
export const TRANSACTIONAL_TYPES: ReadonlySet<NotificationType> = new Set<NotificationType>(['ticket_confirmed', 'ticket_refunded'])

export const CATEGORY_INFO: Record<NotificationCategory, { label: string; description: string }> = {
  session_updates: {
    label: 'Session updates',
    description: 'When your sessions are approved, declined, scheduled, moved or cancelled, and when a waitlisted RSVP of yours becomes a seat',
  },
  voting_updates: {
    label: 'Voting updates',
    description: 'When a voting round opens and when it closes. Never a running count — nobody sees one while a round is open.',
  },
  collaboration: {
    label: 'Collaboration',
    description: 'Co-host invitations and responses',
  },
  event_announcements: {
    label: 'Event announcements',
    description: 'The gathering going live, proposals opening, the published schedule, reminders, invitations and ticket confirmations',
  },
  admin_alerts: {
    label: 'Organizer alerts',
    description: 'New proposals, proposals that changed after scheduling, and approvals you are asked for',
  },
}

export const TYPE_LABELS: Record<string, string> = {
  session_submitted: 'Session submitted',
  session_approved: 'Session approved',
  session_rejected: 'Session declined',
  session_scheduled: 'Session scheduled',
  session_rescheduled: 'Session moved',
  session_cancelled: 'Session cancelled',
  cohost_invited: 'Co-host invitation',
  cohost_accepted: 'Co-host accepted',
  cohost_declined: 'Co-host declined',
  voting_opened: 'Voting open',
  voting_closed: 'Voting closed',
  schedule_published: 'Schedule published',
  event_reminder: 'Reminder',
  admin_announcement: 'Announcement',
  new_proposal: 'New proposal',
  proposal_needs_review: 'Review needed',
  proposal_changed: 'Proposal changed',
  approval_requested: 'Approval requested',
  event_invitation: 'Invitation',
  ticket_confirmed: 'Ticket confirmed',
  ticket_refunded: 'Ticket refunded',
  payments_paused: 'Payments paused',
  event_published: 'Gathering published',
  proposals_open: 'Proposals open',
  rsvp_promoted: 'Off the waitlist',
}

export function isNotificationType(value: unknown): value is NotificationType {
  return typeof value === 'string' && (NOTIFICATION_TYPES as readonly string[]).includes(value)
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}
