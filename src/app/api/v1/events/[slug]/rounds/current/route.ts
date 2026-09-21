/**
 * GET /api/v1/events/[slug]/rounds/current?round=pre|attendance (default pre)
 *
 * The event's current voting round of that phase — rules and window only, never a count:
 *   { round: { id, phase, mechanism, credits, opensAt, closesAt, finalizedAt, status } | null,
 *     status: 'none' | 'upcoming' | 'open' | 'closed',
 *     attendance: { open, votable_now: [sessionId] } }
 * Public for visible events; 404 for private/draft events to non-members.
 */
import { attendanceWindow, roundState } from '@/lib/voting'
import { errorResponse, json, resolveEvent, roundParam } from '@/lib/voting/http'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ slug: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const resolved = await resolveEvent(request, slug)
  if (resolved instanceof Response) return resolved
  const phase = roundParam(request)
  if (phase instanceof Response) return phase
  try {
    const [state, window] = await Promise.all([roundState(resolved.event.id, phase), attendanceWindow(resolved.event.id)])
    return json({ ...state, attendance: { open: window.open, votable_now: window.votable_now } })
  } catch (e) {
    return errorResponse(e, 'rounds/current')
  }
}
