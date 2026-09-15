/**
 * /api/v1/events/[slug]/votes/mine — the signed-in participant's own allocation.
 *
 * GET → { round, status, mechanism, allocation: { [sessionId]: votes }, spent, budget,
 *         remaining, canVote, reason, sealed, eligibility, sessions: [{ id, title, format, status, track }] }
 * PUT { sessionId, votes } → the same shape after the change (votes = 0 removes).
 *
 * Only ever the caller's own votes. Once the round closes the ledger is deleted, so
 * `allocation` is empty and `sealed` is true.
 */
import { assertSameOrigin } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { getAllocation, setAllocation, type AllocationView } from '@/lib/voting'
import { errorResponse, json, jsonError, readJson, resolveEvent } from '@/lib/voting/http'

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

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const resolved = await resolveEvent(request, slug)
  if (resolved instanceof Response) return resolved
  if (!resolved.viewer) return jsonError(401, 'Unauthorized')
  try {
    const view = await getAllocation(resolved.event.id, resolved.viewer.accountId)
    return json(await withSessions(resolved.event.id, view))
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

  try {
    const view = await setAllocation(resolved.event.id, resolved.viewer.accountId, sessionId, votes)
    return json(await withSessions(resolved.event.id, view))
  } catch (e) {
    return errorResponse(e, 'votes/mine PUT')
  }
}
