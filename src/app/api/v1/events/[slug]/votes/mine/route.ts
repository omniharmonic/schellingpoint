/**
 * /api/v1/events/[slug]/votes/mine — the signed-in participant's own allocation.
 *
 * GET ?round=pre|attendance (default pre)
 *   → { round, status, mechanism, allocation: { [sessionId]: votes }, spent, budget,
 *       remaining, canVote, reason, sealed, eligibility, sessions: [{ id, title, format, status, track }],
 *       attendance: { open, votable_now: [sessionId], credits_remaining } }
 * PUT { sessionId, votes, round?: 'pre' | 'attendance' } → the same shape after the change (votes = 0 removes).
 *
 * `attendance` describes the attendance round (design §11) whatever `round` was asked for:
 * whether it accepts votes right now, which sessions are inside their slot ± 15 min, and the
 * caller's remaining fresh credits in it (null when it is not open).
 *
 * Only ever the caller's own votes. Once a round closes its ledger is deleted, so
 * `allocation` is empty and `sealed` is true. Nothing here is a count of anyone else's votes.
 */
import { assertSameOrigin } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { attendanceWindow, getAllocation, setAllocation, type AllocationView } from '@/lib/voting'
import type { RoundPhase } from '@/lib/voting/mechanism'
import { errorResponse, json, jsonError, readJson, resolveEvent, roundParam } from '@/lib/voting/http'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ slug: string }> }

async function withSessions(eventId: string, view: AllocationView) {
  const ids = Object.keys(view.allocation)
  const rows = ids.length
    ? await sql<{ id: string; title: string; format: string | null; status: string; track: { name: string; color: string | null } | null }[]>`
        select s.id, s.title, s.format, s.status,
               case when t.id is null then null else json_build_object('name', t.name, 'color', t.color) end as track
        from sessions s
        left join tracks t on t.id = s.track_id and t.event_id = s.event_id
        where s.event_id = ${eventId} and s.id in ${sql(ids)}
        order by s.title
      `
    : []
  return { ...view, sessions: rows }
}

/** The attendance block: the window, and the caller's remaining credits when `view` is that round's. */
async function withAttendance(eventId: string, accountId: string, phase: RoundPhase, view: AllocationView) {
  const window = await attendanceWindow(eventId)
  let creditsRemaining: number | null = null
  if (window.open) {
    creditsRemaining = phase === 'attendance' ? view.remaining : (await getAllocation(eventId, accountId, 'attendance')).remaining
  }
  return { open: window.open, votable_now: window.votable_now, credits_remaining: creditsRemaining }
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const resolved = await resolveEvent(request, slug)
  if (resolved instanceof Response) return resolved
  if (!resolved.viewer) return jsonError(401, 'Unauthorized')
  const phase = roundParam(request)
  if (phase instanceof Response) return phase
  try {
    const view = await getAllocation(resolved.event.id, resolved.viewer.accountId, phase)
    const attendance = await withAttendance(resolved.event.id, resolved.viewer.accountId, phase, view)
    return json({ ...(await withSessions(resolved.event.id, view)), attendance })
  } catch (e) {
    return errorResponse(e, 'votes/mine GET')
  }
}

export async function PUT(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const resolved = await resolveEvent(request, slug)
  if (resolved instanceof Response) return resolved
  if (!resolved.viewer) return jsonError(401, 'Unauthorized')

  const body = await readJson(request)
  if (body instanceof Response) return body
  const { sessionId, votes } = body
  if (typeof sessionId !== 'string') return jsonError(400, 'sessionId is required', { field: 'sessionId' })
  if (typeof votes !== 'number' || !Number.isInteger(votes) || votes < 0) {
    return jsonError(400, 'votes must be a whole number of 0 or more', { field: 'votes' })
  }
  const phase = roundParam(request, body)
  if (phase instanceof Response) return phase

  try {
    const view = await setAllocation(resolved.event.id, resolved.viewer.accountId, sessionId, votes, phase)
    const attendance = await withAttendance(resolved.event.id, resolved.viewer.accountId, phase, view)
    return json({ ...(await withSessions(resolved.event.id, view)), attendance })
  } catch (e) {
    return errorResponse(e, 'votes/mine PUT')
  }
}
