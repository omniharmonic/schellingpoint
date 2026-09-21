/**
 * Organizer-side edits to one session's scheduling constraints.
 *   PATCH /api/v1/events/[slug]/admin/sessions/[id]   { pinned_venue_id: uuid | null }
 *
 * "Pin to room" (PRD §4.7 step 4, migration 0018): the auto-scheduler and the quality check
 * treat a pinned session as a hard constraint. The pin is organizer-side curation, so it lives
 * on the app row only; the host-facing session PATCH (`/api/v1/sessions/[id]`) never accepts
 * it. A pinned room must belong to this gathering; `null` clears the pin.
 */
import { asAccount } from '@/lib/db'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith, uuidOrNull } from '@/lib/scheduling/admin-api'
import { listAdminSessions } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')

type Params = { params: Promise<{ slug: string; id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Session not found')
  const body = await readBody(request)
  if (body instanceof Response) return body
  if (!('pinned_venue_id' in body)) return fail(400, 'Nothing to change', { field: 'pinned_venue_id' })
  const eventId = ctx.event.id

  try {
    const pinnedVenueId = uuidOrNull(body, 'pinned_venue_id', 'Room')
    const outcome = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [session] = await tx<{ id: string }[]>`
        select id from sessions where id = ${id} and event_id = ${eventId} for update
      `
      if (!session) return { kind: 'missing' as const }
      if (pinnedVenueId) {
        const [venue] = await tx<{ id: string }[]>`
          select id from venues where id = ${pinnedVenueId} and event_id = ${eventId}
        `
        if (!venue) return { kind: 'foreign-room' as const }
      }
      await tx`update sessions set pinned_venue_id = ${pinnedVenueId} where id = ${id} and event_id = ${eventId}`
      const [updated] = await listAdminSessions(eventId, tx, [id])
      return { kind: 'updated' as const, session: updated ?? null }
    })
    if (outcome.kind === 'missing') return fail(404, 'Session not found')
    if (outcome.kind === 'foreign-room') return fail(400, 'That room is not part of this gathering', { field: 'pinned_venue_id' })
    return json({ session: outcome.session })
  } catch (e) {
    return errorResponse(e, 'pin session to room')
  }
}
