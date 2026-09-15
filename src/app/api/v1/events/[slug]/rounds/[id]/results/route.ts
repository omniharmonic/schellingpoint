/**
 * GET /api/v1/events/[slug]/rounds/[id]/results — organizers (owner/admin/moderator) only.
 *
 * Raw per-session results of a finalized round, most votes first:
 *   { round, results: [{ sessionId, voters, votes, credits }] }
 * 409 { error: 'RoundOpen' } while the round is open: organizers see no counts mid-round
 * (spec §5.3 step 3).
 */
import { requireEventRole } from '@/lib/auth/viewer'
import { getRound, organizerResults } from '@/lib/voting'
import { errorResponse, json, jsonError, ORGANIZER_ROLES } from '@/lib/voting/http'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ slug: string; id: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const auth = await requireEventRole(request, slug, ORGANIZER_ROLES)
  if (auth instanceof Response) return auth
  try {
    const round = await getRound(auth.event.id, id)
    if (!round) return jsonError(404, 'Voting round not found')
    const results = await organizerResults(auth.event.id, { roundId: round.id })
    return json({ round: { ...round, status: 'closed' }, results })
  } catch (e) {
    return errorResponse(e, 'rounds/results')
  }
}
