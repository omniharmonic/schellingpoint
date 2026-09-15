/**
 * GET /api/v1/events/[slug]/rounds/current
 *
 * The event's current voting round — rules and window only, never a count:
 *   { round: { id, phase, mechanism, credits, opensAt, closesAt, finalizedAt, status } | null,
 *     status: 'none' | 'upcoming' | 'open' | 'closed' }
 * Public for visible events; 404 for private/draft events to non-members.
 */
import { roundState } from '@/lib/voting'
import { errorResponse, json, resolveEvent } from '@/lib/voting/http'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ slug: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const resolved = await resolveEvent(request, slug)
  if (resolved instanceof Response) return resolved
  try {
    const state = await roundState(resolved.event.id)
    return json(state)
  } catch (e) {
    return errorResponse(e, 'rounds/current')
  }
}
