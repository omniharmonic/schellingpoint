import 'server-only'
import type { Sql } from '@/lib/db'
import { isNotificationType, type NotificationType } from './categories'

/**
 * Application-level notification emission (spec §6: "the Postgres triggers are replaced by
 * application-level emission at the port call site — triggers cannot see the audit context and
 * cannot be tested"). Call it inside the same transaction as the action it describes, so a
 * rolled-back action never leaves a notification behind.
 *
 * The notifications table is also the email outbox: `dispatchPending()` (run by the scheduler
 * through `/api/notifications/dispatch`) sends what `notify()` wrote, honouring preferences.
 *
 * Owned by work package E. The `notify` signature is the Wave 1 contract; keep it stable.
 */

export type { NotificationType, NotificationCategory } from './categories'
export { NOTIFICATION_TYPES, NOTIFICATION_CATEGORIES, NOTIFICATION_CATEGORY, TRANSACTIONAL_TYPES } from './categories'
export { dispatchPending, type DispatchOptions, type DispatchResult } from './dispatch'
export { listForViewer, markRead, type FeedNotification, type FeedPage } from './feed'
export { getPreferences, setPreferences, type EffectivePreference, type PreferenceUpdate } from './preferences'

export interface NotifyInput {
  eventId: string | null
  /** Recipients (account ids). Duplicates and nulls are dropped. */
  userIds: ReadonlyArray<string | null | undefined>
  type: NotificationType
  title: string
  body?: string | null
  /** App-relative path (`/e/<slug>/...`). Absolute links to other origins are not emailed. */
  actionUrl?: string | null
  /** Never put another person's DID, email or vote in here: notifications are an activity log. */
  data?: Record<string, unknown>
}

/**
 * Inserts one notification row per recipient. Returns the number of rows written.
 *
 * Works inside `tx()` and inside `asAccount()` transactions: the insert goes through the
 * definer function `emit_notifications` because notifications has no INSERT policy for the
 * `authenticated` role (nobody may write into someone else's feed from a person's session).
 */
export async function notify(sql: Sql, input: NotifyInput): Promise<number> {
  if (!isNotificationType(input.type)) throw new Error(`notify: unknown notification type ${String(input.type)}`)
  const title = input.title.trim()
  if (!title) throw new Error('notify: title is required')
  const recipients = [...new Set(input.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (recipients.length === 0) return 0
  // sql.json, never JSON.stringify: with prepared statements postgres.js serializes the value for
  // the jsonb parameter itself, so a pre-stringified object would be stored as a JSON *string*.
  const [row] = await sql<{ count: number }[]>`
    select public.emit_notifications(
      ${input.eventId}::uuid,
      ${recipients}::uuid[],
      ${input.type}::text,
      ${title}::text,
      ${input.body ?? null}::text,
      ${input.actionUrl ?? null}::text,
      ${sql.json((input.data ?? {}) as Parameters<typeof sql.json>[0])}::jsonb
    ) as count
  `
  return row?.count ?? 0
}
