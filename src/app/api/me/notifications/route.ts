/**
 * The signed-in person's notification feed.
 *
 *   GET /api/me/notifications?event=<slug>&cursor=<id>&limit=<1..50>
 *   → { notifications, unreadCount, nextCursor }
 */
import { requireViewer } from '@/lib/auth/viewer'
import { listForViewer } from '@/lib/notifications'
import { resolveEventScope } from '@/lib/notifications/scope'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request): Promise<Response> {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const url = new URL(request.url)
  const slug = url.searchParams.get('event')
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '', 10)

  let eventId: string | null = null
  if (slug) {
    const scope = await resolveEventScope(slug, viewer.accountId)
    if (!scope) return Response.json({ notifications: [], unreadCount: 0, nextCursor: null }, { headers: NO_STORE })
    eventId = scope.id
  }

  const page = await listForViewer(viewer.accountId, {
    eventId,
    cursor: url.searchParams.get('cursor'),
    limit: Number.isFinite(limit) ? limit : undefined,
  })
  return Response.json(page, { headers: NO_STORE })
}
