import { resolvePublicEvent } from '@/lib/api/auth'
import { badRequest, methodNotAllowed, parseIncludes } from '@/lib/api/response'
import { DAY_REGEX, publicJson, publishedTimeSlots } from '../schedule/public-read'

/**
 * GET /api/v1/timeslots?event=<slug>[&day=YYYY-MM-DD][&include=venue] — time slots of the
 * gathering's published slot grids (`schellingpoint.draft.slotGrid`). Public; no key.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const includes = parseIncludes(request, ['venue'])
  if ('error' in includes) return includes.error
  const day = new URL(request.url).searchParams.get('day')
  if (day && !DAY_REGEX.test(day)) return badRequest('Invalid day format. Expected YYYY-MM-DD.')

  const resolved = await resolvePublicEvent(request)
  if ('error' in resolved) return resolved.error
  const slots = await publishedTimeSlots(resolved.event.id, { day, includeVenue: includes.includes.includes('venue') })
  return publicJson(slots, slots.length)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
