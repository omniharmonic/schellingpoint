import 'server-only'
/**
 * Validation for organizer program inputs: venues, time slots and tracks.
 * Every parser returns only the columns a request may set; ids, event_id and network
 * bookkeeping (at_uri/at_cid) are never taken from the body.
 */
import { parseTimeInTimezone } from '@/lib/events/timezone'
import {
  HEX_COLOR,
  InputError,
  SESSION_FORMATS,
  SKILL_URI,
  SLOT_TYPES,
  integer,
  slugify,
  stringList,
  text,
  uuidOrNull,
} from './admin-api'

export interface VenueInput {
  name: string
  slug: string
  capacity: number | null
  features: string[]
  style: string | null
  address: string | null
  locality: string | null
  region: string | null
  postal_code: string | null
  country: string | null
  is_private_residence: boolean
  notes: string | null
  is_primary: boolean
  /** Formats this room may host; empty = all (migration 0018). */
  allowed_formats: string[]
  /** Migration 0023: WGS84 point; published only for a public venue. Both or neither. */
  latitude: number | null
  longitude: number | null
  /** The address text the point was geocoded from (null when placed by hand). */
  geocoded_from: string | null
  geocoded_at: string | null
}

function coordinate(body: Record<string, unknown>, field: 'latitude' | 'longitude'): number | null {
  const raw = body[field]
  if (raw === undefined || raw === null || raw === '') return null
  const n = typeof raw === 'string' ? Number(raw) : raw
  const limit = field === 'latitude' ? 90 : 180
  if (typeof n !== 'number' || !Number.isFinite(n) || n < -limit || n > limit) {
    throw new InputError(`${field === 'latitude' ? 'Latitude' : 'Longitude'} must be a number between -${limit} and ${limit}`, field)
  }
  return Math.round(n * 1e6) / 1e6
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function bool(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const raw = body[field]
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'boolean') throw new InputError(`${field} must be true or false`, field)
  return raw
}

/** Full venue from a create body, or the merge of `current` with a partial update. */
export function parseVenue(body: Record<string, unknown>, current?: VenueInput): VenueInput {
  const has = (field: string) => current === undefined || Object.prototype.hasOwnProperty.call(body, field)
  const name = has('name') ? text(body, 'name', { required: true, max: 100, label: 'Name' })! : current!.name
  let slug = current?.slug ?? ''
  if (has('slug')) {
    const raw = text(body, 'slug', { max: 60, label: 'Slug' })
    slug = raw ? raw.toLowerCase() : slugify(name)
  } else if (!current) {
    slug = slugify(name)
  }
  if (!slug || !SLUG.test(slug)) throw new InputError('Slug may contain lowercase letters, numbers and single hyphens', 'slug')
  const country = has('country') ? text(body, 'country', { max: 2, label: 'Country' }) : current!.country
  if (country && !/^[A-Za-z]{2}$/.test(country)) throw new InputError('Country must be a two-letter code (for example US)', 'country')
  return {
    name,
    slug,
    capacity: has('capacity') ? integer(body, 'capacity', { min: 1, max: 100000, label: 'Capacity' }) : current!.capacity,
    features: has('features') ? (stringList(body, 'features', { maxItems: 20, maxLength: 40, label: 'Features' }) ?? []) : current!.features,
    style: has('style') ? text(body, 'style', { max: 40, label: 'Style' }) : current!.style,
    address: has('address') ? text(body, 'address', { max: 300, label: 'Address' }) : current!.address,
    locality: has('locality') ? text(body, 'locality', { max: 100, label: 'City or neighbourhood' }) : current!.locality,
    region: has('region') ? text(body, 'region', { max: 100, label: 'Region' }) : current!.region,
    postal_code: has('postal_code') ? text(body, 'postal_code', { max: 20, label: 'Postal code' }) : current!.postal_code,
    country: country ? country.toUpperCase() : null,
    is_private_residence: has('is_private_residence') ? bool(body, 'is_private_residence', false) : current!.is_private_residence,
    notes: has('notes') ? text(body, 'notes', { max: 1000, label: 'Notes' }) : current!.notes,
    is_primary: has('is_primary') ? bool(body, 'is_primary', false) : current!.is_primary,
    allowed_formats: has('allowed_formats') ? parseAllowedFormats(body) : current!.allowed_formats,
    ...parseVenuePoint(body, current),
  }
}

/** latitude/longitude/geocoded_from as a unit: a partial update merges over the current pin; the result must be a whole point or none. */
function parseVenuePoint(body: Record<string, unknown>, current?: VenueInput): Pick<VenueInput, 'latitude' | 'longitude' | 'geocoded_from' | 'geocoded_at'> {
  const has = (field: string) => current === undefined || Object.prototype.hasOwnProperty.call(body, field)
  if (!has('latitude') && !has('longitude') && !has('geocoded_from')) {
    return { latitude: current!.latitude, longitude: current!.longitude, geocoded_from: current!.geocoded_from, geocoded_at: current!.geocoded_at }
  }
  const latitude = has('latitude') ? coordinate(body, 'latitude') : current?.latitude ?? null
  const longitude = has('longitude') ? coordinate(body, 'longitude') : current?.longitude ?? null
  if ((latitude === null) !== (longitude === null)) throw new InputError('Give both a latitude and a longitude, or neither', 'latitude')
  const geocodedFrom = has('geocoded_from') ? text(body, 'geocoded_from', { max: 400, label: 'Geocoded from' }) : current?.geocoded_from ?? null
  const moved = latitude !== (current?.latitude ?? null) || longitude !== (current?.longitude ?? null)
  return {
    latitude,
    longitude,
    geocoded_from: latitude === null ? null : geocodedFrom,
    geocoded_at: latitude === null ? null : moved || !current?.geocoded_at ? new Date().toISOString() : current.geocoded_at,
  }
}

