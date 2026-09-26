/**
 * Venues (rooms) of an event.
 *   GET  /api/v1/events/[slug]/admin/venues   rooms with slot and scheduled-session counts
 *   POST /api/v1/events/[slug]/admin/venues   create a room
 *
 * Writes run as the organizer's account so RLS applies; network records are refreshed after
 * commit when the gathering is already published (package F's `publishVenues`).
 */
import { after } from 'next/server'
import { asAccount, sql } from '@/lib/db'
import { errorResponse, json, readBody, requireOrganizer, rolesWith, rolesWithAny } from '@/lib/scheduling/admin-api'
import { parseVenue } from '@/lib/scheduling/inputs'
import { loadEvent, selectVenues, syncProgramRecords } from '@/lib/scheduling/program'
import { runVenueGeocode, shouldGeocodeOnSave } from '@/lib/geo/venue-geocode'
import { venueRow } from './_lib/row'

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
    // Design §1.1: a room saved with an address is placed on the map by the server, in `after()`.
    // Nobody presses "Place" per room any more; a hand-dropped pin is never overwritten.
    const locating = shouldGeocodeOnSave(input)
    const venue = await asAccount(ctx.viewer.accountId, async (tx) => {
      if (input.is_primary) {
        await tx`update venues set is_primary = false where event_id = ${ctx.event.id} and is_primary`
      }
      const row = { ...venueRow(tx, input), event_id: ctx.event.id, ...(locating ? { geocode_status: 'pending' } : {}) }
      const [created] = await tx<{ id: string }[]>`insert into venues ${tx(row)} returning id`
      const [listed] = await selectVenues(tx, ctx.event.id, created.id)
      return listed
    })
    const network = await syncProgramRecords('venues', await loadEvent(ctx.event.id), ctx.viewer.accountId)
    if (locating && venue) {
      after(() => runVenueGeocode({ eventId: ctx.event.id, venueId: venue.id, callerUserId: ctx.viewer.accountId }).catch(() => undefined))
    }
    return json({ venue, network }, { status: 201 })
  } catch (e) {
    return errorResponse(e, 'create venue')
  }
}
