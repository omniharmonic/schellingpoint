import 'server-only'
/** Partner read API shape for sessions (x-api-key), R9-filtered. */
import { sql } from '@/lib/db'

export interface PartnerQuery {
  eventId: string
  statuses: string[]
  includes: string[]
  sessionId?: string
}

interface PartnerRow {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  topic_tags: string[] | null
  skills: string[] | null
  status: string
  is_self_hosted: boolean | null
  self_hosted_start_time: string | null
  self_hosted_end_time: string | null
  session_type: string | null
  track_id: string | null
  venue_id: string | null
  time_slot_id: string | null
  expected_attendance: number | null
  proposal_uri: string | null
  calendar_event_uri: string | null
  created_at: string
  updated_at: string
  host: { display_name: string | null; handle: string | null; bio: string | null; affiliation: string | null } | null
  track: Record<string, unknown> | null
  venue: (Record<string, unknown> & { is_private_residence?: boolean; locality?: string | null }) | null
  time_slot: Record<string, unknown> | null
  cohosts: { display_order: number | null; display_name: string | null; handle: string | null }[]
}

export async function partnerSessions(q: PartnerQuery): Promise<Record<string, unknown>[]> {
  const rows = await sql<PartnerRow[]>`
    select s.id, s.title, s.description, s.format, s.duration, s.topic_tags, s.skill_uris as skills, s.status, s.is_self_hosted,
           s.self_hosted_start_time, s.self_hosted_end_time, s.session_type, s.track_id, s.venue_id, s.time_slot_id,
           s.expected_attendance, s.proposal_uri, s.calendar_event_uri, s.created_at, s.updated_at,
           case when s.host_id is null then null else json_build_object(
             'display_name', hp.display_name, 'handle', ha.handle, 'bio', hp.bio, 'affiliation', hp.affiliation
           ) end as host,
           case when t.id is null then null else json_build_object(
             'id', t.id, 'name', t.name, 'slug', t.slug, 'description', t.description, 'color', t.color
           ) end as track,
           case when v.id is null then null else json_build_object(
             'id', v.id, 'name', v.name, 'slug', v.slug, 'capacity', v.capacity, 'features', v.features,
             'style', v.style, 'address', v.address, 'is_primary', v.is_primary,
             'is_private_residence', v.is_private_residence, 'locality', v.locality
           ) end as venue,
           case when ts.id is null then null else json_build_object(
             'id', ts.id, 'start_time', ts.start_time, 'end_time', ts.end_time, 'label', ts.label,
             'is_break', ts.is_break, 'day_date', ts.day_date, 'slot_type', ts.slot_type
           ) end as time_slot,
           (
             select coalesce(json_agg(json_build_object(
               'display_order', c.display_order, 'display_name', cp.display_name, 'handle', ca.handle
             ) order by c.display_order asc nulls last), '[]'::json)
             from session_cohosts c
             left join profiles cp on cp.id = c.user_id
             left join accounts ca on ca.id = c.user_id
             where c.session_id = s.id
           ) as cohosts
    from sessions s
    left join profiles hp on hp.id = s.host_id
    left join accounts ha on ha.id = s.host_id
    left join tracks t on t.id = s.track_id and t.event_id = s.event_id
    left join venues v on v.id = s.venue_id and v.event_id = s.event_id
    left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
    where s.event_id = ${q.eventId}
      and s.status in ${sql(q.statuses.length ? q.statuses : ['approved', 'scheduled'])}
      ${q.sessionId ? sql`and s.id = ${q.sessionId}` : sql``}
    order by s.created_at desc
  `
  return rows.map((row) => {
    const { host, track, venue, time_slot, cohosts, ...session } = row
    const out: Record<string, unknown> = { ...session, unclaimed: !host }
    if (q.includes.includes('host')) out.host = host
    if (q.includes.includes('track')) out.track = track
    if (q.includes.includes('venue')) {
      if (venue) {
        const { is_private_residence, locality, ...rest } = venue
        out.venue = { ...rest, address: is_private_residence ? locality ?? null : rest.address }
      } else {
        out.venue = null
      }
    }
    if (q.includes.includes('timeslot')) out.time_slot = time_slot
    if (q.includes.includes('cohosts')) out.cohosts = cohosts
    return out
  })
}
