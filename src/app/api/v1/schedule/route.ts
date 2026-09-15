import { resolvePublicEvent } from '@/lib/api/auth'
import { badRequest, methodNotAllowed } from '@/lib/api/response'
import { DAY_REGEX, publicJson, publishedSessions, publishedTimeSlots, type PublicSession, type PublicTimeSlot } from './public-read'

/**
 * GET /api/v1/schedule?event=<slug>[&day=YYYY-MM-DD] — the gathering's published schedule,
 * grouped by day. Public; no key; `Cache-Control: public, max-age=60`.
 *
 *   { data: { gathering: { slug, name, did, uri },
 *             days: [{ day, slots: [{ ...slot, sessions: PublicSession[] }] }],
 *             unslotted: PublicSession[] } }
 *
 * Only records the gathering actor has written: slots of published slot grids and sessions with
 * a calendar event. A published session whose slot's grid is not published still appears in its
 * slot (its calendar event carries the time anyway); self-hosted sessions without a slot are
 * listed under `unslotted`. See ./public-read.ts for what is never served.
 */
export const dynamic = 'force-dynamic'

type ScheduleSlot = Omit<PublicTimeSlot, 'grid_uri'> & { grid_uri: string | null; sessions: PublicSession[] }

export async function GET(request: Request) {
  const day = new URL(request.url).searchParams.get('day')
  if (day && !DAY_REGEX.test(day)) return badRequest('Invalid day format. Expected YYYY-MM-DD.')

  const resolved = await resolvePublicEvent(request)
  if ('error' in resolved) return resolved.error
  const { event } = resolved

  const [slots, sessions] = await Promise.all([
    publishedTimeSlots(event.id, { day, includeVenue: true }),
    publishedSessions(event.id, { actorDid: event.actor_did, day }),
  ])

  const bySlot = new Map<string, ScheduleSlot>()
  for (const slot of slots) bySlot.set(slot.id, { ...slot, sessions: [] })

  const unslotted: PublicSession[] = []
  for (const session of sessions) {
    const slotId = session.time_slot_id
    if (!slotId) {
      unslotted.push(session)
      continue
    }
    let slot = bySlot.get(slotId)
    if (!slot) {
      // The session's calendar event is public even if its grid is not: show the slot's time only.
      slot = {
        id: slotId,
        start_time: session.start_time ?? '',
        end_time: session.end_time ?? '',
        label: null,
        is_break: false,
        day_date: session.start_time ? session.start_time.slice(0, 10) : null,
        slot_type: 'session',
        venue_id: session.venue?.id ?? null,
        grid_uri: null,
        venue: session.venue,
        sessions: [],
      }
      bySlot.set(slotId, slot)
    }
    slot.sessions.push(session)
  }

  const days = new Map<string, ScheduleSlot[]>()
  for (const slot of bySlot.values()) {
    const key = slot.day_date ?? slot.start_time.slice(0, 10)
    const list = days.get(key) ?? []
    list.push(slot)
    days.set(key, list)
  }

  const data = {
    gathering: { slug: event.slug, name: event.name, did: event.actor_did, uri: event.gathering_uri },
    days: [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([d, list]) => ({ day: d, slots: list.sort((x, y) => x.start_time.localeCompare(y.start_time)) })),
    unslotted,
  }
  return publicJson(data)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
