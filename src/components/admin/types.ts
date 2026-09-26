/**
 * Shapes returned by the organizer admin API (work package D), for client components.
 * Mirrors src/lib/scheduling/program.ts, which is server-only.
 */

export type SessionStatus = 'pending' | 'approved' | 'rejected' | 'scheduled'

export interface AdminSession {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  status: SessionStatus
  host_id: string | null
  /** The host's own display name. */
  host_display_name: string | null
  /** The host account's DID, so the builder's host line can link to their profile (design §3.2). */
  host_did: string | null
  /** Organizer-typed speaker name for a host-less session: organizer-only, never published. */
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
  author_inactive_at?: string | null
  cancelled_at: string | null
  /** Organizer pin: the room this session must be in; null = any room. */
  pinned_venue_id: string | null
  venue: { id: string; name: string } | null
  time_slot: { id: string; label: string | null; start_time: string; end_time: string; day_date: string | null } | null
  track: { id: string; name: string; color: string | null } | null
}

export interface SessionResult {
  voters: number
  votes: number
  credits: number
}

export type RoundStatus = 'none' | 'upcoming' | 'open' | 'closed'

export interface AdminSessionsResponse {
  sessions: AdminSession[]
  voting: { status: RoundStatus; closesAt: string | null }
  /** Present only when no round is open (organizer-only). */
  results: Record<string, SessionResult> | null
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
  /** Migration 0023 (map). */
  latitude?: number | null
  longitude?: number | null
  geocoded_from?: string | null
  /** Migration 0036: how the pin got there / how the background lookup went. */
  geocode_status?: 'pending' | 'ok' | 'failed' | 'manual' | null
  /** Migration 0036: the room's outline (GeoJSON Polygon). App-side only; never published. */
  outline?: { type: 'Polygon'; coordinates: [number, number][][] } | null
  network_published: boolean
  slot_count: number
  scheduled_count: number
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

export interface NetworkSync {
  attempted: boolean
  results: Array<{ kind: string; id: string; uri?: string; error?: string }>
  error?: string
}

/** Human summary of an after-commit network sync, or null when there is nothing to say. */
export function networkNotice(sync: NetworkSync | undefined | null): string | null {
  if (!sync || !sync.attempted) return null
  if (sync.error) return sync.error
  const failed = sync.results.filter((r) => r.error)
  if (failed.length) return `Saved. ${failed.length} network record${failed.length === 1 ? '' : 's'} could not be updated: ${failed[0].error}`
  return null
}

/** Display name for a session's host: the host's own name, or the organizer's "listed as" name. */
export function hostLabel(session: Pick<AdminSession, 'host_id' | 'host_display_name' | 'listed_host_name'>): string | null {
  if (session.host_id) return session.host_display_name || 'Host account'
  if (session.listed_host_name) return `Listed as ${session.listed_host_name}`
  return null
}
