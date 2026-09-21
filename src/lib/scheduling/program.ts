import 'server-only'
/**
 * Program data for the organizer admin (work package D): event details, the admin
 * session list, and after-commit network syncs through the gathering actor (package F).
 *
 * Nothing here returns a vote count. Results are added by callers only after the round
 * has closed, through `organizerResults` (package C), which throws while voting is open.
 */
import { sql, type Sql } from '@/lib/db'

export interface AdminEvent {
  id: string
  slug: string
  name: string
  status: string
  visibility: string
  timezone: string
  start_date: string
  end_date: string
  location_name: string | null
  logo_url: string | null
  actor_did: string | null
  atproto_published_at: string | null
  schedule_published_at: string | null
  last_schedule_change_at: string | null
}

export async function loadEvent(eventId: string, db: Sql = sql): Promise<AdminEvent> {
  const [event] = await db<AdminEvent[]>`
    select id, slug, name, status, visibility, timezone, start_date, end_date, location_name, logo_url,
           actor_did, atproto_published_at, schedule_published_at, last_schedule_change_at
    from events where id = ${eventId}
  `
  if (!event) throw new Error(`event ${eventId} disappeared`)
  return event
}

/** A session whose calendar event is on the network and not cancelled: moving or unscheduling it is destructive. */
export function isNetworkPublished(session: { calendar_event_uri: string | null; slot_uri: string | null; cancelled_at: string | null }): boolean {
  return Boolean(session.calendar_event_uri && session.slot_uri) && !session.cancelled_at
}

export type SessionStatus = 'pending' | 'approved' | 'rejected' | 'scheduled'

export interface AdminSessionRow {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  status: SessionStatus
  host_id: string | null
  /** The host account's own display name (self-written); null for host-less sessions. */
  host_display_name: string | null
  /** Organizer-typed name for a host-less session. Organizer-only, never published (R9). */
  listed_host_name: string | null
  topic_tags: string[] | null
  time_preferences: string[] | null
  track_id: string | null
  venue_id: string | null
  time_slot_id: string | null
  published_slot_id: string | null
  session_type: string | null
  is_votable: boolean | null
  expected_attendance: number | null
  required_features: string[] | null
  rejection_reason: string | null
  host_notified_at: string | null
  imported_from: string | null
  created_at: string
  cohost_count: number
  calendar_event_uri: string | null
  proposal_uri: string | null
  network_published: boolean
  proposal_drift_at: string | null
  proposal_withdrawn_at: string | null
  /** The proposer's repo is taken down / suspended / deactivated (migration 0011). */
  author_inactive_at: string | null
  cancelled_at: string | null
  venue: { id: string; name: string } | null
  time_slot: { id: string; label: string | null; start_time: string; end_time: string; day_date: string | null } | null
  track: { id: string; name: string; color: string | null } | null
}

/** Every session of the event, with the relations the admin screens render. */
export async function listAdminSessions(eventId: string, db: Sql = sql, sessionIds?: readonly string[]): Promise<AdminSessionRow[]> {
  const byIds = sessionIds ? db`and s.id in ${db(sessionIds as string[])}` : db``
  return db<AdminSessionRow[]>`
    select s.id, s.title, s.description, s.format, s.duration, s.status, s.host_id,
           case when s.host_id is not null then p.display_name end as host_display_name,
           l.host_name as listed_host_name,
           s.topic_tags, s.time_preferences, s.track_id, s.venue_id, s.time_slot_id, s.published_slot_id,
           s.session_type, s.is_votable, s.expected_attendance, s.required_features, s.rejection_reason,
           s.host_notified_at, s.imported_from, s.created_at,
           (select count(*)::int from session_cohosts c where c.session_id = s.id and c.cohost_inactive_at is null) as cohost_count,
           s.calendar_event_uri, s.proposal_uri,
           (s.calendar_event_uri is not null and s.slot_uri is not null and s.cancelled_at is null) as network_published,
           s.proposal_drift_at, s.proposal_withdrawn_at, s.author_inactive_at, s.cancelled_at,
           case when v.id is not null then json_build_object('id', v.id, 'name', v.name) end as venue,
           case when t.id is not null then json_build_object(
             'id', t.id, 'label', t.label, 'start_time', t.start_time, 'end_time', t.end_time, 'day_date', t.day_date
           ) end as time_slot,
           case when tr.id is not null then json_build_object('id', tr.id, 'name', tr.name, 'color', tr.color) end as track
    from sessions s
    left join profiles p on p.id = s.host_id
    left join session_host_listings l on l.session_id = s.id and l.event_id = s.event_id
    left join venues v on v.id = s.venue_id and v.event_id = s.event_id
    left join time_slots t on t.id = s.time_slot_id and t.event_id = s.event_id
    left join tracks tr on tr.id = s.track_id and tr.event_id = s.event_id
    where s.event_id = ${eventId} ${byIds}
      -- A pending proposal whose author's repo is taken down / deactivated leaves the review queue.
      and not (s.author_inactive_at is not null and s.status = 'pending')
    order by s.created_at desc
  `
}

