/**
 * Organizer controls over a voting round (inventory 5.10 / P2-14). Owner and admin only.
 *
 *   GET    → { rounds: { 'pre-event': …, attendance: … }, actions: [...] }   windows + audit
 *   POST   { round?, closesAt?, credits?, mechanism? }   open the round now
 *   PATCH  { round?, closesAt }                          move closes_at later
 *   DELETE ?round=pre|attendance                         force-close now (the job's own path)
 *
 * Not one of these reads or returns a count: `rounds` carries rules and window only, exactly
 * like `rounds/current`, and the close runs `closeRound`, which destroys the ballot key inside
 * its transaction. An organizer decides when voting ends and still learns nothing until it has.
 */
import { requireEventRole, assertSameOrigin } from '@/lib/auth/viewer'
import { roundState } from '@/lib/voting'
import { extendRound, forceCloseRound, listRoundActions, openRoundNow } from '@/lib/voting/controls'
import { errorResponse, json, jsonError, readJson, roundParam } from '@/lib/voting/http'
import type { EventRoleName } from '@/types/event'

export const dynamic = 'force-dynamic'

const ROLES: readonly EventRoleName[] = ['owner', 'admin']

type RouteParams = { params: Promise<{ slug: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, ROLES)
  if (auth instanceof Response) return auth
  try {
    const [pre, attendance, actions] = await Promise.all([
      roundState(auth.event.id, 'pre-event'),
      roundState(auth.event.id, 'attendance'),
      listRoundActions(auth.event.id),
    ])
    return json({ rounds: { 'pre-event': pre, attendance }, actions })
  } catch (e) {
    return errorResponse(e, 'rounds/controls GET')
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const auth = await requireEventRole(request, slug, ROLES)
  if (auth instanceof Response) return auth
  const body = await readJson(request)
  if (body instanceof Response) return body
  const phase = roundParam(request, body)
  if (phase instanceof Response) return phase
  try {
    const round = await openRoundNow({
      eventId: auth.event.id,
      phase,
      actorId: auth.viewer.accountId,
      closesAt: typeof body.closesAt === 'string' && body.closesAt ? body.closesAt : undefined,
      credits: typeof body.credits === 'number' ? body.credits : undefined,
      mechanism: typeof body.mechanism === 'string' ? (body.mechanism as 'quadratic' | 'linear' | 'approval') : undefined,
    })
    return json({ round, status: round.status }, 201)
  } catch (e) {
    return errorResponse(e, 'rounds/controls POST')
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const auth = await requireEventRole(request, slug, ROLES)
  if (auth instanceof Response) return auth
  const body = await readJson(request)
  if (body instanceof Response) return body
  const phase = roundParam(request, body)
  if (phase instanceof Response) return phase
  if (typeof body.closesAt !== 'string' || !body.closesAt) {
    return jsonError(400, 'closesAt is required', { code: 'InvalidRound', field: 'closesAt' })
  }
  try {
    const round = await extendRound({ eventId: auth.event.id, phase, actorId: auth.viewer.accountId, closesAt: body.closesAt })
    return json({ round, status: round.status })
  } catch (e) {
    return errorResponse(e, 'rounds/controls PATCH')
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const auth = await requireEventRole(request, slug, ROLES)
  if (auth instanceof Response) return auth
  const phase = roundParam(request)
  if (phase instanceof Response) return phase
  try {
    const { round, result } = await forceCloseRound({ eventId: auth.event.id, phase, actorId: auth.viewer.accountId })
    // `ballotsCast` is how many people took part, never how they voted: the same number the
    // public tally already carries (spec §5.3 step 5).
    return json({ round, closed: result.closed, ballotsCast: result.ballotsCast })
  } catch (e) {
    return errorResponse(e, 'rounds/controls DELETE')
  }
}
