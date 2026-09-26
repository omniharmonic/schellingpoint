/**
 * Where the map opens (design §1.2). Pure: no I/O, no `server-only` — the resolver runs on the
 * server for a static preview and in the browser for the live map, and both must agree.
 *
 * `events.map` is the organizer's OVERRIDE, not the map area. When it is null the area is the
 * fitted bounds of every located room, padded by 15%, and a lone room opens at zoom 15.
 *
 * The derived view carries BOTH the padded `bounds` and a `zoom`, because its two kinds of consumer
 * need different things. A live map applies the bounds, so every located room is always on screen.
 * A preview that can only take a centre and a zoom (the proposal picker's `initialView`, a static
 * preview) uses the zoom — and that is where `min zoom 12` earns its keep: without a floor, one room
 * geocoded to the wrong continent would open those previews on the whole world. `MAP_MAX_ZOOM` is
 * the other side of the same coin, for rooms a few metres apart.
 */
import { isLatLng, type LatLng } from './coarse'
import type { MapView } from '@/components/map/types'

/** Fraction of the span added on every side of the fitted bounds. */
export const MAP_FIT_PADDING = 0.15
/** Never opens further out than this, however far apart the rooms are. */
export const MAP_MIN_ZOOM = 12
/** A single located room. */
export const MAP_SINGLE_ZOOM = 15
/** Never opens closer than this, however tightly the rooms cluster. */
export const MAP_MAX_ZOOM = 17

/**
 * The viewport the fitted zoom is computed for. The real container is measured by MapLibre when it
 * applies `bounds`; this nominal size only decides the `zoom` that travels beside them, so it has
 * to be a constant for the server and the browser to resolve the same view.
 */
const NOMINAL_VIEWPORT = { width: 800, height: 520 }
/** MapLibre's tile size. */
const TILE = 512

export type MapViewSource = 'override' | 'venues' | 'none'

export interface ResolvedMapView {
  /** The view to hand MapCanvas, or null when nothing places the map yet. */
  view: MapView | null
  source: MapViewSource
  /** How many rooms carry a point (what "Auto (fits N rooms)" counts). */
  located: number
}

/** Just the columns the resolver reads, so callers can pass admin rows or a read-model row. */
export interface LocatableVenue {
  latitude?: number | string | null
  longitude?: number | string | null
}

const num = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/** The rooms that carry a usable WGS84 point. */
export function locatedPoints(venues: readonly LocatableVenue[]): LatLng[] {
  const out: LatLng[] = []
  for (const v of venues) {
    const lat = num(v.latitude)
    const lng = num(v.longitude)
    if (lat !== null && lng !== null && isLatLng(lat, lng)) out.push({ lat, lng })
  }
  return out
}

/** Web Mercator y in [0, 1] (0 = north pole side). */
function mercatorY(lat: number): number {
  const clamped = Math.min(85.05112878, Math.max(-85.05112878, lat))
  const rad = (clamped * Math.PI) / 180
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + rad / 2)) / (2 * Math.PI)
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6

/** The zoom at which `bounds` fills the nominal viewport. */
export function zoomForBounds(bounds: [[number, number], [number, number]]): number {
  const [[west, south], [east, north]] = bounds
  const lngSpan = Math.max(Math.abs(east - west), 1e-6) / 360
  const latSpan = Math.max(Math.abs(mercatorY(south) - mercatorY(north)), 1e-6)
  const zx = Math.log2(NOMINAL_VIEWPORT.width / (TILE * lngSpan))
  const zy = Math.log2(NOMINAL_VIEWPORT.height / (TILE * latSpan))
  return Math.min(zx, zy)
}

/**
 * The map area for a gathering: the organizer's override when there is one, otherwise the fitted
 * bounds of its located rooms.
 */
export function resolveMapView(
  event: { map?: MapView | null } | null | undefined,
  venues: readonly LocatableVenue[] = [],
): ResolvedMapView {
  const points = locatedPoints(venues)
  if (event?.map) return { view: event.map, source: 'override', located: points.length }
  if (points.length === 0) return { view: null, source: 'none', located: 0 }
  if (points.length === 1) {
    const only = points[0]!
    return {
      view: { center: [round6(only.lng), round6(only.lat)], zoom: MAP_SINGLE_ZOOM },
      source: 'venues',
      located: 1,
    }
  }

  let west = Infinity
  let east = -Infinity
  let south = Infinity
  let north = -Infinity
  for (const p of points) {
    west = Math.min(west, p.lng)
    east = Math.max(east, p.lng)
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
  }
  // A 15% skirt on every side, and never a zero-size box (rooms at the same address).
  const padLng = Math.max((east - west) * MAP_FIT_PADDING, 0.0005)
  const padLat = Math.max((north - south) * MAP_FIT_PADDING, 0.0005)
  const bounds: [[number, number], [number, number]] = [
    [round6(Math.max(-180, west - padLng)), round6(Math.max(-90, south - padLat))],
    [round6(Math.min(180, east + padLng)), round6(Math.min(90, north + padLat))],
  ]
  const center: [number, number] = [round6((bounds[0][0] + bounds[1][0]) / 2), round6((bounds[0][1] + bounds[1][1]) / 2)]
  const zoom = Math.round(Math.min(MAP_MAX_ZOOM, Math.max(MAP_MIN_ZOOM, zoomForBounds(bounds))) * 100) / 100
  return { view: { center, zoom, bounds }, source: 'venues', located: points.length }
}

/** "Auto (fits 3 rooms)" / "Auto (no rooms placed yet)" for the editor. */
export function mapViewLabel(resolved: ResolvedMapView): string {
  if (resolved.source === 'override') return 'Saved view'
  if (resolved.located === 0) return 'Auto (no rooms placed yet)'
  return `Auto (fits ${resolved.located} room${resolved.located === 1 ? '' : 's'})`
}