/** Host plus accepted co-hosts of a session (account ids), for notifications. */
export async function sessionRecipients(db: Sql, sessionIds: readonly string[], eventId: string): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (sessionIds.length === 0) return out
  const rows = await db<{ session_id: string; user_id: string; is_host: boolean }[]>`
    select s.id as session_id, s.host_id as user_id, true as is_host
    from sessions s where s.event_id = ${eventId} and s.id in ${db(sessionIds as string[])} and s.host_id is not null
    union
    select c.session_id, c.user_id, false
    from session_cohosts c join sessions s on s.id = c.session_id
    where s.event_id = ${eventId} and c.session_id in ${db(sessionIds as string[])}
  `
  for (const row of rows) {
    const list = out.get(row.session_id) ?? []
    if (!list.includes(row.user_id)) list.push(row.user_id)
    out.set(row.session_id, list)
  }
  return out
}

export interface NetworkSyncResult {
  attempted: boolean
  results: Array<{ kind: string; id: string; uri?: string; error?: string }>
  error?: string
}

/**
 * After a committed change to venues, tracks or time slots, re-publish the gathering's
 * records of that kind — only when the gathering has an actor and has already been
 * published. Failures are reported, never thrown: the app-side change stands.
 */
export async function syncProgramRecords(
  kind: 'venues' | 'tracks' | 'slot-grids',
  event: Pick<AdminEvent, 'id' | 'actor_did' | 'atproto_published_at'>,
  callerUserId: string,
): Promise<NetworkSyncResult> {
  if (!event.actor_did || !event.atproto_published_at) return { attempted: false, results: [] }
  try {
    const publish = await import('@/lib/atproto/publish')
    const input = { eventId: event.id, callerUserId }
    const output =
      kind === 'venues' ? await publish.publishVenues(input)
        : kind === 'tracks' ? await publish.publishTracks(input)
          : await publish.publishSlotGrids(input)
    return {
      attempted: true,
      results: output.results.map((r) => ({ kind: r.kind, id: r.id, uri: r.uri, error: r.error })),
    }
  } catch (e) {
    console.error(`[admin] network sync (${kind}) failed:`, e instanceof Error ? e.message : e)
    return { attempted: true, results: [], error: 'The change is saved here, but the network copy could not be updated. Retry from the Network page.' }
  }
}

export interface AdminVenue {
  id: string
  name: string
  slug: string | null
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
  /** Formats this room may host; empty = all. */
  allowed_formats: string[]
  network_published: boolean
  slot_count: number
  scheduled_count: number
}

/** Rooms of an event (or one room), with slot and scheduled-session counts. */
export async function selectVenues(db: Sql, eventId: string, venueId?: string): Promise<AdminVenue[]> {
  const byId = venueId ? db`and v.id = ${venueId}` : db``
  return db<AdminVenue[]>`
    select v.id, v.name, v.slug, v.capacity, coalesce(v.features, '{}') as features, v.style, v.address,
           v.locality, v.region, v.postal_code, v.country, v.is_private_residence, v.notes,
           coalesce(v.is_primary, false) as is_primary, coalesce(v.allowed_formats, '{}') as allowed_formats,
           v.at_uri is not null as network_published,
           (select count(*)::int from time_slots t where t.venue_id = v.id and t.event_id = v.event_id) as slot_count,
           (select count(*)::int from sessions s
              where s.event_id = v.event_id and s.venue_id = v.id and s.status = 'scheduled') as scheduled_count
    from venues v
    where v.event_id = ${eventId} ${byId}
    order by coalesce(v.is_primary, false) desc, v.name
  `
}

