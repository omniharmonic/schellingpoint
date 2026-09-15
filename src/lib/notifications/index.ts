import 'server-only'
import type { Sql } from '@/lib/db'

/**
 * Application-level notification emission (spec §6: "the Postgres triggers are replaced by
 * application-level emission at the port call site — triggers cannot see the audit context and
 * cannot be tested"). Call it inside the same transaction as the action it describes, so a
 * rolled-back action never leaves a notification behind.
 *
 * Owned by work package E, which adds the outbox dispatch, preferences and retention around it.
 * The signature is the Wave 1 contract; keep it stable.
 */
/**
 * Existing values of the notifications.type CHECK, plus four that work package E adds in its
 * migration (marked NEW). `vote_milestone` is deliberately absent: a milestone notification
 * leaks a live tally while a round is open (spec §5.3), so it is never emitted again.
 */
export type NotificationType =
  | 'session_submitted'
  | 'session_approved'
  | 'session_rejected'
  | 'session_scheduled'
  | 'session_rescheduled'
  | 'session_cancelled'
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
  | 'proposal_changed' // NEW: cid drift on a scheduled session (spec §6)
  | 'approval_requested' // NEW: a destructive action awaits a second organizer (spec §6)
  | 'event_invitation' // NEW
  | 'ticket_confirmed' // NEW

export interface NotifyInput {
  eventId: string | null
  /** Recipients (account ids). Duplicates and nulls are dropped. */
  userIds: ReadonlyArray<string | null | undefined>
  type: NotificationType
  title: string
  body?: string | null
  actionUrl?: string | null
  /** Never put another person's DID, email or vote in here: notifications are an activity log. */
  data?: Record<string, unknown>
}

/** Inserts one notification row per recipient. Returns the number of rows written. */
export async function notify(sql: Sql, input: NotifyInput): Promise<number> {
  const recipients = [...new Set(input.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (recipients.length === 0) return 0
  const result = await sql`
    insert into notifications (user_id, event_id, type, title, body, action_url, data)
    select recipient, ${input.eventId}, ${input.type}, ${input.title}, ${input.body ?? null},
           ${input.actionUrl ?? null}, ${JSON.stringify(input.data ?? {})}::jsonb
    from unnest(${recipients}::uuid[]) as recipient
  `
  return result.count
}
