import 'server-only'
/**
 * Geocode a room when its address is saved (design §1.1).
 *
 * Organizers used to type an address and see nothing on the map until they pressed "Place" for
 * every room. Saving a room now schedules the lookup itself, in `after()`, through the same
 * rate-limited and cached `geocode()` the editor uses — with the address in parts, so the city and
 * region constrain the match instead of ranking it.
 *
 * Two rules the lookup never breaks:
 *   - a hand-dropped pin (`geocoded_from` null, `latitude` set) is never overwritten. The organizer
 *     placed it; the geocoder does not get a second opinion.
 *   - a private residence is geocoded like any other room. Its point is members-only either way and
 *     nothing changes in what is published (spec §8.1).
 *
 * `venues.geocode_status` is what the editor reads: `pending` while this runs, then `ok` or
 * `failed`; `manual` for a pin somebody placed themselves. No account quota is charged — nobody
 * pressed a button, and the 1 req/s pacing and 30-day cache still apply.
 */
import { sql, type Sql } from '@/lib/db'
import { addressLine, hasAddress } from './coarse'
import { geocode } from './geocode'
import { isHandPlaced, venueAddress } from './venue-address'

export {
  isHandPlaced,
  shouldGeocodeOnSave,
  venueAddress,
  type GeocodeStatus,
  type VenueAddressRow,
} from './venue-address'

interface RunArgs {
  eventId: string
  venueId: string
  /** Whose account the follow-up record refresh runs as (the organizer who saved). */
  callerUserId?: string | null
}

/**
 * Do the lookup and write the result. Safe to call at any time: it re-reads the room, refuses to
 * touch a hand-placed pin, and leaves `geocode_status = 'failed'` when nothing matched so the
 * editor can say "Couldn't locate — place by hand".
 */
export async function runVenueGeocode({ eventId, venueId, callerUserId }: RunArgs, db: Sql = sql): Promise<void> {
  const [room] = await db<
    {
      address: string | null
      locality: string | null
      region: string | null
      postal_code: string | null
      country: string | null
      latitude: number | null
      geocoded_from: string | null
    }[]
  >`
    select address, locality, region, postal_code, country, latitude::float8 as latitude, geocoded_from
    from venues where id = ${venueId} and event_id = ${eventId}
  `
  if (!room) return
  if (isHandPlaced(room)) return
  const address = venueAddress(room)
  if (!hasAddress(address)) {
    await db`update venues set geocode_status = null where id = ${venueId} and event_id = ${eventId} and geocode_status = 'pending'`
    return
  }

  let point: { lat: number; lng: number } | null = null
  try {
    point = (await geocode(address, db)).result
  } catch (e) {
    console.warn('[venue-geocode] lookup failed:', e instanceof Error ? e.message : e)
    await db`
      update venues set geocode_status = 'failed'
      where id = ${venueId} and event_id = ${eventId} and geocode_status = 'pending'
    `
    return
  }

  if (!point) {
    await db`
      update venues set geocode_status = 'failed'
      where id = ${venueId} and event_id = ${eventId} and (latitude is null or geocoded_from is not null)
    `
    return
  }

  // The guard repeats the hand-placed rule: a pin dropped while the lookup was in flight wins.
  const written = await db<{ id: string }[]>`
    update venues
       set latitude = ${point.lat}, longitude = ${point.lng},
           geocoded_from = ${addressLine(address)}, geocoded_at = now(), geocode_status = 'ok'
     where id = ${venueId} and event_id = ${eventId}
       and (latitude is null or geocoded_from is not null)
    returning id
  `
  if (!written.length) return
  await refreshRoomRecords(eventId, venueId, callerUserId ?? null)
}

/**
 * A room's point travels in its venue record and in every published calendar event held there
 * (spec §8.1), so a background geocode refreshes both. Best effort: when it cannot, the Network
 * page's drift check already flags the room as `location-changed`.
 */
async function refreshRoomRecords(eventId: string, venueId: string, callerUserId: string | null): Promise<void> {
  if (!callerUserId) return
  try {
    const { loadEvent, syncProgramRecords } = await import('@/lib/scheduling/program')
    const event = await loadEvent(eventId)
    if (!event.actor_did || !event.atproto_published_at) return
    await syncProgramRecords('venues', event, callerUserId)
    const publish = await import('@/lib/atproto/publish')
    const ids = await publish.publishedSessionIdsInVenue(eventId, venueId)
    if (!ids.length) return
    await publish.refreshSessionEvents({ eventId, callerUserId, sessionIds: ids })
  } catch (e) {
    console.warn('[venue-geocode] record refresh after lookup failed:', e instanceof Error ? e.message : e)
  }
}