export interface AdminTimeSlot {
  id: string
  venue_id: string | null
  day_date: string | null
  start_time: string
  end_time: string
  label: string | null
  slot_type: string | null
  is_break: boolean
  sessions: Array<{ id: string; title: string; network_published: boolean }>
}

/** Time slots of an event (or some of them), with the sessions currently placed in each. */
export async function selectTimeSlots(db: Sql, eventId: string, slotIds?: readonly string[]): Promise<AdminTimeSlot[]> {
  const byIds = slotIds ? db`and t.id in ${db(slotIds as string[])}` : db``
  return db<AdminTimeSlot[]>`
    select t.id, t.venue_id, t.day_date, t.start_time, t.end_time, t.label, t.slot_type,
           coalesce(t.is_break, false) as is_break,
           coalesce((
             select json_agg(json_build_object(
               'id', s.id, 'title', s.title,
               'network_published', s.calendar_event_uri is not null and s.slot_uri is not null and s.cancelled_at is null
             ) order by s.title)
             from sessions s where s.event_id = t.event_id and s.time_slot_id = t.id
           ), '[]'::json) as sessions
    from time_slots t
    where t.event_id = ${eventId} ${byIds}
    order by t.start_time, t.venue_id
  `
}

export interface AdminTrack {
  id: string
  name: string
  slug: string
  description: string | null
  color: string | null
  is_active: boolean
  display_order: number
  max_sessions: number | null
  skill_uris: string[]
  network_published: boolean
  session_count: number
}

export async function selectTracks(db: Sql, eventId: string, trackId?: string): Promise<AdminTrack[]> {
  const byId = trackId ? db`and tr.id = ${trackId}` : db``
  return db<AdminTrack[]>`
    select tr.id, tr.name, tr.slug, tr.description, tr.color, coalesce(tr.is_active, true) as is_active,
           coalesce(tr.display_order, 0) as display_order, tr.max_sessions, tr.skill_uris,
           tr.at_uri is not null as network_published,
           (select count(*)::int from sessions s where s.event_id = tr.event_id and s.track_id = tr.id) as session_count
    from tracks tr
    where tr.event_id = ${eventId} ${byId}
    order by coalesce(tr.display_order, 0), tr.name
  `
}

/** "February 13-15, 2026" / "February 28 - March 2, 2026" from event date columns. */
export function formatEventDateRange(startDate: string | null, endDate: string | null): string | undefined {
  if (!startDate || !endDate) return undefined
  const s = new Date(`${startDate.slice(0, 10)}T12:00:00Z`)
  const e = new Date(`${endDate.slice(0, 10)}T12:00:00Z`)
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  const year = s.getUTCFullYear()
  if (s.getTime() === e.getTime()) return `${month(s)} ${s.getUTCDate()}, ${year}`
  return month(s) === month(e)
    ? `${month(s)} ${s.getUTCDate()}-${e.getUTCDate()}, ${year}`
    : `${month(s)} ${s.getUTCDate()} - ${month(e)} ${e.getUTCDate()}, ${year}`
}

export interface ScheduledHostEmail {
  sessionId: string
  title: string
  to: string
  subject: string
  text: string
  html: string
}

/**
 * The "your session is scheduled" email for sessions on the PUBLISHED schedule that have a
 * host account with an email. Draft placements are never announced (spec §9: a draft
 * schedule is a set of decisions not yet made).
 */