function parseAllowedFormats(body: Record<string, unknown>): string[] {
  const list = stringList(body, 'allowed_formats', { maxItems: SESSION_FORMATS.length, maxLength: 20, label: 'Allowed formats' }) ?? []
  const unknown = list.filter((f) => !(SESSION_FORMATS as readonly string[]).includes(f))
  if (unknown.length > 0) throw new InputError(`Allowed formats must be among ${SESSION_FORMATS.join(', ')}`, 'allowed_formats')
  return list
}

export interface EventWindow {
  timezone: string
  start_date: string
  end_date: string
}

export interface SlotInput {
  venue_id: string
  day_date: string
  start_time: string
  end_time: string
  label: string | null
  slot_type: (typeof SLOT_TYPES)[number]
  is_break: boolean
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * A slot from wall-clock times on an event day, in the event's timezone:
 * `{ venue_id, day_date: 'YYYY-MM-DD', start: 'HH:mm', end: 'HH:mm', label?, slot_type? }`.
 * The conversion to instants happens here, once, with the event's own timezone.
 */
export function parseSlot(body: Record<string, unknown>, event: EventWindow, fieldPrefix = ''): SlotInput {
  const venueId = uuidOrNull(body, 'venue_id', 'Room')
  if (!venueId) throw new InputError('Choose a room', `${fieldPrefix}venue_id`)
  const day = body.day_date
  if (typeof day !== 'string' || !DAY.test(day)) throw new InputError('Choose an event day', `${fieldPrefix}day_date`)
  if (day < event.start_date.slice(0, 10) || day > event.end_date.slice(0, 10)) {
    throw new InputError('That day is outside the event dates', `${fieldPrefix}day_date`)
  }
  const start = body.start
  const end = body.end
  if (typeof start !== 'string' || !CLOCK.test(start)) throw new InputError('Enter a start time (HH:MM)', `${fieldPrefix}start`)
  if (typeof end !== 'string' || !CLOCK.test(end)) throw new InputError('Enter an end time (HH:MM)', `${fieldPrefix}end`)
  if (end <= start) throw new InputError('The end time must be after the start time', `${fieldPrefix}end`)
  let startsAt: Date
  let endsAt: Date
  try {
    startsAt = parseTimeInTimezone(start, day, event.timezone)
    endsAt = parseTimeInTimezone(end, day, event.timezone)
  } catch (e) {
    throw new InputError(e instanceof Error ? e.message : 'Invalid time', `${fieldPrefix}start`)
  }
  const rawType = body.slot_type ?? (body.is_break === true ? 'break' : 'session')
  if (typeof rawType !== 'string' || !(SLOT_TYPES as readonly string[]).includes(rawType)) {
    throw new InputError(`Slot type must be one of ${SLOT_TYPES.join(', ')}`, `${fieldPrefix}slot_type`)
  }
  const slotType = rawType as SlotInput['slot_type']
  return {
    venue_id: venueId,
    day_date: day,
    start_time: startsAt.toISOString(),
    end_time: endsAt.toISOString(),
    label: text(body, 'label', { max: 80, label: 'Label' }),
    slot_type: slotType,
    is_break: slotType === 'break',
  }
}

export interface TrackInput {
  name: string
  slug: string
  description: string | null
  color: string | null
  is_active: boolean
  max_sessions: number | null
  skill_uris: string[]
}

export function parseTrack(body: Record<string, unknown>, current?: TrackInput): TrackInput {
  const has = (field: string) => current === undefined || Object.prototype.hasOwnProperty.call(body, field)
  const name = has('name') ? text(body, 'name', { required: true, max: 50, label: 'Name' })! : current!.name
  const color = has('color') ? text(body, 'color', { max: 7, label: 'Color' }) : current!.color
  if (color && !HEX_COLOR.test(color)) throw new InputError('Color must be a hex value like #3b82f6', 'color')
  const slug = has('name') ? slugify(name) : current!.slug
  if (!slug) throw new InputError('Name must contain letters or numbers', 'name')
  return {
    name,
    slug,
    description: has('description') ? text(body, 'description', { max: 200, label: 'Description' }) : current!.description,
    color: color ? color.toLowerCase() : null,
    is_active: has('is_active') ? bool(body, 'is_active', true) : current!.is_active,
    max_sessions: has('max_sessions') ? integer(body, 'max_sessions', { min: 1, max: 1000, label: 'Session limit' }) : current!.max_sessions,
    skill_uris: has('skill_uris')
      ? (stringList(body, 'skill_uris', { maxItems: 20, maxLength: 600, label: 'Skills', pattern: SKILL_URI }) ?? [])
      : current!.skill_uris,
  }
}
