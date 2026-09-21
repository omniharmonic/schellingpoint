/**
 * Quality of a draft schedule (release design §9.3 "drag-drop revalidates").
 *   POST /api/v1/events/[slug]/admin/schedule-quality
 *        { assignments: [{ sessionId, slotId, venueId? }] }
 *
 * The draft overrides the stored placement of every session it names; sessions it does not
 * name keep their current slot. Nothing is written. Answers 409 `RoundOpen` while the round
 * is open, since the score needs the sealed ballots.
 */
import { loadSchedulingContext, RoundOpenError, roundOpenResponse } from '@/lib/scheduling/context'
import { buildObjectiveContext, type Placement } from '@/lib/scheduling/objective'
import { qualityScore } from '@/lib/scheduling/quality'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')
const MAX_ASSIGNMENTS = 1000

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  const raw = body.assignments
  if (!Array.isArray(raw)) return fail(400, 'assignments must be a list', { field: 'assignments' })
  if (raw.length > MAX_ASSIGNMENTS) return fail(400, `At most ${MAX_ASSIGNMENTS} assignments at once`, { field: 'assignments' })
  const draft: Array<{ sessionId: string; slotId: string; venueId: string | null }> = []
  for (const a of raw) {
    const item = (a ?? {}) as Record<string, unknown>
    if (!isUuid(item.sessionId) || !isUuid(item.slotId)) return fail(400, 'Each assignment needs a sessionId and slotId', { field: 'assignments' })
    if (item.venueId !== undefined && item.venueId !== null && !isUuid(item.venueId)) return fail(400, 'venueId must be an id', { field: 'assignments' })
    draft.push({ sessionId: item.sessionId, slotId: item.slotId, venueId: (item.venueId as string | undefined) ?? null })
  }
  if (new Set(draft.map((a) => a.sessionId)).size !== draft.length) return fail(400, 'Each session may appear only once', { field: 'assignments' })

  try {
    let inputs: Awaited<ReturnType<typeof loadSchedulingContext>>
    try {
      inputs = await loadSchedulingContext(ctx.event.id)
    } catch (e) {
      if (e instanceof RoundOpenError) return roundOpenResponse()
      throw e
    }
    const objective = buildObjectiveContext(inputs.sessions, inputs.timeSlots, inputs.venues, {
      ballots: inputs.ballots,
      k: inputs.k,
      timezone: inputs.event.timezone,
    })
    const assignments = new Map<string, Placement>(objective.fixed)
    for (const a of draft) {
      const slot = objective.slots.get(a.slotId)
      if (!objective.sessions.has(a.sessionId) || !slot) {
        return fail(400, 'Some assignments refer to sessions or slots outside this event', { field: 'assignments' })
      }
      const venueId = a.venueId ?? slot.venue_id
      if (!venueId || !objective.venues.has(venueId)) return fail(400, 'Some assignments refer to rooms outside this event', { field: 'assignments' })
      assignments.set(a.sessionId, { slotId: a.slotId, venueId })
    }
    const quality = qualityScore(assignments, objective)
    return json({ roundId: inputs.roundId, k: objective.k, evaluated: assignments.size, draft: draft.length, quality })
  } catch (e) {
    return errorResponse(e, 'schedule quality')
  }
}
