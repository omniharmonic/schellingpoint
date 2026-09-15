import 'server-only'
/**
 * Public AppView reads (spec §2, §10): what a gathering has already published to the network,
 * served without a key for publicly readable gatherings. The replacement for the shared-key
 * partner API.
 *
 * "Published" means the gathering actor wrote the record: `tracks.at_uri`, `venues.at_uri`,
 * `at_slot_grids.uri`, `sessions.calendar_event_uri`. Nothing unpublished is served.
 *
 * Never served, whatever the table holds: emails, Telegram, ENS, account ids, the free-text
 * `host_name`, track leads (R9), vote counts (§5.3), RSVP-gated details (Telegram group, custom
 * location), organizer notes, or a venue's street address (coarsened to locality, §10). The only
 * DIDs in a response are the gathering's own and the DID of a proposer whose proposal record is
 * in their own repo (they wrote it; it is already public).
 */
import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'

/** No credentials are read, so any origin may fetch these. */
export const PUBLIC_CACHE = { 'Cache-Control': 'public, max-age=60', 'Access-Control-Allow-Origin': '*' } as const

export function publicJson(data: unknown, count?: number): NextResponse {
  return NextResponse.json(count === undefined ? { data } : { data, count }, { headers: PUBLIC_CACHE })
}

export interface PublicTrack {
  id: string
  uri: string
  name: string
  slug: string | null
  description: string | null
  color: string | null
  is_active: boolean | null
  display_order: number | null
  max_sessions: number | null
}

export async function publishedTracks(eventId: string, trackId?: string): Promise<PublicTrack[]> {
  return sql<PublicTrack[]>`
    select id, at_uri as uri, name, slug, description, color, is_active, display_order, max_sessions
    from tracks
    where event_id = ${eventId} and at_uri is not null
      ${trackId ? sql`and id = ${trackId}` : sql``}
    order by display_order nulls last, name
  `
}

export interface PublicVenue {
  id: string
  uri: string
  name: string
  slug: string | null
  capacity: number | null
  features: string[] | null
  style: string | null
  is_primary: boolean | null
  locality: string | null
  region: string | null
  country: string | null
}

export async function publishedVenues(eventId: string, venueId?: string): Promise<PublicVenue[]> {
  return sql<PublicVenue[]>`
    select id, at_uri as uri, name, slug, capacity, features, style, is_primary, locality, region, country
    from venues
    where event_id = ${eventId} and at_uri is not null
      ${venueId ? sql`and id = ${venueId}` : sql``}
    order by is_primary desc nulls last, name
  `
}

export interface PublicTimeSlot {
  id: string
  start_time: string
  end_time: string
  label: string | null
  is_break: boolean | null
  day_date: string | null
  slot_type: string | null
  venue_id: string | null
  grid_uri: string
  venue?: { id: string; name: string; slug: string | null } | null
}

/** Time slots belonging to a published slot grid (one grid per venue per day). */
export async function publishedTimeSlots(
  eventId: string,
  opts: { day?: string | null; venueId?: string | null; includeVenue?: boolean } = {},
): Promise<PublicTimeSlot[]> {
  const rows = await sql<(PublicTimeSlot & { v_id: string | null; v_name: string | null; v_slug: string | null })[]>`
    select t.id, t.start_time, t.end_time, t.label, t.is_break, t.day_date, t.slot_type,
           case when v.at_uri is not null then t.venue_id end as venue_id,
           g.uri as grid_uri,
           v.id as v_id, v.name as v_name, v.slug as v_slug
    from time_slots t
    join at_slot_grids g
      on g.event_id = t.event_id and g.day_date = t.day_date
     and g.venue_id is not distinct from t.venue_id and g.uri is not null
    left join venues v on v.id = t.venue_id and v.event_id = t.event_id and v.at_uri is not null
    where t.event_id = ${eventId}
      ${opts.day ? sql`and t.day_date = ${opts.day}` : sql``}
      ${opts.venueId ? sql`and t.venue_id = ${opts.venueId}` : sql``}
    order by t.start_time, v.name nulls first
  `
  return rows.map(({ v_id, v_name, v_slug, ...slot }) =>
    opts.includeVenue ? { ...slot, venue: v_id && v_name ? { id: v_id, name: v_name, slug: v_slug } : null } : slot,
  )
}

