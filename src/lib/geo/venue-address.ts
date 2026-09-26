/**
 * Pure rules about a room's address and its pin (design §1.1), shared by the venues route, the
 * background lookup and the editor. No I/O, no `server-only`: the editor needs the same answers.
 */
import { hasAddress, type StructuredAddress } from './coarse'

export type GeocodeStatus = 'pending' | 'ok' | 'failed' | 'manual'

/** The address columns of a room, in the shape the geocoder wants. */
export interface VenueAddressRow {
  address?: string | null
  locality?: string | null
  region?: string | null
  postal_code?: string | null
  country?: string | null
}

export function venueAddress(row: VenueAddressRow): StructuredAddress {
  return {
    street: row.address ?? null,
    locality: row.locality ?? null,
    region: row.region ?? null,
    postalCode: row.postal_code ?? null,
    country: row.country ?? null,
  }
}

const ADDRESS_FIELDS = ['address', 'locality', 'region', 'postal_code', 'country'] as const

/**
 * True when a hand-placed pin is in the way: the organizer dropped it themselves
 * (`geocoded_from` is null), so a lookup never gets a second opinion.
 */
export function isHandPlaced(row: { latitude?: number | null; geocoded_from?: string | null }): boolean {
  return row.latitude !== null && row.latitude !== undefined && !row.geocoded_from
}

/**
 * Whether saving this room should schedule a lookup: it has an address to look up, the address
 * changed (or there is no pin yet), and no hand-dropped pin would be overwritten.
 */
export function shouldGeocodeOnSave(
  next: VenueAddressRow & { latitude?: number | null; geocoded_from?: string | null },
  current?: (VenueAddressRow & { latitude?: number | null; geocoded_from?: string | null }) | null,
): boolean {
  if (!hasAddress(venueAddress(next))) return false
  if (isHandPlaced(next)) return false
  const addressChanged = !current || ADDRESS_FIELDS.some((f) => (next[f] ?? null) !== (current[f] ?? null))
  const unplaced = next.latitude === null || next.latitude === undefined
  return addressChanged || unplaced
}
