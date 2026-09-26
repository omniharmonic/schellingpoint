/**
 * GET /api/v1/events/[slug]/map — what the gathering's map needs beyond its pins (design §1.2,
 * §1.4, §1.5).
 *
 *   { view, view_source, located, outlines, custom_map }
 *
 * `view` is the resolved map area: the organizer's saved override when there is one, otherwise the
 * fitted bounds of the located rooms (`resolveMapView`). A viewer who is not a member never
 * contributes a private residence to that fit — a padded box around one home would put the map over
 * that home — and gets no outlines and no custom map at all.
 *
 * Outlines and custom maps are app-side only: neither is ever written to a record. A private
 * residence can have no outline in the first place (the venues route answers 409).
 *
 * A private or draft gathering answers 404 to non-members, like every gathering read.
 */
import { json, loadEventAccess } from '@/app/api/v1/sessions/_lib/access'
import { loadEventMapData, outlinesOf, resolveFromRooms } from '@/lib/geo/event-map'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  const member = !!access.role
  const data = await loadEventMapData(access.event.id)
  const resolved = resolveFromRooms(data, { includePrivate: member })
  return json({
    view: resolved.view,
    view_source: resolved.source,
    located: resolved.located,
    outlines: member ? outlinesOf(data) : [],
    custom_map: member ? data.customMap : null,
  })
}
