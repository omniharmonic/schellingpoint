import 'server-only'
/**
 * Server side of the gathering map (design §1.2/§1.5): the resolved map area, the outlines members
 * see, and the gathering's centre that an image-only custom map is placed on.
 *
 * Nothing here is ever published. `events.map`, `events.custom_map` and `venues.outline` are
 * app-side columns; the privacy audit's `geo` check fails if any of them turns up in a record.
 */
import { sql, type Sql } from '@/lib/db'
import type { LatLng } from './coarse'
import { readCustomMap, type CustomMap } from './custom-map'
import { outlineCenter, outlineRing, type LngLat } from './outline'
import { resolveMapView, type ResolvedMapView } from './view'
import type { MapView } from '@/components/map/types'

export interface MapRoom {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
  is_private_residence: boolean
  outline: unknown
}

export interface EventMapData {
  /** `events.map`: the organizer's override, or null. */
  override: MapView | null
  customMap: CustomMap | null
  rooms: MapRoom[]
}

/** One row per room plus the two event columns the map needs. */
export async function loadEventMapData(eventId: string, db: Sql = sql): Promise<EventMapData> {
  const [event] = await db<{ map: unknown; custom_map: unknown }[]>`
    select map, custom_map from events where id = ${eventId}
  `
  const rooms = await db<MapRoom[]>`
    select id, name, latitude::float8 as latitude, longitude::float8 as longitude,
           coalesce(is_private_residence, false) as is_private_residence, outline
    from venues where event_id = ${eventId}
    order by coalesce(is_primary, false) desc, name
  `
  return {
    override: (event?.map as MapView | null) ?? null,
    customMap: readCustomMap(event?.custom_map),
    rooms,
  }
}

/**
 * The map area. A viewer without attendee-level access never contributes a private residence to
 * the fit: the padded box around a handful of rooms is coarse, but a lone home would still put the
 * map over that home.
 */
export function resolveFromRooms(data: EventMapData, opts: { includePrivate: boolean }): ResolvedMapView {
  const rooms = opts.includePrivate ? data.rooms : data.rooms.filter((r) => !r.is_private_residence)
  return resolveMapView({ map: data.override }, rooms)
}

/** An outline a member may see: a public room's ring with the room's name. */
export interface MapOutline {
  venue_id: string
  name: string
  ring: LngLat[]
  /** Where the name label sits. */
  center: LatLng
}

export function outlinesOf(data: EventMapData): MapOutline[] {
  const out: MapOutline[] = []
  for (const room of data.rooms) {
    if (room.is_private_residence) continue
    const ring = outlineRing(room.outline)
    if (!ring) continue
    out.push({ venue_id: room.id, name: room.name, ring, center: outlineCenter(ring) })
  }
  return out
}

/**
 * The gathering's PUBLISHABLE centre: the organizer's saved view when there is one, otherwise the
 * middle of its located PUBLIC rooms. Null when nothing public places the gathering.
 *
 * Private residences are excluded deliberately, and this is load-bearing rather than tidy. This
 * centre is what an image-only custom map publishes as a session's `public_geo` (§1.5), so a
 * gathering whose only located room is a home — its public room typed but not yet geocoded — would
 * otherwise write that home's ≈1 km cell into calendar records. The rule for a home's point is that
 * it never leaves the members boundary, in any form, so there is nothing to average it into: when
 * no public room is located there is no centre, and the custom-map route refuses image-only mode.
 */
export function gatheringCenter(data: EventMapData): LatLng | null {
  const view = resolveFromRooms(data, { includePrivate: false }).view
  if (!view) return null
  return { lat: view.center[1], lng: view.center[0] }
}

/**
 * The coarse point a self-hosted session should publish, given the gathering's map settings.
 * On an image-only custom map the pin is a position on a picture, so the gathering's public centre
 * (rounded to 2 decimals) is all that leaves; otherwise the pin's own rounded point.
 *
 * With no public centre nothing is published at all — never the pin, and never a private
 * residence's cell. The custom-map route will not save image-only mode in that state, so this is
 * the belt to its braces.
 */
export async function coarsePointForEvent(
  eventId: string,
  pin: LatLng | null,
  db: Sql = sql,
): Promise<LatLng | null> {
  const [row] = await db<{ custom_map: unknown }[]>`select custom_map from events where id = ${eventId}`
  const customMap = readCustomMap(row?.custom_map)
  const { coarseSessionPoint, isImageOnly } = await import('./custom-map')
  if (!isImageOnly(customMap)) return coarseSessionPoint(pin)
  const data = await loadEventMapData(eventId, db)
  return coarseSessionPoint(pin, { customMap, gatheringCenter: gatheringCenter(data) })
}
