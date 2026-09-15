import 'server-only'
import { sql as defaultSql, type Sql } from '@/lib/db'

/**
 * A person's notification feed. Every query is keyed by the viewer's own account id; there is
 * no way to name another recipient. Rows in a category whose in-app preference is off are
 * hidden (they may still be emailed).
 */

export interface FeedNotification {
  id: string
  event_id: string | null
  event_slug: string | null
  type: string
  title: string
  body: string | null
  action_url: string | null
  data: Record<string, unknown> | null
  created_at: string
  read_at: string | null
}

export interface FeedPage {
  notifications: FeedNotification[]
  unreadCount: number
  /** Pass back as `cursor` for the next (older) page; null at the end. */
  nextCursor: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const FEED_PAGE_MAX = 50

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/**
 * Newest first, keyset-paginated on (created_at, id). The cursor is the id of the last row
 * of the previous page; its position is looked up among the viewer's own rows, so a cursor
 * cannot reveal anything about someone else's feed.
 */
export async function listForViewer(
  accountId: string,
  options: { eventId?: string | null; cursor?: string | null; limit?: number; db?: Sql } = {},
): Promise<FeedPage> {
  const db = options.db ?? defaultSql
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), FEED_PAGE_MAX)
  const eventId = options.eventId ?? null
  if (eventId !== null && !isUuid(eventId)) return { notifications: [], unreadCount: 0, nextCursor: null }
  const cursor = options.cursor && isUuid(options.cursor) ? options.cursor : null

  const eventFilter = eventId ? db`and n.event_id = ${eventId}` : db``
  const cursorFilter = cursor
    ? db`and (n.created_at, n.id) < (
        select c.created_at, c.id from notifications c where c.id = ${cursor} and c.user_id = ${accountId}
      )`
    : db``

  const rows = await db<FeedNotification[]>`
    select n.id, n.event_id, e.slug as event_slug, n.type, n.title, n.body, n.action_url, n.data,
           n.created_at, n.read_at
    from notifications n
    left join events e on e.id = n.event_id
    where n.user_id = ${accountId}
      ${eventFilter}
      ${cursorFilter}
      and public.should_send_notification(n.user_id, n.event_id, n.type, 'in_app')
    order by n.created_at desc, n.id desc
    limit ${limit + 1}
  `

  const [{ unread }] = await db<{ unread: number }[]>`
    select count(*)::int as unread
    from notifications n
    where n.user_id = ${accountId}
      and n.read_at is null
      ${eventFilter}
      and public.should_send_notification(n.user_id, n.event_id, n.type, 'in_app')
  `

  const page = rows.slice(0, limit)
  return {
    notifications: page.map((r) => ({ ...r })),
    unreadCount: unread,
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
  }
}

/** Marks the viewer's own notifications read. Returns how many changed. */
export async function markRead(
  accountId: string,
  target: { ids: readonly string[] } | { all: true; eventId?: string | null },
  db: Sql = defaultSql,
): Promise<number> {
  if ('ids' in target) {
    const ids = [...new Set(target.ids)].filter(isUuid)
    if (ids.length === 0) return 0
    const result = await db`
      update notifications set read_at = now()
      where user_id = ${accountId} and read_at is null and id in ${db(ids)}
    `
    return result.count
  }
  const eventId = target.eventId ?? null
  if (eventId !== null && !isUuid(eventId)) return 0
  const result = await db`
    update notifications set read_at = now()
    where user_id = ${accountId} and read_at is null
      ${eventId ? db`and event_id = ${eventId}` : db``}
  `
  return result.count
}
