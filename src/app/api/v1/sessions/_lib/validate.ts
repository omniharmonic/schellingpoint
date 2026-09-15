import 'server-only'
/**
 * Body validation for proposal create/edit. Returns only the columns a request may carry;
 * the database remains the authority on who may change what (participation triggers,
 * RLS, `enforce_session_update_rules`).
 */

/**
 * Proposal CONTENT (spec §4.2): the offer as written in the proposer's own repository. On a
 * session with an author account only the author edits these; on a host-less session (the
 * gathering's stub) organizers do. Column names, after `skills` → `skill_uris`.
 */
export const CONTENT_COLUMNS = new Set<string>([
  'title', 'description', 'format', 'duration', 'topic_tags', 'skill_uris',
  'expected_attendance', 'required_features', 'is_self_hosted', 'custom_location', 'public_place',
  'self_hosted_start_time', 'self_hosted_end_time', 'time_preferences',
])

/** App-side curation: organizers (and the author, for the suggested track). Never rewrites a record. */
export const CURATION_COLUMNS = new Set<string>(['track_id'])

/** Attendee logistics kept app-side: the session's hosts, co-hosts and organizers. */
export const LOGISTICS_COLUMNS = new Set<string>(['telegram_group_url'])

/**
 * Fields that shape the proposer's `schellingpoint.draft.proposal` record. `custom_location` (the
 * exact place) is deliberately absent: it never reaches a record (spec §10); only the proposer's
 * coarse `public_place` label does.
 */
export const RECORD_FIELDS = new Set<string>([
  'title', 'description', 'format', 'duration', 'topic_tags', 'skill_uris', 'track_id',
  'expected_attendance', 'required_features', 'is_self_hosted', 'public_place',
  'self_hosted_start_time', 'self_hosted_end_time',
])

const FORMATS = ['talk', 'workshop', 'discussion', 'panel', 'demo', 'fireside', 'ceremony']
const STATUSES = ['pending', 'approved', 'rejected', 'scheduled']
const SESSION_TYPES = ['curated', 'proposed', 'workshop', 'track_reserved']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SKILL_URI = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/freeschool\.draft\.skill\/[A-Za-z0-9._~:-]{1,512}$/

export class FieldError extends Error {
  constructor(readonly field: string, message: string) {
    super(message)
  }
}

function graphemes(value: string): number {
  return [...value].length
}

function text(field: string, value: unknown, max: number, { required = false } = {}): string | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) {
    if (required) throw new FieldError(field, `${field.replace(/_/g, ' ')} is required`)
    return null
  }
  if (typeof value !== 'string') throw new FieldError(field, `${field} must be text`)
  const trimmed = value.trim()
  if (graphemes(trimmed) > max) throw new FieldError(field, `${field.replace(/_/g, ' ')} must be ${max} characters or fewer`)
  return trimmed
}

function stringList(field: string, value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (value === null || value === undefined) return null
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new FieldError(field, `${field} must be a list of text`)
  const items = [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))]
  if (items.length > maxItems) throw new FieldError(field, `At most ${maxItems} ${field.replace(/_/g, ' ')}`)
  if (items.some((v) => graphemes(v) > maxLength)) throw new FieldError(field, `Each ${field.replace(/_/g, ' ')} entry must be ${maxLength} characters or fewer`)
  return items.length ? items : null
}

function int(field: string, value: unknown, min: number, max: number): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new FieldError(field, `${field.replace(/_/g, ' ')} must be a whole number between ${min} and ${max}`)
  return n
}

function uuid(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !UUID.test(value)) throw new FieldError(field, `${field} must be an id`)
  return value
}

function instant(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new FieldError(field, `${field.replace(/_/g, ' ')} must be a date and time`)
  return new Date(value).toISOString()
}

function httpsUrl(field: string, value: unknown): string | null {
  const v = text(field, value, 500)
  if (!v) return null
  let url: URL
  try {
    url = new URL(v)
  } catch {
    throw new FieldError(field, 'Enter a full link starting with https://')
  }
  if (url.protocol !== 'https:') throw new FieldError(field, 'Enter a full link starting with https://')
  return url.toString()
}

function oneOf(field: string, value: unknown, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new FieldError(field, `${field.replace(/_/g, ' ')} must be one of: ${allowed.join(', ')}`)
  return value
}

/**
 * Parse the fields present in `body` (absent keys are left out, `null` clears).
 * `creating` makes title/format/duration required.
 */
