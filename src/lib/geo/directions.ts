/**
 * A generic "Get directions" link (spec §8.4): `geo:` on Android/iOS, where the OS offers the
 * installed maps app, Google Maps directions elsewhere. Browser-only; no data leaves the device
 * except to the maps provider the person chooses.
 */
export interface DirectionsTarget {
  lat?: number | null
  lng?: number | null
  /** Free-text fallback (an address) when there is no point. */
  query?: string | null
}

function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent)
}

export function directionsHref(target: DirectionsTarget): string | null {
  const hasPoint = typeof target.lat === 'number' && typeof target.lng === 'number'
  const query = target.query?.trim() || null
  if (!hasPoint && !query) return null
  if (isMobile()) {
    if (hasPoint) {
      const label = query ? `(${encodeURIComponent(query)})` : ''
      return `geo:${target.lat},${target.lng}?q=${target.lat},${target.lng}${label}`
    }
    return `geo:0,0?q=${encodeURIComponent(query!)}`
  }
  const destination = hasPoint ? `${target.lat},${target.lng}` : encodeURIComponent(query!)
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}`
}
