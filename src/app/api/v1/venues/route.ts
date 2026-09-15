import { resolvePublicEvent } from '@/lib/api/auth'
import { methodNotAllowed } from '@/lib/api/response'
import { publicJson, publishedVenues } from '../schedule/public-read'

/**
 * GET /api/v1/venues?event=<slug> — the gathering's published venues
 * (`schellingpoint.draft.venue` records). Public; no key. Addresses are coarsened to locality,
 * region and country; organizer notes are not served.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const resolved = await resolvePublicEvent(request)
  if ('error' in resolved) return resolved.error
  const venues = await publishedVenues(resolved.event.id)
  return publicJson(venues, venues.length)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
