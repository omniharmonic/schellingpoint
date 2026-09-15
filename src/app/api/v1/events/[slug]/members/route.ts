/**
 * GET /api/v1/events/[slug]/members — the roster, for owners and admins.
 *
 * The roster is app-side and never published (spec §8). Emails are shown to the event's
 * owners and admins only, so they can recognise who they are managing.
 */
import { sql } from '@/lib/db'
import { errorResponse, json, requireOrganizer } from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const ROLES = ['owner', 'admin'] as const

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const rows = await sql<{
      id: string; user_id: string; role: string; joined_at: string | null
      display_name: string | null; email: string | null; handle: string | null
    }[]>`
      select m.id, m.user_id, m.role, m.joined_at, p.display_name, a.email, a.handle
      from event_members m
      join accounts a on a.id = m.user_id
      left join profiles p on p.id = m.user_id
      where m.event_id = ${ctx.event.id}
      order by array_position(array['owner','admin','moderator','track_lead','volunteer','attendee'], m.role),
               m.joined_at nulls last
    `
    return json({
      members: rows.map((r) => ({
        id: r.id,
        user_id: r.user_id,
        role: r.role,
        joined_at: r.joined_at,
        user_data: { display_name: r.display_name, email: r.email, handle: r.handle },
      })),
      viewerRole: ctx.role,
    })
  } catch (e) {
    return errorResponse(e, 'list members')
  }
}
