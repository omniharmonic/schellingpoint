import { sql } from '@/lib/db'
import { loadEventAccess, json } from '@/app/api/v1/sessions/_lib/access'
import { DEFAULT_ROOM_FEATURES } from '@/lib/sessions/constants'

/**
 * GET /api/v1/events/[slug]/room-features — the gathering's feature vocabulary: the union of
 * what its rooms actually have (`venues.features`), so "what the room needs" on a proposal is
 * a set of checkboxes a proposer can be matched against rather than free text nobody indexed.
 *
 * Feature words only. No room names, no capacities, no addresses — a proposer does not need
 * to know which room has the whiteboard, and a private residence's existence is not disclosed
 * by this list. 404 for a private or draft gathering to a non-member, like every other read.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  const rows = await sql<{ feature: string }[]>`
    select distinct trim(f) as feature
    from venues v, unnest(coalesce(v.features, '{}'::text[])) as f
    where v.event_id = ${access.event.id} and trim(f) <> ''
    order by 1
  `
  const features = rows.map((r) => r.feature)
  return json({
    features,
    // With no rooms described yet, offer the PRD's four so the field is still usable.
    suggested: features.length > 0 ? [] : DEFAULT_ROOM_FEATURES,
  })
}
