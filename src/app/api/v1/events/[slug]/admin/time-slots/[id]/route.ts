/**
 * One time slot.
 *   GET    …/admin/time-slots/[id]                        the slot and the sessions placed in it
 *   PATCH  …/admin/time-slots/[id]   SlotBody + confirm_assigned?
 *   DELETE …/admin/time-slots/[id]?confirm=1
 *
 * Changing or removing a slot that holds sessions is refused with 409 `SlotHasSessions`
 * (and the session list) until the organizer confirms. When a session in the slot is already
 * published on the network, the change is refused outright (409 `PublishedSessions`): its
 * calendar event would move, and moving a published session needs approvals (spec §6).
 */
import { asAccount, sql } from '@/lib/db'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith, rolesWithAny } from '@/lib/scheduling/admin-api'
import { parseSlot } from '@/lib/scheduling/inputs'
import { loadEvent, notifyPlacement, selectTimeSlots, syncProgramRecords } from '@/lib/scheduling/program'
import { assertNoOverlap } from '@/lib/scheduling/slots'

export const dynamic = 'force-dynamic'

const READ_ROLES = rolesWithAny('manageVenues', 'manageSchedule', 'approveProposals')
const WRITE_ROLES = rolesWith('manageVenues')

type Params = { params: Promise<{ slug: string; id: string }> }

const PUBLISHED_MESSAGE =
  'A session in this slot is already published on the network. Move it in the schedule builder (which asks for approvals) before changing the slot.'

export async function GET(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, READ_ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Time slot not found')
  try {
    const [slot] = await selectTimeSlots(sql, ctx.event.id, [id])
    return slot ? json({ timeSlot: slot }) : fail(404, 'Time slot not found')
  } catch (e) {
    return errorResponse(e, 'get time slot')
  }
}

export async function PATCH(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, WRITE_ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Time slot not found')
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    const event = await loadEvent(ctx.event.id)
    const input = parseSlot(body, event)
    const confirmed = body.confirm_assigned === true

    const outcome = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [current] = await tx<{ venue_id: string | null; start_time: string; end_time: string }[]>`
        select venue_id, start_time, end_time from time_slots where id = ${id} and event_id = ${ctx.event.id} for update
      `
      if (!current) return { kind: 'missing' as const }
      const moves =
        current.venue_id !== input.venue_id ||
        Date.parse(current.start_time) !== Date.parse(input.start_time) ||
        Date.parse(current.end_time) !== Date.parse(input.end_time)
      const sessions = await tx<{ id: string; title: string; network_published: boolean }[]>`
        select id, title, (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null) as network_published
        from sessions where event_id = ${ctx.event.id} and time_slot_id = ${id}
        for update
      `
      // A break cannot hold sessions: turning a slot into one unschedules them.
      const disrupts = moves || input.is_break
      if (disrupts && sessions.some((s) => s.network_published)) return { kind: 'published' as const, sessions }
      if (disrupts && sessions.length > 0 && !confirmed) return { kind: 'confirm' as const, sessions, toBreak: input.is_break }
      await assertNoOverlap(tx, ctx.event.id, [input], id)
      await tx`update time_slots set ${tx({ ...input })} where id = ${id} and event_id = ${ctx.event.id}`
      if (current.venue_id !== input.venue_id && sessions.length > 0) {
        await tx`update sessions set venue_id = ${input.venue_id} where event_id = ${ctx.event.id} and time_slot_id = ${id}`
      }
      if (input.is_break && sessions.length > 0) {
        await tx`
          update sessions set status = 'approved', venue_id = null, time_slot_id = null
          where event_id = ${ctx.event.id} and time_slot_id = ${id} and status = 'scheduled'
        `
      } else if (moves && sessions.length > 0) {
        await notifyPlacement(tx, {
          eventId: ctx.event.id,
          eventSlug: ctx.event.slug,
          eventName: event.name,
          sessions: sessions.map((s) => ({ id: s.id, title: s.title })),
          kind: 'rescheduled',
        })
      }
      const [updated] = await selectTimeSlots(tx, ctx.event.id, [id])
      return { kind: 'updated' as const, slot: updated }
    })

    if (outcome.kind === 'missing') return fail(404, 'Time slot not found')
    if (outcome.kind === 'published') {
      return fail(409, PUBLISHED_MESSAGE, { code: 'PublishedSessions', sessions: outcome.sessions })
    }
    if (outcome.kind === 'confirm') {
      const n = outcome.sessions.length
      const effect = outcome.toBreak ? `will be unscheduled (a break cannot hold sessions)` : 'will move with it'
      return fail(409, `${n} ${n === 1 ? 'session is' : 'sessions are'} scheduled in this slot and ${effect}. Confirm to save.`, {
        code: 'SlotHasSessions',
        sessions: outcome.sessions,
      })
    }
    const network = await syncProgramRecords('slot-grids', event, ctx.viewer.accountId)
    return json({ timeSlot: outcome.slot, network })
  } catch (e) {
    return errorResponse(e, 'update time slot')
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, WRITE_ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Time slot not found')
  const confirmed = new URL(request.url).searchParams.get('confirm') === '1'

  try {
    const outcome = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [slot] = await tx<{ id: string }[]>`
        select id from time_slots where id = ${id} and event_id = ${ctx.event.id} for update
      `
      if (!slot) return { kind: 'missing' as const }
      const sessions = await tx<{ id: string; title: string; network_published: boolean }[]>`
        select id, title, (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null) as network_published
        from sessions where event_id = ${ctx.event.id} and time_slot_id = ${id}
        for update
      `
      if (sessions.some((s) => s.network_published)) return { kind: 'published' as const, sessions }
      if (sessions.length > 0 && !confirmed) return { kind: 'confirm' as const, sessions }
      if (sessions.length > 0) {
        await tx`
          update sessions set status = case when status = 'scheduled' then 'approved' else status end,
                              venue_id = null, time_slot_id = null
          where event_id = ${ctx.event.id} and time_slot_id = ${id}
        `
      }
      await tx`delete from time_slots where id = ${id} and event_id = ${ctx.event.id}`
      return { kind: 'deleted' as const, unscheduled: sessions.length }
    })

    if (outcome.kind === 'missing') return fail(404, 'Time slot not found')
    if (outcome.kind === 'published') {
      return fail(409, PUBLISHED_MESSAGE, { code: 'PublishedSessions', sessions: outcome.sessions })
    }
    if (outcome.kind === 'confirm') {
      const n = outcome.sessions.length
      return fail(409, `${n} ${n === 1 ? 'session is' : 'sessions are'} scheduled in this slot and will lose ${n === 1 ? 'its' : 'their'} time. Confirm to remove it.`, {
        code: 'SlotHasSessions',
        sessions: outcome.sessions,
      })
    }
    const network = await syncProgramRecords('slot-grids', await loadEvent(ctx.event.id), ctx.viewer.accountId)
    return json({ deleted: true, unscheduled: outcome.unscheduled, network })
  } catch (e) {
    return errorResponse(e, 'delete time slot')
  }
}
