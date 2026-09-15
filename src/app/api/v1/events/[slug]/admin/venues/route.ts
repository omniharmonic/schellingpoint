/**
 * Venues (rooms) of an event.
 *   GET  /api/v1/events/[slug]/admin/venues   rooms with slot and scheduled-session counts
 *   POST /api/v1/events/[slug]/admin/venues   create a room
 *
 * Writes run as the organizer's account so RLS applies; network records are refreshed after
 * commit when the gathering is already published (package F's `publishVenues`).
 */
import { asAccount, sql } from '@/lib/db'
import { errorResponse, json, readBody, requireOrganizer, rolesWith, rolesWithAny } from '@/lib/scheduling/admin-api'
import { parseVenue } from '@/lib/scheduling/inputs'
import { loadEvent, selectVenues, syncProgramRecords } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const READ_ROLES = rolesWithAny('manageVenues', 'manageSchedule', 'approveProposals')
const WRITE_ROLES = rolesWith('manageVenues')

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, READ_ROLES)
  if (ctx instanceof Response) return ctx
  try {
    return json({ venues: await selectVenues(sql, ctx.event.id) })
  } catch (e) {
    return errorResponse(e, 'list venues')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, WRITE_ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    const input = parseVenue(body)
    const venue = await asAccount(ctx.viewer.accountId, async (tx) => {
      if (input.is_primary) {
        await tx`update venues set is_primary = false where event_id = ${ctx.event.id} and is_primary`
      }
      const [row] = await tx<{ id: string }[]>`insert into venues ${tx({ ...input, event_id: ctx.event.id })} returning id`
      const [created] = await selectVenues(tx, ctx.event.id, row.id)
      return created
    })
    const network = await syncProgramRecords('venues', await loadEvent(ctx.event.id), ctx.viewer.accountId)
    return json({ venue, network }, { status: 201 })
  } catch (e) {
    return errorResponse(e, 'create venue')
  }
}
