/**
 * Schedule builder writes for one session.
 *   PUT    …/admin/sessions/[id]/schedule   { time_slot_id, replace?: boolean, reason?: string }
 *   DELETE …/admin/sessions/[id]/schedule   { reason?: string }   (or ?reason=)
 *
 * Sessions not yet on the network are placed and removed directly; the host and co-hosts hear
 * `session_scheduled` (first slot) or `session_rescheduled` (a different slot or room). A session whose calendar event is already on the network is different: moving
 * or unscheduling it is destructive (spec §6), so the request goes to package F's
 * `requestSessionMove` / `requestSessionCancel`, which applies it or answers
 * `awaiting_approval` until enough organizers approve. The app row changes only when the
 * move or cancellation is applied.
 */
import { after } from 'next/server'
import { asAccount } from '@/lib/db'
import {
  InputError,
  errorResponse,
  fail,
  isUuid,
  json,
  readBody,
  requireOrganizer,
  rolesWith,
  text,
} from '@/lib/scheduling/admin-api'
import { requestCancel, requestMove } from '@/lib/scheduling/destructive'
import { listAdminSessions, notifyPlacement } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')

type Params = { params: Promise<{ slug: string; id: string }> }

/**
 * Feed (design §7.3): after a destructive move/cancel was applied, make sure its post is claimed
 * (idempotent — `publish.ts` claims it when it writes the slot) and deliver after the response.
 * Never inside the transaction, never failing the request.
 */
async function feedAfterDestructive(eventId: string, kind: 'session-moved' | 'session-cancelled', sessionId: string, callerUserId: string): Promise<void> {
  try {
    const feed = await import('@/lib/atproto/feed')
    await feed.enqueueSessionPosts({ eventId, kind, sessionIds: [sessionId], callerUserId })
    after(() => feed.kickFeedDelivery(eventId))
  } catch (e) {
    console.warn('[schedule] feed post could not be queued:', e instanceof Error ? e.name : 'error')
  }
}

interface SessionState {
  id: string
  title: string
  status: string
  time_slot_id: string | null
  venue_id: string | null
  network_published: boolean
}

async function sessionView(eventId: string, sessionId: string) {
  const [session] = await listAdminSessions(eventId, undefined, [sessionId])
  return session ?? null
}

function requireReason(body: Record<string, unknown> | null, fallback: string | null): string {
  const reason = (body ? text(body, 'reason', { max: 2000, label: 'Reason' }) : null) ?? fallback
  if (!reason) {
    throw new InputError('This session is already published. Give a reason for the change; other organizers see it when approving.', 'reason', 400, 'ReasonRequired')
  }
  return reason
}

