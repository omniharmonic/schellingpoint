/**
 * GET /api/v1/events/[slug]/announcements?limit=1..10 (default 3)
 *
 * "From the organizers" on Home (mobile shell design §3.5): the viewer's own most recent
 * `admin_announcement` notifications **for this gathering**. It is a read of the caller's feed, not
 * a broadcast log: the query is keyed by their account id and by the resolved event id, so it can
 * neither name another recipient nor leak an announcement from a different gathering. Categories
 * the person muted in-app stay hidden, exactly as the notifications page treats them.
 *
 * 404 for a private or draft gathering the caller is not a member of (existence is not disclosed);
 * 401 when nobody is signed in — there is no such thing as someone else's announcements.
 */
import { sql } from '@/lib/db'
import { json, jsonError, loadEventAccess } from '@/app/api/v1/sessions/_lib/access'

export const dynamic = 'force-dynamic'

export interface Announcement {
  id: string
  title: string
  body: string | null
  action_url: string | null
  created_at: string
  read_at: string | null
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  if (!access.viewer) return jsonError(401, 'Unauthorized')

  const asked = Number.parseInt(new URL(request.url).searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), 10) : 3

  const announcements = await sql<Announcement[]>`
    select n.id, n.title, n.body, n.action_url, n.created_at, n.read_at
    from notifications n
    where n.user_id = ${access.viewer.accountId}
      and n.event_id = ${access.event.id}
      and n.type = 'admin_announcement'
      and public.should_send_notification(n.user_id, n.event_id, n.type, 'in_app')
    order by n.created_at desc, n.id desc
    limit ${limit}
  `
  return json({ announcements })
}
