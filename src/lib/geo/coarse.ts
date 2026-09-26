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

/**
 * A postal address in parts, as the venue form collects it. Geocoding a street line on its own
 * matches whichever "Pearl Street" the geocoder happens to rank first, in any country; the city,
 * region and postal code are what pin it, so they always travel with the street (spec §8.2).
 */
export interface StructuredAddress {
  /** House number and street ("1500 Pearl St"). */
  street?: string | null
  /** City, town or village. */
  locality?: string | null
  /** State, province or region ("CO", "Colorado"). */
  region?: string | null
  postalCode?: string | null
  country?: string | null
}

const parts = (a: StructuredAddress): string[] =>
  [a.street, a.locality, a.region, a.postalCode, a.country]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter((p) => p !== '')

/**
 * The one-line address a person would write on an envelope, from the parts that are set.
 * This is what a "Get directions" link carries and what the geocode cache is keyed on.
 */
export function addressLine(address: StructuredAddress): string {
  return parts(address).join(', ')
}

/**
 * True when the address has something a geocoder could actually place: a street or a locality.
 *
 * A lone country or region is not an address — "US", or "Colorado" with nothing else, geocodes to
 * the centroid of a country or a state, which as a room's pin is worse than no pin at all (and
 * spends a lookup to get there).
 */
export function hasAddress(address: StructuredAddress): boolean {
  return [address.street, address.locality].some((p) => typeof p === 'string' && p.trim() !== '')
}

/**
 * True when the address names a place, not just a street: a street line with no city, region or
 * postal code is ambiguous and must not be geocoded on its own.
 */
export function addressIsPlaced(address: StructuredAddress): boolean {
  return [address.locality, address.region, address.postalCode].some((p) => typeof p === 'string' && p.trim() !== '')
}

/**
 * Nominatim query parameters for one lookup (pure, so it can be tested without the network).
 *
 * A `StructuredAddress` becomes Nominatim's *structured* form — `street`, `city`, `state`,
 * `postalcode`, `country` — which may not be mixed with `q`: that is what keeps "1500 Pearl St,
 * Boulder, CO" out of Falls Church. Free text (an address somebody typed) stays a `q` search.
 * Callers add `format` and `limit`.
 */
export function geocodeParams(input: string | StructuredAddress): URLSearchParams {
  const p = new URLSearchParams()
  if (typeof input === 'string') {
    p.set('q', normalizeQuery(input))
    return p
  }
  const set = (key: string, value: string | null | undefined) => {
    const v = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 200) : ''
    if (v) p.set(key, v)
  }
  set('street', input.street)
  set('city', input.locality)
  set('state', input.region)
  set('postalcode', input.postalCode)
  set('country', input.country)
  return p
}
