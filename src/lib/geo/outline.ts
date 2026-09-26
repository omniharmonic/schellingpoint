/**
 * Venue outlines (design §1.4): a GeoJSON Polygon drawn over a room so members can see which
 * building, courtyard or field it is. Pure — the browser draws with the same validator the route
 * enforces, so a shape the editor accepted is never refused on save.
 *
 * App-side only. An outline is a building footprint, which is exactly the precision the spec keeps
 * out of records (§8.1): it is never published, and a private residence may not have one at all
 * (the venues route answers 409, and migration 0036 refuses the row).
 *
 * The validation is deliberately shallow: a closed ring of between 3 and 64 distinct WGS84
 * vertices whose bounding box sits within 50 km of the room's own pin. Self-intersection is NOT
 * checked — a bow-tie draws as a bow-tie and harms nobody.
 */
import { isLatLng, type LatLng } from './coarse'

export const OUTLINE_MAX_VERTICES = 64
export const OUTLINE_MIN_VERTICES = 3
/** How far the outline's bounding box may sit from the room's pin. */
export const OUTLINE_MAX_KM = 50

/** A `[longitude, latitude]` pair, GeoJSON order. */
export type LngLat = [number, number]

/** The only GeoJSON we store: one closed exterior ring, no holes. */
export interface OutlinePolygon {
  type: 'Polygon'
  coordinates: [LngLat[]]
}

export class OutlineError extends Error {
  constructor(message: string, readonly field = 'outline') {
    super(message)
    this.name = 'OutlineError'
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** Great-circle distance in kilometres. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const R = 6371
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

function pair(value: unknown, index: number): LngLat {
  if (!Array.isArray(value) || value.length < 2) throw new OutlineError(`Vertex ${index + 1} must be a [longitude, latitude] pair`)
  const lng = typeof value[0] === 'string' ? Number(value[0]) : value[0]
  const lat = typeof value[1] === 'string' ? Number(value[1]) : value[1]
  if (!isLatLng(lat, lng)) throw new OutlineError(`Vertex ${index + 1} is not a point on Earth`)
  return [round6(lng as number), round6(lat as number)]
}

const same = (a: LngLat, b: LngLat) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9

/** The ring's bounding box as `[[west, south], [east, north]]`. */
export function outlineBbox(ring: readonly LngLat[]): [[number, number], [number, number]] {
  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const [lng, lat] of ring) {
    west = Math.min(west, lng)
    east = Math.max(east, lng)
    south = Math.min(south, lat)
    north = Math.max(north, lat)
  }
  return [
    [west, south],
    [east, north],
  ]
}

/** The centre of the ring's bounding box: where the outline's name label sits. */
export function outlineCenter(ring: readonly LngLat[]): LatLng {
  const [[west, south], [east, north]] = outlineBbox(ring)
  return { lat: round6((south + north) / 2), lng: round6((west + east) / 2) }
}

/** The ring of a stored outline, or null when the value is not one. */
export function outlineRing(value: unknown): LngLat[] | null {
  if (!value || typeof value !== 'object') return null
  const o = value as { type?: unknown; coordinates?: unknown }
  if (o.type !== 'Polygon' || !Array.isArray(o.coordinates)) return null
  const ring = o.coordinates[0]
  if (!Array.isArray(ring) || ring.length < 4) return null
  const out: LngLat[] = []
  for (const point of ring) {
    if (!Array.isArray(point) || point.length < 2) return null
    const lng = Number(point[0])
    const lat = Number(point[1])
    if (!isLatLng(lat, lng)) return null
    out.push([lng, lat])
  }
  return out
}

/**
 * Validate an outline from an untrusted body.
 *
 * `null` (or `undefined`) means "no outline". `pin` is the room's own point: without one there is
 * nothing to check the shape against, so the outline is refused — place the room first.
 */
export function parseOutline(value: unknown, pin: LatLng | null): OutlinePolygon | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || Array.isArray(value)) throw new OutlineError('An outline must be a GeoJSON Polygon')
  const o = value as { type?: unknown; coordinates?: unknown }
  if (o.type !== 'Polygon') throw new OutlineError('An outline must be a GeoJSON Polygon')
  if (!Array.isArray(o.coordinates) || o.coordinates.length !== 1) {
    throw new OutlineError('An outline must have exactly one ring (holes are not supported)')
  }
  const raw = o.coordinates[0]
  if (!Array.isArray(raw)) throw new OutlineError('An outline ring must be a list of [longitude, latitude] pairs')
  const ring = raw.map(pair)
  if (ring.length < 2) throw new OutlineError(`An outline needs at least ${OUTLINE_MIN_VERTICES} corners`)
  if (!same(ring[0]!, ring[ring.length - 1]!)) throw new OutlineError('An outline ring must be closed: the last corner repeats the first')
  const vertices = ring.length - 1
  if (vertices < OUTLINE_MIN_VERTICES) throw new OutlineError(`An outline needs at least ${OUTLINE_MIN_VERTICES} corners`)
  if (vertices > OUTLINE_MAX_VERTICES) throw new OutlineError(`An outline can have at most ${OUTLINE_MAX_VERTICES} corners`)
  if (!pin) throw new OutlineError('Place the room on the map before drawing its outline')

  const [[west, south], [east, north]] = outlineBbox(ring)
  const corners: LatLng[] = [
    { lat: south, lng: west },
    { lat: south, lng: east },
    { lat: north, lng: west },
    { lat: north, lng: east },
  ]
  if (corners.some((c) => distanceKm(pin, c) > OUTLINE_MAX_KM)) {
    throw new OutlineError(`An outline must stay within ${OUTLINE_MAX_KM} km of the room’s pin`)
  }
  return { type: 'Polygon', coordinates: [ring] }
}
