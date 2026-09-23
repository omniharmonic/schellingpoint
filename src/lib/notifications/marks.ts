import 'server-only'
import type { Sql } from '@/lib/db'

/**
 * "This one has been said" (migration 0030, `notification_marks`).
 *
 * Notifications are emitted from application code, never from a trigger (spec §9), so
 * "send this exactly once" needs a row somewhere. This is that row.
 *
 * **Claim it in the same transaction as the `notify()` it guards.** Claiming on the service
 * connection and notifying in a separate transaction loses the notification for good when
 * that transaction fails: the mark says it was sent, and nothing will try again.
 */
export async function claimMark(db: Sql, eventId: string, kind: string, mark: string): Promise<boolean> {
  const rows = await db`
    insert into notification_marks (event_id, kind, mark) values (${eventId}, ${kind}, ${mark})
    on conflict do nothing
    returning event_id
  `
  return rows.length > 0
}

/** The one mark for "this gathering's attendance round was opened and announced". */
export const ATTENDANCE_MARK = { kind: 'attendance', mark: 'opened' } as const
