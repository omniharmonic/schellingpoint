import 'server-only'
/**
 * Session reads for the app (work package B): one query shape for the list, the detail
 * page, my-schedule and the schedule, serialized through one R9 filter.
 *
 * What never leaves this module:
 *   - vote counts (`total_votes`, `voter_count`, `total_credits`) — spec §5.3
 *   - any account id, DID, email, Telegram or ENS of another person — R9
 *   - the free-text `host_name`; a host is rendered from their own profile, and a
 *     host-less session is "unclaimed" (organizers additionally see D's "listed as" label)
 *   - attendee-only details (Telegram group, exact self-hosted location) to anyone but
 *     confirmed RSVPs, the session's hosts and organizers — spec §10
 */
import { sql } from '@/lib/db'
import { PUBLIC_STATUSES, SESSION_STATUSES, type EventAccess } from './access'

export type SessionSort = 'newest' | 'title' | 'track' | 'time'
export const SESSION_SORTS: readonly SessionSort[] = ['newest', 'title', 'track', 'time']

export interface SessionListFilters {
  /** Requested statuses; defaults to approved + scheduled. `all` = every status the viewer may see. */
  statuses?: string[] | 'all'
  trackId?: string | null
  format?: string | null
  /** YYYY-MM-DD in the event's timezone (time slot start, or self-hosted start). */
  day?: string | null
  mine?: boolean
  favorites?: boolean
  search?: string | null
  sort?: SessionSort
  /** Only sessions with a time (slot or self-hosted start). */
  timed?: boolean
  ids?: string[]
}

interface CohostJson {
  id: string
  user_id: string
  display_order: number | null
  display_name: string | null
  avatar_url: string | null
  handle: string | null
}

interface SessionRow {
  id: string
  event_id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  topic_tags: string[] | null
  skills: string[] | null
  status: string
  session_type: string | null
  is_self_hosted: boolean | null
  custom_location: string | null
  public_place: string | null
  self_hosted_start_time: string | null
  self_hosted_end_time: string | null
  telegram_group_url: string | null
  expected_attendance: number | null
  required_features: string[] | null
  time_preferences: string[] | null
  rsvp_count: number
  waitlist_count: number
  host_id: string | null
  rejection_reason: string | null
  proposal_uri: string | null
  calendar_event_uri: string | null
  proposal_withdrawn_at: string | null
  created_at: string
  updated_at: string
  host_display_name: string | null
  host_avatar_url: string | null
  host_bio: string | null
  host_affiliation: string | null
  host_handle: string | null
  listed_as: string | null
  track_id: string | null
  track_name: string | null
  track_slug: string | null
  track_color: string | null
  venue_id: string | null
  venue_name: string | null
  venue_capacity: number | null
  venue_features: string[] | null
  venue_address: string | null
  venue_is_private_residence: boolean | null
  venue_locality: string | null
  time_slot_id: string | null
  slot_label: string | null
  slot_start_time: string | null
  slot_end_time: string | null
  slot_day_date: string | null
  cohosts: CohostJson[] | null
  is_favorite: boolean
  rsvp_status: 'confirmed' | 'waitlist' | 'cancelled' | null
  rsvp_waitlist_position: number | null
  rsvp_uri: string | null
  time_windows: unknown
  time_blackouts: unknown
  time_publish: boolean | null
  time_record_uri: string | null
}

export interface PersonView {
  display_name: string | null
  handle: string | null
  avatar_url: string | null
}