export async function scheduledHostEmails(db: Sql, eventId: string, sessionIds?: readonly string[]): Promise<{
  emails: ScheduledHostEmail[]
  skipped: Array<{ sessionId: string; title: string; reason: string }>
}> {
  const { buildSessionScheduledEmail } = await import('@/lib/email/session-scheduled')
  const { appUrl } = await import('@/lib/email/base-template')
  const byIds = sessionIds ? db`and s.id in ${db(sessionIds as string[])}` : db``
  const rows = await db<{
    id: string; title: string; host_id: string | null; email: string | null; display_name: string | null
    venue_name: string | null; venue_address: string | null; start_time: string | null; end_time: string | null
    track_name: string | null; track_color: string | null; published: boolean
    event_name: string; event_slug: string; timezone: string; start_date: string; end_date: string; location_name: string | null
  }[]>`
    select s.id, s.title, s.host_id, a.email, p.display_name,
           v.name as venue_name, v.address as venue_address, t.start_time, t.end_time,
           tr.name as track_name, tr.color as track_color,
           (s.published_slot_id is not null and s.published_slot_id = s.time_slot_id) as published,
           e.name as event_name, e.slug as event_slug, e.timezone, e.start_date, e.end_date, e.location_name
    from sessions s
    join events e on e.id = s.event_id
    left join accounts a on a.id = s.host_id
    left join profiles p on p.id = s.host_id
    left join venues v on v.id = s.venue_id and v.event_id = s.event_id
    left join time_slots t on t.id = s.time_slot_id and t.event_id = s.event_id
    left join tracks tr on tr.id = s.track_id and tr.event_id = s.event_id
    where s.event_id = ${eventId} and s.status = 'scheduled' and s.host_notified_at is null ${byIds}
    order by t.start_time nulls last
  `
  const emails: ScheduledHostEmail[] = []
  const skipped: Array<{ sessionId: string; title: string; reason: string }> = []
  for (const r of rows) {
    if (!r.published) { skipped.push({ sessionId: r.id, title: r.title, reason: 'Not on the published schedule yet' }); continue }
    if (!r.host_id) { skipped.push({ sessionId: r.id, title: r.title, reason: 'No host account (listed speaker)' }); continue }
    if (!r.email) { skipped.push({ sessionId: r.id, title: r.title, reason: 'The host has no email address' }); continue }
    const start = r.start_time ? new Date(r.start_time) : null
    const end = r.end_time ? new Date(r.end_time) : null
    const tz = r.timezone || 'UTC'
    const time = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
    const zone = start ? start.toLocaleTimeString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop() : ''
    const content = buildSessionScheduledEmail({
      sessionTitle: r.title,
      hostName: r.display_name || 'there',
      venueName: r.venue_name || 'TBD',
      venueAddress: r.venue_address,
      dateString: start ? start.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz }) : 'TBD',
      timeString: start && end ? `${time(start)} – ${time(end)}${zone ? ` ${zone}` : ''}` : 'TBD',
      trackName: r.track_name,
      trackColor: r.track_color,
      sessionUrl: `${appUrl()}/e/${r.event_slug}/sessions/${r.id}`,
      eventName: r.event_name,
      eventDateRange: formatEventDateRange(r.start_date, r.end_date),
      eventLocation: r.location_name ?? undefined,
    })
    emails.push({ sessionId: r.id, title: r.title, to: r.email, subject: content.subject, text: content.text, html: content.html })
  }
  return { emails, skipped }
}

/**
 * Tell a session's host and co-hosts that a direct (not network-published) placement changed:
 * `session_scheduled` when it first gets a slot, `session_rescheduled` when its slot or room
 * changes. Published sessions move through package F's approval flow, which notifies itself.
 * Call inside the transaction that made the change.
 */
export async function notifyPlacement(
  db: Sql,
  input: { eventId: string; eventSlug: string; eventName: string; sessions: Array<{ id: string; title: string }>; kind: 'scheduled' | 'rescheduled' },
): Promise<number> {
  if (input.sessions.length === 0) return 0
  const { notify } = await import('@/lib/notifications')
  const recipients = await sessionRecipients(db, input.sessions.map((s) => s.id), input.eventId)
  let written = 0
  for (const session of input.sessions) {
    written += await notify(db, {
      eventId: input.eventId,
      userIds: recipients.get(session.id) ?? [],
      type: input.kind === 'scheduled' ? 'session_scheduled' : 'session_rescheduled',
      title: input.kind === 'scheduled' ? 'Your session has been scheduled' : 'Your session has a new time or room',
      body: input.kind === 'scheduled'
        ? `"${session.title}" now has a time and room at ${input.eventName}.`
        : `"${session.title}" moved to a different time or room at ${input.eventName}.`,
      actionUrl: `/e/${input.eventSlug}/sessions/${session.id}`,
      data: { session_id: session.id, session_title: session.title },
    })
  }
  return written
}
