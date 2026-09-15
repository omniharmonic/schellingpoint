import { sql } from '@/lib/db'
import { loadEventAccess, json } from '@/app/api/v1/sessions/_lib/access'

/**
 * GET /api/v1/events/[slug]/tracks — the event's active tracks for pickers and filters.
 * No track-lead fields: a lead is app-side and organizer-only (spec §4.2, R9).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  const tracks = await sql<{ id: string; name: string; slug: string; description: string | null; color: string | null; display_order: number | null }[]>`
    select id, name, slug, description, color, display_order
    from tracks
    where event_id = ${access.event.id} and coalesce(is_active, true)
    order by display_order asc nulls last, lower(name) asc
  `
  return json({ tracks })
}
