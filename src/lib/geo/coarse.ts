/**
 * Pure geo helpers (no I/O, no `server-only`) shared by records, the read model, the privacy
 * audit and the browser.
 */

export interface LatLng {
  lat: number
  lng: number
}

/** True for a finite WGS84 pair. */
export function isLatLng(lat: unknown, lng: unknown): lat is number {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/**
 * The coarse public point for an exact location: rounded to 2 decimals (≈ 1.1 km of latitude).
 * This is the only geo a non-member or a public record ever sees for a self-hosted session.
 */
export function roundCoarse(lat: number, lng: number): LatLng {
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 }
}

/** Both coordinates within `epsilon` degrees. */
export function nearPoint(a: LatLng, b: LatLng, epsilon = 0.005): boolean {
  return Math.abs(a.lat - b.lat) <= epsilon && Math.abs(a.lng - b.lng) <= epsilon
}

/** Parse a `{lat,lng}` object (a jsonb `public_geo`) into a LatLng, or null. */
export function parseLatLng(value: unknown): LatLng | null {
  if (!value || typeof value !== 'object') return null
  const o = value as Record<string, unknown>
  const lat = typeof o.lat === 'string' ? Number(o.lat) : o.lat
  const lng = typeof o.lng === 'string' ? Number(o.lng) : o.lng
  return isLatLng(lat, lng) ? { lat: lat as number, lng: lng as number } : null
}

/** Normalize a free-text geocoder query the way the cache keys it. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 400)
}
