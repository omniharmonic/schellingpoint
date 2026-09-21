/**
 * Auto-schedule.
 *   GET  /api/v1/events/[slug]/admin/auto-schedule   preview proposed assignments (no writes)
 *   POST /api/v1/events/[slug]/admin/auto-schedule   apply { assignments: [{ sessionId, slotId }] }
 *
 * Voter overlap is computed on ballot tokens after the round closes (spec §5.4). While a
 * round is open the preview answers 409 `RoundOpen`: the scheduler's inputs are sealed.
 * The preview returns the greedy-plus-local-search proposal with its quality report and the
 * five PRD stages (release design §9). Applying writes only unpublished placements into
 * free slots, as the organizer's account; sessions already on the network are never moved here.
 */
import { asAccount } from '@/lib/db'
import { autoSchedule } from '@/lib/scheduling/auto-scheduler'
import { loadSchedulingContext, RoundOpenError, roundOpenResponse } from '@/lib/scheduling/context'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { notifyPlacement } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')
const MAX_ASSIGNMENTS = 1000

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const eventId = ctx.event.id

  try {
    let inputs: Awaited<ReturnType<typeof loadSchedulingContext>>
    try {
      inputs = await loadSchedulingContext(eventId)
    } catch (e) {
      if (e instanceof RoundOpenError) return roundOpenResponse()
      throw e
    }
    const result = autoSchedule(inputs.sessions, inputs.timeSlots, inputs.venues, {
      ballots: inputs.ballots,
      timezone: inputs.event.timezone,
      k: inputs.k,
    })
    return json({ ...result, roundId: inputs.roundId })
  } catch (e) {
    return errorResponse(e, 'auto-schedule preview')
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body
  const eventId = ctx.event.id

  const raw = body.assignments
  if (!Array.isArray(raw) || raw.length === 0) return fail(400, 'No assignments selected', { field: 'assignments' })
  if (raw.length > MAX_ASSIGNMENTS) return fail(400, `At most ${MAX_ASSIGNMENTS} assignments at once`, { field: 'assignments' })
  const assignments: Array<{ sessionId: string; slotId: string }> = []
  for (const a of raw) {
    const sessionId = (a as Record<string, unknown>)?.sessionId
    const slotId = (a as Record<string, unknown>)?.slotId
    if (!isUuid(sessionId) || !isUuid(slotId)) return fail(400, 'Each assignment needs a sessionId and slotId', { field: 'assignments' })
    assignments.push({ sessionId, slotId })
  }
  if (new Set(assignments.map((a) => a.sessionId)).size !== assignments.length || new Set(assignments.map((a) => a.slotId)).size !== assignments.length) {
    return fail(400, 'Each session and each slot may appear only once', { field: 'assignments' })
  }

  try {
    const outcome = await asAccount(ctx.viewer.accountId, async (tx) => {
      const sessions = await tx<{ id: string; title: string; status: string; time_slot_id: string | null }[]>`
        select id, title, status, time_slot_id from sessions
        where event_id = ${eventId} and id in ${tx(assignments.map((a) => a.sessionId))}
        for update
      `
      const slots = await tx<{ id: string; venue_id: string | null; is_break: boolean | null; taken: boolean }[]>`
        select t.id, t.venue_id, t.is_break,
               exists (select 1 from sessions s where s.event_id = t.event_id and s.time_slot_id = t.id) as taken
        from time_slots t
        where t.event_id = ${eventId} and t.id in ${tx(assignments.map((a) => a.slotId))}
        for update of t
      `
      if (sessions.length !== assignments.length || slots.length !== assignments.length) {
        return { invalid: true as const }
      }
      const sessionById = new Map(sessions.map((s) => [s.id, s]))
      const slotById = new Map(slots.map((s) => [s.id, s]))
      const applied: string[] = []
      const skipped: Array<{ sessionId: string; title: string; reason: string }> = []
      for (const a of assignments) {
        const session = sessionById.get(a.sessionId)!
        const slot = slotById.get(a.slotId)!
        const reason =
          session.status !== 'approved' || session.time_slot_id ? 'No longer waiting to be scheduled'
            : slot.is_break || !slot.venue_id ? 'That slot cannot hold a session'
              : slot.taken ? 'That slot was filled in the meantime'
                : null
        if (reason) {
          skipped.push({ sessionId: a.sessionId, title: session.title, reason })
          continue
        }
        await tx`
          update sessions set status = 'scheduled', time_slot_id = ${slot.id}, venue_id = ${slot.venue_id}
          where id = ${session.id} and event_id = ${eventId}
        `
        applied.push(session.id)
      }
      const [event] = await tx<{ name: string }[]>`select name from events where id = ${eventId}`
      await notifyPlacement(tx, {
        eventId,
        eventSlug: ctx.event.slug,
        eventName: event.name,
        sessions: applied.map((id) => ({ id, title: sessionById.get(id)!.title })),
        kind: 'scheduled',
      })
      return { invalid: false as const, applied, skipped }
    })

    if (outcome.invalid) return fail(400, 'Some assignments refer to sessions or slots outside this event', { field: 'assignments' })
    return json({
      success: true,
      applied: outcome.applied.length,
      appliedIds: outcome.applied,
      skipped: outcome.skipped,
      total: assignments.length,
      message: `Applied ${outcome.applied.length} of ${assignments.length} assignments`,
    })
  } catch (e) {
    return errorResponse(e, 'auto-schedule apply')
  }
}
