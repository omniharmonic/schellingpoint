/**
 * One venue.
 *   PATCH  /api/v1/events/[slug]/admin/venues/[id]   partial update
 *   DELETE /api/v1/events/[slug]/admin/venues/[id]   remove the room and its time slots
 *
 * Deleting a room takes its time slots with it. Sessions scheduled there go back to
 * "approved" in the same transaction (never left "scheduled" without a slot). A session
 * whose calendar event is already on the network blocks the delete: moving or cancelling
 * it is destructive and goes through the schedule builder's approval flow.
 */
import { asAccount } from '@/lib/db'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { parseVenue, type VenueInput } from '@/lib/scheduling/inputs'
import { loadEvent, selectVenues, syncProgramRecords } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageVenues')

type Params = { params: Promise<{ slug: string; id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Room not found')
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    const venue = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [current] = await tx<VenueInput[]>`
        select name, slug, capacity, coalesce(features, '{}') as features, style, address, locality, region,
               postal_code, country, is_private_residence, notes, coalesce(is_primary, false) as is_primary
        from venues where id = ${id} and event_id = ${ctx.event.id}
        for update
      `
      if (!current) return null
      const next = parseVenue(body, current)
      if (next.is_primary && !current.is_primary) {
        await tx`update venues set is_primary = false where event_id = ${ctx.event.id} and is_primary and id <> ${id}`
      }
      await tx`update venues set ${tx(next)} where id = ${id} and event_id = ${ctx.event.id}`
      const [updated] = await selectVenues(tx, ctx.event.id, id)
      return updated
    })
    if (!venue) return fail(404, 'Room not found')
    const network = await syncProgramRecords('venues', await loadEvent(ctx.event.id), ctx.viewer.accountId)
    return json({ venue, network })
  } catch (e) {
    return errorResponse(e, 'update venue')
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Room not found')

  try {
    const outcome = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [venue] = await tx<{ id: string }[]>`
        select id from venues where id = ${id} and event_id = ${ctx.event.id} for update
      `
      if (!venue) return { kind: 'missing' as const }
      const affected = await tx<{ id: string; title: string; published: boolean }[]>`
        select s.id, s.title, (s.calendar_event_uri is not null and s.slot_uri is not null and s.cancelled_at is null) as published
        from sessions s
        where s.event_id = ${ctx.event.id}
          and (s.venue_id = ${id} or s.time_slot_id in (select t.id from time_slots t where t.venue_id = ${id} and t.event_id = ${ctx.event.id}))
        for update of s
      `
      const published = affected.filter((s) => s.published)
      if (published.length > 0) return { kind: 'published' as const, sessions: published }
      if (affected.length > 0) {
        await tx`
          update sessions set status = case when status = 'scheduled' then 'approved' else status end,
                              venue_id = null, time_slot_id = null
          where event_id = ${ctx.event.id} and id in ${tx(affected.map((s) => s.id))}
        `
      }
      await tx`delete from venues where id = ${id} and event_id = ${ctx.event.id}`
      return { kind: 'deleted' as const, unscheduled: affected.length }
    })

    if (outcome.kind === 'missing') return fail(404, 'Room not found')
    if (outcome.kind === 'published') {
      return fail(409, 'Sessions in this room are already published on the network. Move or cancel them in the schedule builder first.', {
        code: 'PublishedSessions',
        sessions: outcome.sessions.map((s) => ({ id: s.id, title: s.title })),
      })
    }
    const event = await loadEvent(ctx.event.id)
    const [venues, grids] = [
      await syncProgramRecords('venues', event, ctx.viewer.accountId),
      await syncProgramRecords('slot-grids', event, ctx.viewer.accountId),
    ]
    return json({ deleted: true, unscheduled: outcome.unscheduled, network: { venues, grids } })
  } catch (e) {
    return errorResponse(e, 'delete venue')
  }
}