export interface SessionView {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  topic_tags: string[]
  skills: string[]
  status: string
  session_type: string | null
  is_self_hosted: boolean
  self_hosted_start_time: string | null
  self_hosted_end_time: string | null
  expected_attendance: number | null
  required_features: string[]
  rsvp_count: number
  waitlist_count: number
  created_at: string
  updated_at: string
  /** A linked host, rendered from their own profile; null for a host-less session. */
  host: (PersonView & { bio?: string | null; affiliation?: string | null }) | null
  /** Host-less: non-organizers render "Unclaimed proposal". */
  unclaimed: boolean
  /** Organizers only: the organizer-typed label for a host-less session. */
  listed_as?: string | null
  /** Accepted co-hosts only (a pending invite names nobody). */
  cohosts: (PersonView & { id: string; is_viewer: boolean })[]
  track: { id: string; name: string; slug: string | null; color: string | null } | null
  track_id: string | null
  venue: { id: string; name: string; capacity: number | null; features: string[]; address: string | null } | null
  time_slot: { id: string; label: string | null; start_time: string; end_time: string; day_date: string | null } | null
  proposal_uri: string | null
  calendar_event_uri: string | null
  proposal_withdrawn: boolean
  is_favorite: boolean
  my_rsvp: { status: 'confirmed' | 'waitlist'; waitlist_position: number | null; public: boolean } | null
  viewer: {
    is_host: boolean
    is_cohost: boolean
    is_organizer: boolean
    /** Proposal content: the author; on a host-less session, organizers. */
    can_edit_content: boolean
    /** Anything at all in the edit dialog (content, track, status, attendee logistics). */
    can_edit: boolean
    /** Resources, invites, attendee logistics: hosts, co-hosts, organizers. */
    can_manage: boolean
  }
  /** Attendee-only: present (possibly null) for confirmed RSVPs, hosts and organizers. */
  telegram_group_url?: string | null
  custom_location?: string | null
  /** The proposer's coarse public label for a self-hosted place ("Near Pearl St, Boulder"). Public. */
  public_place: string | null
  has_telegram_group: boolean
  has_private_location: boolean
  /** Hosts and organizers only. */
  rejection_reason?: string | null
  time_preferences?: string[]
  time_preference?: { windows: unknown; blackouts: unknown; publish: boolean; record_uri: string | null } | null
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

async function queryRows(access: EventAccess, filters: SessionListFilters, sessionId?: string): Promise<SessionRow[]> {
  const viewerId = access.viewer?.accountId ?? null
  const eventId = access.event.id
  const tz = access.event.timezone || 'UTC'

  // Visibility: public statuses, plus the viewer's own sessions, plus everything for organizers.
  const ownership = sql`(
    s.host_id = ${viewerId}::uuid
    or exists (select 1 from session_cohosts oc where oc.session_id = s.id and oc.user_id = ${viewerId}::uuid)
  )`
  const visibility = access.isOrganizer
    ? sql`true`
    : sql`(((s.status in ${sql([...PUBLIC_STATUSES])}) and (s.author_inactive_at is null or s.status = 'scheduled')) or ${ownership})`

  let statuses: string[] | null
  if (sessionId || filters.statuses === 'all' || filters.mine) {
    statuses = Array.isArray(filters.statuses) ? filters.statuses : null
  } else {
    statuses = filters.statuses && filters.statuses.length ? filters.statuses : [...PUBLIC_STATUSES]
  }
  statuses = statuses?.filter((s) => (SESSION_STATUSES as readonly string[]).includes(s)) ?? null

  const startExpr = sql`coalesce(ts.start_time, case when s.is_self_hosted then s.self_hosted_start_time end)`
  const search = filters.search?.trim() ? `%${escapeLike(filters.search.trim().slice(0, 200))}%` : null

  const order =
    filters.sort === 'title' ? sql`lower(s.title) asc, s.created_at desc`
      : filters.sort === 'track' ? sql`t.display_order asc nulls last, lower(t.name) asc nulls last, lower(s.title) asc`
        : filters.sort === 'time' ? sql`${startExpr} asc nulls last, lower(s.title) asc`
          : sql`s.created_at desc`

  return sql<SessionRow[]>`
    select
      s.id, s.event_id, s.title, s.description, s.format, s.duration, s.topic_tags, s.skill_uris as skills, s.status,
      s.session_type, s.is_self_hosted, s.custom_location, s.public_place, s.self_hosted_start_time, s.self_hosted_end_time,
      s.telegram_group_url, s.expected_attendance, s.required_features, s.time_preferences,
      s.rsvp_count, s.waitlist_count, s.host_id, s.rejection_reason, s.proposal_uri, s.calendar_event_uri,
      s.proposal_withdrawn_at, s.created_at, s.updated_at,
      -- A proposer whose repo is taken down / deactivated is not shown (sessions.author_inactive_at).
      case when s.author_inactive_at is null then hp.display_name end as host_display_name,
      case when s.author_inactive_at is null then hp.avatar_url end as host_avatar_url,
      case when s.author_inactive_at is null then hp.bio end as host_bio,
      case when s.author_inactive_at is null then hp.affiliation end as host_affiliation,
      case when s.author_inactive_at is null then ha.handle end as host_handle,
      hl.host_name as listed_as,
      s.track_id, t.name as track_name, t.slug as track_slug, t.color as track_color,
      s.venue_id, v.name as venue_name, v.capacity as venue_capacity, v.features as venue_features,
      v.address as venue_address, v.is_private_residence as venue_is_private_residence, v.locality as venue_locality,
      s.time_slot_id, ts.label as slot_label, ts.start_time as slot_start_time, ts.end_time as slot_end_time,
      ts.day_date as slot_day_date,
      (
        select coalesce(json_agg(json_build_object(
          'id', c.id, 'user_id', c.user_id, 'display_order', c.display_order,
          'display_name', cp.display_name, 'avatar_url', cp.avatar_url, 'handle', ca.handle
        ) order by c.display_order asc nulls last, c.added_at asc), '[]'::json)
        from session_cohosts c
        left join profiles cp on cp.id = c.user_id
        left join accounts ca on ca.id = c.user_id
        where c.session_id = s.id and c.cohost_inactive_at is null
      ) as cohosts,
      (f.id is not null) as is_favorite,
      r.status as rsvp_status, r.waitlist_position as rsvp_waitlist_position, r.rsvp_uri,
      tp.windows as time_windows, tp.blackouts as time_blackouts, tp.publish as time_publish,
      tp.record_uri as time_record_uri
    from sessions s
    left join profiles hp on hp.id = s.host_id
    left join accounts ha on ha.id = s.host_id
    left join session_host_listings hl on hl.session_id = s.id and ${access.isOrganizer}
    left join tracks t on t.id = s.track_id and t.event_id = s.event_id
    left join venues v on v.id = s.venue_id and v.event_id = s.event_id
    left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
    left join favorites f on f.session_id = s.id and f.user_id = ${viewerId}::uuid
    left join session_rsvps r on r.session_id = s.id and r.user_id = ${viewerId}::uuid and r.status <> 'cancelled'
    left join time_preferences tp on tp.session_id = s.id and tp.account_id = s.host_id
    where s.event_id = ${eventId}
      and ${visibility}
      ${sessionId ? sql`and s.id = ${sessionId}` : sql``}
      ${statuses ? (statuses.length ? sql`and s.status in ${sql(statuses)}` : sql`and false`) : sql``}
      ${filters.mine ? sql`and ${viewerId ? ownership : sql`false`}` : sql``}
      ${filters.favorites ? sql`and f.id is not null` : sql``}
      ${filters.trackId ? sql`and s.track_id = ${filters.trackId}::uuid` : sql``}
      ${filters.format ? sql`and s.format = ${filters.format}` : sql``}
      ${filters.ids ? (filters.ids.length ? sql`and s.id in ${sql(filters.ids)}` : sql`and false`) : sql``}
      ${filters.timed ? sql`and ${startExpr} is not null` : sql``}
      ${filters.day ? sql`and (${startExpr} at time zone ${tz})::date = ${filters.day}::date` : sql``}
      ${search ? sql`and (s.title ilike ${search} or s.description ilike ${search} or hp.display_name ilike ${search}
                          or exists (select 1 from unnest(s.topic_tags) tag where tag ilike ${search}))` : sql``}
    order by ${order}
    limit 1000
  `
}

function person(display_name: string | null, handle: string | null, avatar_url: string | null): PersonView {
  return { display_name, handle, avatar_url }
}

export function serializeSession(row: SessionRow, access: EventAccess, detail: boolean): SessionView {
  const viewerId = access.viewer?.accountId ?? null
  const cohostRows = row.cohosts ?? []
  const isHost = !!viewerId && row.host_id === viewerId
  const isCohost = !!viewerId && cohostRows.some((c) => c.user_id === viewerId)
  const isOrganizer = access.isOrganizer
  const canManage = isHost || isCohost || isOrganizer
  const confirmed = row.rsvp_status === 'confirmed'
  const attendeeDetails = canManage || confirmed
  const isMember = !!access.role

  const view: SessionView = {
    id: row.id,
    title: row.title,
    description: row.description,
    format: row.format,
    duration: row.duration,
    topic_tags: row.topic_tags ?? [],
    skills: row.skills ?? [],
    status: row.status,
    session_type: row.session_type,
    is_self_hosted: !!row.is_self_hosted,
    self_hosted_start_time: row.self_hosted_start_time,
    self_hosted_end_time: row.self_hosted_end_time,
    expected_attendance: row.expected_attendance,
    required_features: row.required_features ?? [],
    rsvp_count: row.rsvp_count ?? 0,
    waitlist_count: row.waitlist_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    host: row.host_id
      ? {
          ...person(row.host_display_name, row.host_handle, row.host_avatar_url),
          // Self-written profile text stays within the gathering (spec §10: profile → members).
          ...(detail && (isMember || isHost) ? { bio: row.host_bio, affiliation: row.host_affiliation } : {}),
        }
      : null,
    unclaimed: !row.host_id,
    cohosts: cohostRows.map((c) => ({
      id: c.id,
      ...person(c.display_name, c.handle, c.avatar_url),
      is_viewer: !!viewerId && c.user_id === viewerId,
    })),
    track: row.track_id && row.track_name
      ? { id: row.track_id, name: row.track_name, slug: row.track_slug, color: row.track_color }
      : null,
    track_id: row.track_id,
    venue: row.venue_id && row.venue_name
      ? {
          id: row.venue_id,
          name: row.venue_name,
          capacity: row.venue_capacity,
          features: row.venue_features ?? [],
          // A private residence's street address is ticket-holder detail, never public (spec §10).
          address: row.venue_is_private_residence && !attendeeDetails ? row.venue_locality : row.venue_address,
        }
      : null,
    time_slot: row.time_slot_id && row.slot_start_time && row.slot_end_time
      ? { id: row.time_slot_id, label: row.slot_label, start_time: row.slot_start_time, end_time: row.slot_end_time, day_date: row.slot_day_date }
      : null,
    proposal_uri: row.proposal_uri,
    calendar_event_uri: row.calendar_event_uri,
    proposal_withdrawn: !!row.proposal_withdrawn_at,
    is_favorite: !!row.is_favorite,
    my_rsvp: row.rsvp_status === 'confirmed' || row.rsvp_status === 'waitlist'
      ? { status: row.rsvp_status, waitlist_position: row.rsvp_waitlist_position, public: !!row.rsvp_uri }
      : null,
    viewer: {
      is_host: isHost,
      is_cohost: isCohost,
      is_organizer: isOrganizer,
      can_edit_content: row.host_id ? isHost : isOrganizer,
      can_edit: canManage,
      can_manage: canManage,
    },
    has_telegram_group: !!row.telegram_group_url,
    has_private_location: !!(row.is_self_hosted && row.custom_location),
    public_place: row.is_self_hosted ? row.public_place : null,
  }

  if (isOrganizer && !row.host_id) view.listed_as = row.listed_as
  if (detail && attendeeDetails) {
    view.telegram_group_url = row.telegram_group_url
    view.custom_location = row.custom_location
  }
  if (canManage) {
    view.rejection_reason = row.rejection_reason
    view.time_preferences = row.time_preferences ?? []
    view.time_preference = row.time_windows !== null && row.time_windows !== undefined
      ? { windows: row.time_windows, blackouts: row.time_blackouts, publish: !!row.time_publish, record_uri: row.time_record_uri }
      : null
  }
  return view
}

export async function listSessions(access: EventAccess, filters: SessionListFilters): Promise<SessionView[]> {
  const rows = await queryRows(access, filters)
  return rows.map((row) => serializeSession(row, access, false))
}

export async function getSession(access: EventAccess, sessionId: string): Promise<SessionView | null> {
  const rows = await queryRows(access, { statuses: 'all' }, sessionId)
  return rows[0] ? serializeSession(rows[0], access, true) : null
}

export function parseListFilters(url: URL): SessionListFilters | { error: string } {
  const p = url.searchParams
  const filters: SessionListFilters = {}
  const status = p.get('status')
  if (status) {
    if (status === 'all') filters.statuses = 'all'
    else {
      const list = status.split(',').map((s) => s.trim()).filter(Boolean)
      const bad = list.filter((s) => !(SESSION_STATUSES as readonly string[]).includes(s))
      if (bad.length) return { error: `Invalid status: ${bad.join(', ')}` }
      filters.statuses = list
    }
  }
  const track = p.get('track')
  if (track) {
    if (!/^[0-9a-f-]{36}$/i.test(track)) return { error: 'track must be a track id' }
    filters.trackId = track
  }
  const format = p.get('format')
  if (format && format !== 'all') filters.format = format.slice(0, 40)
  const day = p.get('day')
  if (day && day !== 'all') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { error: 'day must be YYYY-MM-DD' }
    filters.day = day
  }
  filters.mine = p.get('mine') === '1' || p.get('mine') === 'true'
  filters.favorites = p.get('favorites') === '1' || p.get('favorites') === 'true'
  filters.timed = p.get('timed') === '1' || p.get('timed') === 'true'
  const q = p.get('q') ?? p.get('search')
  if (q) filters.search = q
  const sort = p.get('sort')
  if (sort) {
    if (!(SESSION_SORTS as readonly string[]).includes(sort)) return { error: `sort must be one of ${SESSION_SORTS.join(', ')}` }
    filters.sort = sort as SessionSort
  }
  return filters
}
