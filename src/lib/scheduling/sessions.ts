import 'server-only'
/**
 * Organizer-created sessions (single form and CSV import).
 *
 * R9 (spec §3, §11): an organizer never writes a session in someone else's name. A curated
 * session is host-less (`host_id` NULL, `sessions.host_name` NULL). When the organizer lists
 * an external speaker, the name goes to `session_host_listings` — organizer-only, rendered as
 * "listed as", never served by a public API and never put in a record (the gathering's stub
 * proposal carries no name).
 */
import type postgres from 'postgres'
import {
  InputError,
  SESSION_FORMATS,
  integer,
  stringList,
  text,
  uuidOrNull,
} from './admin-api'

export interface CuratedSessionInput {
  title: string
  description: string | null
  format: (typeof SESSION_FORMATS)[number]
  duration: number
  status: 'pending' | 'approved' | 'scheduled'
  track_id: string | null
  topic_tags: string[] | null
  listed_host_name: string | null
  time_slot_id: string | null
  expected_attendance: number | null
  required_features: string[]
}

const CREATE_STATUSES = ['pending', 'approved', 'scheduled'] as const

export function parseCuratedSession(body: Record<string, unknown>): CuratedSessionInput {
  const format = (body.format ?? 'talk') as string
  if (typeof format !== 'string' || !(SESSION_FORMATS as readonly string[]).includes(format)) {
    throw new InputError(`Format must be one of ${SESSION_FORMATS.join(', ')}`, 'format')
  }
  const status = (body.status ?? 'approved') as string
  if (!(CREATE_STATUSES as readonly string[]).includes(status)) {
    throw new InputError(`Status must be one of ${CREATE_STATUSES.join(', ')}`, 'status')
  }
  const timeSlotId = uuidOrNull(body, 'time_slot_id', 'Time slot')
  if (status === 'scheduled' && !timeSlotId) throw new InputError('Choose a time slot for a scheduled session', 'time_slot_id')
  return {
    title: text(body, 'title', { required: true, max: 200, label: 'Title' })!,
    description: text(body, 'description', { max: 5000, label: 'Description' }),
    format: format as CuratedSessionInput['format'],
    duration: integer(body, 'duration', { min: 5, max: 480, label: 'Duration' }) ?? 60,
    status: status as CuratedSessionInput['status'],
    track_id: uuidOrNull(body, 'track_id', 'Track'),
    topic_tags: stringList(body, 'topic_tags', { maxItems: 10, maxLength: 40, label: 'Tags' }),
    listed_host_name: text(body, 'host_name', { max: 200, label: 'Speaker name' }),
    time_slot_id: status === 'scheduled' ? timeSlotId : null,
    expected_attendance: integer(body, 'expected_attendance', { min: 1, max: 100000, label: 'Expected attendance' }),
    required_features: stringList(body, 'required_features', { maxItems: 20, maxLength: 40, label: 'Required features' }) ?? [],
  }
}

/**
 * Insert one curated session inside an organizer's `asAccount` transaction, so the proposal
 * trigger and RLS see the organizer. Returns the new session id.
 */
export async function insertCuratedSession(
  tx: postgres.TransactionSql,
  eventId: string,
  accountId: string,
  input: CuratedSessionInput,
  opts: { importedFrom?: string | null } = {},
): Promise<string> {
  if (input.track_id) {
    const [track] = await tx`select id from tracks where id = ${input.track_id} and event_id = ${eventId}`
    if (!track) throw new InputError('That track does not belong to this event', 'track_id')
  }
  let venueId: string | null = null
  if (input.time_slot_id) {
    const [slot] = await tx<{ id: string; venue_id: string | null; is_break: boolean | null }[]>`
      select id, venue_id, is_break from time_slots where id = ${input.time_slot_id} and event_id = ${eventId} for update
    `
    if (!slot) throw new InputError('That time slot does not belong to this event', 'time_slot_id')
    if (slot.is_break) throw new InputError('Sessions cannot be scheduled into a break', 'time_slot_id')
    if (!slot.venue_id) throw new InputError('That time slot has no room', 'time_slot_id')
    const [taken] = await tx`select id from sessions where event_id = ${eventId} and time_slot_id = ${slot.id} limit 1`
    if (taken) throw new InputError('That time slot already holds a session', 'time_slot_id', 409, 'SlotTaken')
    venueId = slot.venue_id
  }

  const [row] = await tx<{ id: string }[]>`
    insert into sessions ${tx({
      event_id: eventId,
      title: input.title,
      description: input.description,
      format: input.format,
      duration: input.duration,
      status: input.status,
      host_id: null,
      host_name: null,
      track_id: input.track_id,
      topic_tags: input.topic_tags,
      venue_id: venueId,
      time_slot_id: input.time_slot_id,
      session_type: 'curated',
      is_votable: input.status !== 'scheduled',
      expected_attendance: input.expected_attendance,
      required_features: input.required_features,
      imported_from: opts.importedFrom ?? null,
    })}
    returning id
  `
  if (input.listed_host_name) {
    await tx`
      insert into session_host_listings ${tx({
        session_id: row.id,
        event_id: eventId,
        host_name: input.listed_host_name,
        created_by: accountId,
      })}
    `
  }
  return row.id
}
