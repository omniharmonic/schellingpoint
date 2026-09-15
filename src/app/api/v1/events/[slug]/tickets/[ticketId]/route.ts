/**
 * One of the signed-in viewer's own tickets.
 *
 *   GET /api/v1/events/[slug]/tickets/[ticketId]
 *   → { ticket: { id, status, created_at, checked_in_at, tier: { name, description } } }
 *
 * 404 for tickets that are not the viewer's.
 */
import { requireViewer } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { jsonError } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
): Promise<Response> {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { slug, ticketId } = await params
  if (!UUID.test(ticketId)) return jsonError(404, 'Ticket not found')

  const [ticket] = await sql`
    select tk.id, tk.status, tk.created_at, tk.checked_in_at,
           json_build_object('name', tt.name, 'description', tt.description) as tier
    from tickets tk
    join events e on e.id = tk.event_id
    join ticket_tiers tt on tt.id = tk.tier_id
    where tk.id = ${ticketId} and e.slug = ${slug} and tk.user_id = ${viewer.accountId}
  `
  if (!ticket) return jsonError(404, 'Ticket not found')
  return Response.json({ ticket }, { headers: { 'Cache-Control': 'private, no-store' } })
}