export async function PUT(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Session not found')
  const body = await readBody(request)
  if (body instanceof Response) return body
  const slotId = body.time_slot_id
  if (!isUuid(slotId)) return fail(400, 'Choose a time slot', { field: 'time_slot_id' })
  const replace = body.replace === true
  const eventId = ctx.event.id

  try {
    const plan = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [session] = await tx<SessionState[]>`
        select id, title, status, time_slot_id, venue_id,
               (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null) as network_published
        from sessions where id = ${id} and event_id = ${eventId} for update
      `
      if (!session) return { kind: 'missing' as const }
      if (session.status !== 'approved' && session.status !== 'scheduled') {
        throw new InputError(`Only approved sessions can be scheduled (this one is ${session.status})`, 'status', 409, 'NotApproved')
      }
      const [slot] = await tx<{ id: string; venue_id: string | null; is_break: boolean | null }[]>`
        select id, venue_id, is_break from time_slots where id = ${slotId} and event_id = ${eventId} for update
      `
      if (!slot) throw new InputError('That time slot does not belong to this event', 'time_slot_id', 404)
      if (slot.is_break) throw new InputError('Sessions cannot be scheduled into a break', 'time_slot_id')
      if (!slot.venue_id) throw new InputError('That time slot has no room', 'time_slot_id')
      if (session.time_slot_id === slot.id && session.status === 'scheduled') return { kind: 'unchanged' as const }

      const occupants = await tx<SessionState[]>`
        select id, title, status, time_slot_id, venue_id,
               (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null) as network_published
        from sessions where event_id = ${eventId} and time_slot_id = ${slot.id} and id <> ${id}
        for update
      `
      const occupant = occupants[0]
      if (occupant && (!replace || occupant.network_published)) {
        throw new InputError(
          occupant.network_published
            ? `"${occupant.title}" is published in that slot. Move or cancel it first.`
            : `"${occupant.title}" is already in that slot.`,
          'time_slot_id',
          409,
          'SlotTaken',
        )
      }

      if (session.network_published && session.time_slot_id) {
        // Destructive: leave the rows alone; package F applies the move once approved.
        return { kind: 'destructive' as const, session, slot: { id: slot.id, venue_id: slot.venue_id } }
      }

      if (occupant) {
        await tx`
          update sessions set status = 'approved', time_slot_id = null, venue_id = null
          where id = ${occupant.id} and event_id = ${eventId}
        `
      }
      await tx`
        update sessions set status = 'scheduled', time_slot_id = ${slot.id}, venue_id = ${slot.venue_id}
        where id = ${id} and event_id = ${eventId}
      `
      const [event] = await tx<{ name: string }[]>`select name from events where id = ${eventId}`
      await notifyPlacement(tx, {
        eventId,
        eventSlug: ctx.event.slug,
        eventName: event.name,
        sessions: [{ id: session.id, title: session.title }],
        kind: session.status === 'scheduled' && session.time_slot_id ? 'rescheduled' : 'scheduled',
      })
      return { kind: 'applied' as const, displaced: occupant ? { id: occupant.id, title: occupant.title } : null }
    })

    if (plan.kind === 'missing') return fail(404, 'Session not found')
    if (plan.kind === 'unchanged') return json({ status: 'applied', unchanged: true, session: await sessionView(eventId, id) })
    if (plan.kind === 'applied') {
      return json({ status: 'applied', displaced: plan.displaced, session: await sessionView(eventId, id) })
    }

    const reason = requireReason(body, null)
    const outcome = await requestMove({
      eventId,
      sessionId: id,
      callerUserId: ctx.viewer.accountId,
      reason,
      timeSlotId: plan.slot.id,
      venueId: plan.slot.venue_id!,
      confirmPublicLinkage: body.confirmPublicLinkage === true,
    })
    // Feed (design §7.3): a move approved and applied. `moveSession` already claimed the row when
    // it wrote the slot; this is idempotent and only kicks delivery after the response.
    if (outcome.status === 'applied') await feedAfterDestructive(eventId, 'session-moved', id, ctx.viewer.accountId)
    return json(
      { ...outcome, session: await sessionView(eventId, id) },
      { status: outcome.status === 'awaiting_approval' ? 202 : 200 },
    )
  } catch (e) {
    return errorResponse(e, 'schedule session')
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Session not found')
  let body: Record<string, unknown> | null = null
  if (request.headers.get('content-type')?.includes('application/json')) {
    const parsed = await readBody(request)
    if (parsed instanceof Response) return parsed
    body = parsed
  }
  const queryReason = new URL(request.url).searchParams.get('reason')?.trim().slice(0, 2000) || null
  const eventId = ctx.event.id

  try {
    const plan = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [session] = await tx<SessionState[]>`
        select id, title, status, time_slot_id, venue_id,
               (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null) as network_published
        from sessions where id = ${id} and event_id = ${eventId} for update
      `
      if (!session) return { kind: 'missing' as const }
      if (!session.time_slot_id && session.status !== 'scheduled') return { kind: 'unchanged' as const }
      if (session.network_published) return { kind: 'destructive' as const }
      await tx`
        update sessions set status = 'approved', time_slot_id = null, venue_id = null
        where id = ${id} and event_id = ${eventId}
      `
      return { kind: 'applied' as const }
    })

    if (plan.kind === 'missing') return fail(404, 'Session not found')
    if (plan.kind !== 'destructive') {
      return json({ status: 'applied', unchanged: plan.kind === 'unchanged', session: await sessionView(eventId, id) })
    }
    const reason = requireReason(body, queryReason)
    const outcome = await requestCancel({
      eventId,
      sessionId: id,
      callerUserId: ctx.viewer.accountId,
      reason,
      confirmPublicLinkage: body?.confirmPublicLinkage === true,
    })
    if (outcome.status === 'applied') await feedAfterDestructive(eventId, 'session-cancelled', id, ctx.viewer.accountId)
    return json(
      { ...outcome, session: await sessionView(eventId, id) },
      { status: outcome.status === 'awaiting_approval' ? 202 : 200 },
    )
  } catch (e) {
    return errorResponse(e, 'unschedule session')
  }
}
