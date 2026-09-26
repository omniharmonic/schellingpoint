/**
 * A generic "Get directions" link (spec §8.4): `geo:` on Android/iOS, where the OS offers the
 * installed maps app, Google Maps directions elsewhere. Browser-only; no data leaves the device
 * except to the maps provider the person chooses.
 *
 * The written address wins over coordinates whenever there is one. A room's pin is only ever as
 * good as the lookup that placed it — a street line geocoded without its city lands in the wrong
 * town — whereas the address is what the organizer actually typed, and every maps app resolves it
 * against the rider's own context. Coordinates are the fallback, for a self-hosted session whose
 * host dropped a pin and wrote no address.
 */
import { isLatLng } from './coarse'

export interface DirectionsTarget {
  lat?: number | null
  lng?: number | null
  /** The whole address, as written: street, city, region, postal code. Preferred over the point. */
  query?: string | null
}

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function directionsHref(target: DirectionsTarget): string | null {
  const hasPoint = isLatLng(target.lat, target.lng)
  const query = target.query?.trim().replace(/\s+/g, ' ') || null
  if (!hasPoint && !query) return null
  if (isMobile()) {
    // `geo:<point>?q=<address>`: the address is what the maps app searches for; the point is the
    // coordinate to fall back on, and 0,0 when there is none.
    const base = hasPoint ? `${target.lat},${target.lng}` : '0,0'
    if (query) return `geo:${base}?q=${encodeURIComponent(query)}`
    return `geo:${base}?q=${base}`
  }
  const destination = query ? encodeURIComponent(query) : `${target.lat},${target.lng}`
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}`
}
