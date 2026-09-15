import { sql } from '@/lib/db'
import { publicEventForRow } from '@/lib/api/auth'
import { badRequest, isValidUUID, methodNotAllowed, notFound, parseIncludes } from '@/lib/api/response'
import { publicJson, publishedTimeSlots, publishedVenues } from '../../schedule/public-read'

/**
 * GET /api/v1/venues/[id][?event=<slug>][&include=timeslots] — one published venue, optionally
 * with the time slots of its published slot grids.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return badRequest('Invalid venue ID format. Expected a UUID.')
  const includes = parseIncludes(request, ['timeslots'])
  if ('error' in includes) return includes.error

  const [row] = await sql<{ event_id: string }[]>`select event_id from venues where id = ${id}`
  const event = await publicEventForRow(request, row?.event_id)
  if (!event) return notFound('Venue')
  const [venue] = await publishedVenues(event.id, id)
  if (!venue) return notFound('Venue')

  if (includes.includes.includes('timeslots')) {
    const timeslots = await publishedTimeSlots(event.id, { venueId: id })
    return publicJson({ ...venue, timeslots })
  }
  return publicJson(venue)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