export function parseSessionFields(body: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)

  if (creating || has('title')) out.title = text('title', body.title, 300, { required: true })
  if (has('description')) out.description = text('description', body.description, 3000)
  if (creating || has('format')) out.format = oneOf('format', body.format, FORMATS)
  if (creating || has('duration')) {
    const d = int('duration', body.duration, 5, 600)
    if (d === null) throw new FieldError('duration', 'duration is required')
    out.duration = d
  }
  if (has('topic_tags')) out.topic_tags = stringList('topic_tags', body.topic_tags, 10, 64)
  if (has('skills')) {
    const skills = stringList('skills', body.skills, 5, 1000) ?? []
    if (skills.some((s) => !SKILL_URI.test(s))) throw new FieldError('skills', 'Skills must come from the shared skill taxonomy')
    out.skill_uris = skills
  }
  if (has('track_id')) out.track_id = uuid('track_id', body.track_id)
  if (has('expected_attendance')) out.expected_attendance = int('expected_attendance', body.expected_attendance, 1, 10000)
  if (has('required_features')) out.required_features = stringList('required_features', body.required_features, 10, 64) ?? []
  if (has('is_self_hosted')) {
    if (typeof body.is_self_hosted !== 'boolean') throw new FieldError('is_self_hosted', 'is_self_hosted must be true or false')
    out.is_self_hosted = body.is_self_hosted
  }
  if (has('custom_location')) out.custom_location = text('custom_location', body.custom_location, 300)
  if (has('public_place')) out.public_place = text('public_place', body.public_place, 80)
  if (has('self_hosted_start_time')) out.self_hosted_start_time = instant('self_hosted_start_time', body.self_hosted_start_time)
  if (has('self_hosted_end_time')) out.self_hosted_end_time = instant('self_hosted_end_time', body.self_hosted_end_time)
  if (has('telegram_group_url')) out.telegram_group_url = httpsUrl('telegram_group_url', body.telegram_group_url)
  if (has('time_preferences')) out.time_preferences = stringList('time_preferences', body.time_preferences, 20, 40)

  if (out.self_hosted_start_time && out.self_hosted_end_time
    && Date.parse(out.self_hosted_end_time as string) <= Date.parse(out.self_hosted_start_time as string)) {
    throw new FieldError('self_hosted_end_time', 'The end time must be after the start time')
  }
  if (out.is_self_hosted === false) {
    // Leaving self-hosting clears the proposer's own place and time.
    out.custom_location = null
    out.public_place = null
    out.self_hosted_start_time = null
    out.self_hosted_end_time = null
  }

  // Organizer-only columns: validated for shape, authorized by the database.
  if (has('status')) out.status = oneOf('status', body.status, STATUSES)
  if (has('venue_id')) out.venue_id = uuid('venue_id', body.venue_id)
  if (has('time_slot_id')) out.time_slot_id = uuid('time_slot_id', body.time_slot_id)
  if (has('session_type')) out.session_type = oneOf('session_type', body.session_type, SESSION_TYPES)
  if (has('is_votable')) {
    if (typeof body.is_votable !== 'boolean') throw new FieldError('is_votable', 'is_votable must be true or false')
    out.is_votable = body.is_votable
  }
  if (has('rejection_reason')) out.rejection_reason = text('rejection_reason', body.rejection_reason, 2000)

  return out
}

export interface TimeWindow {
  startsAt: string
  endsAt: string
  preference?: 1 | 2 | 3
}

export interface TimePreferenceInput {
  windows: TimeWindow[]
  blackouts: TimeWindow[]
  publish: boolean
}

function windows(field: string, value: unknown): TimeWindow[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > 40) throw new FieldError(field, `${field} must be a list of at most 40 windows`)
  return value.map((w) => {
    if (!w || typeof w !== 'object') throw new FieldError(field, 'Each window needs a start and an end')
    const o = w as Record<string, unknown>
    const startsAt = instant(`${field}.startsAt`, o.startsAt)
    const endsAt = instant(`${field}.endsAt`, o.endsAt)
    if (!startsAt || !endsAt) throw new FieldError(field, 'Each window needs a start and an end')
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new FieldError(field, 'Each window must end after it starts')
    const pref = o.preference === undefined || o.preference === null ? undefined : int(`${field}.preference`, o.preference, 1, 3)
    return { startsAt, endsAt, ...(pref ? { preference: pref as 1 | 2 | 3 } : {}) }
  })
}

/** `time_preference: { windows, blackouts, publish }` — app-side unless `publish` (spec §4.2). */
export function parseTimePreference(value: unknown): TimePreferenceInput | null {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new FieldError('time_preference', 'time_preference must be an object')
  const o = value as Record<string, unknown>
  return {
    windows: windows('windows', o.windows),
    blackouts: windows('blackouts', o.blackouts),
    publish: o.publish === true,
  }
}