export interface PublicSession {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  session_type: string | null
  cancelled: boolean
  time_slot_id: string | null
  start_time: string | null
  end_time: string | null
  track: { id: string; name: string; color: string | null } | null
  venue: { id: string; name: string; slug: string | null } | null
  /** Present only when the proposal record is in the host's own repo. */
  host: { did: string; handle: string | null } | null
  uris: { calendar_event: string; slot: string | null; proposal: string | null }
}

interface SessionRow {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  session_type: string | null
  cancelled: boolean
  time_slot_id: string | null
  start_time: string | null
  end_time: string | null
  track_id: string | null
  track_name: string | null
  track_color: string | null
  venue_id: string | null
  venue_name: string | null
  venue_slug: string | null
  host_did: string | null
  host_handle: string | null
  proposal_uri: string | null
  calendar_event_uri: string
  slot_uri: string | null
}

/** Sessions whose calendar event the gathering actor has written. */
export async function publishedSessions(
  eventId: string,
  opts: { actorDid?: string | null; trackId?: string | null; day?: string | null } = {},
): Promise<PublicSession[]> {
  const actorDid = opts.actorDid ?? null
  const rows = await sql<SessionRow[]>`
    select s.id, s.title, s.description, s.format, s.duration, s.session_type,
           (s.cancelled_at is not null) as cancelled,
           s.time_slot_id,
           coalesce(ts.start_time, s.self_hosted_start_time) as start_time,
           coalesce(ts.end_time, s.self_hosted_end_time) as end_time,
           tr.id as track_id, tr.name as track_name, tr.color as track_color,
           v.id as venue_id, v.name as venue_name, v.slug as venue_slug,
           case when own.yes then s.host_did end as host_did,
           case when own.yes then a.handle end as host_handle,
           case when own.yes or (${actorDid}::text is not null and starts_with(s.proposal_uri, 'at://' || ${actorDid}::text || '/'))
                then s.proposal_uri end as proposal_uri,
           s.calendar_event_uri, s.slot_uri
    from sessions s
    left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
    left join tracks tr on tr.id = s.track_id and tr.event_id = s.event_id and tr.at_uri is not null
    left join venues v on v.id = coalesce(s.venue_id, ts.venue_id) and v.event_id = s.event_id and v.at_uri is not null
    left join accounts a on a.did = s.host_did
    cross join lateral (
      select coalesce(s.host_did is not null and starts_with(s.proposal_uri, 'at://' || s.host_did || '/'), false) as yes
    ) own
    where s.event_id = ${eventId}
      and s.calendar_event_uri is not null
      and (s.status = 'scheduled' or s.cancelled_at is not null)
      ${opts.trackId ? sql`and s.track_id = ${opts.trackId} and tr.id is not null` : sql``}
      ${opts.day ? sql`and ts.day_date = ${opts.day}` : sql``}
    order by coalesce(ts.start_time, s.self_hosted_start_time) nulls last, s.title
  `
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    format: r.format,
    duration: r.duration,
    session_type: r.session_type,
    cancelled: r.cancelled,
    time_slot_id: r.time_slot_id,
    start_time: r.start_time,
    end_time: r.end_time,
    track: r.track_id && r.track_name ? { id: r.track_id, name: r.track_name, color: r.track_color } : null,
    venue: r.venue_id && r.venue_name ? { id: r.venue_id, name: r.venue_name, slug: r.venue_slug } : null,
    host: r.host_did ? { did: r.host_did, handle: r.host_handle } : null,
    // A proposal URI names its repo's DID: the SQL keeps it only when that repo is the host's own
    // or the gathering's (an imported stub), never a third party's.
    uris: { calendar_event: r.calendar_event_uri, slot: r.slot_uri, proposal: r.proposal_uri },
  }))
}

export const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/
