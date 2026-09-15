import 'server-only'
import { cache } from 'react'
import { sql } from '@/lib/db'
import { getViewer, type Viewer } from '@/lib/auth/viewer'
import type { Event, EventMember, EventRoleName, EventRow } from '@/types/event'
import { transformEventRow } from '@/types/event'
import { readPolicyThresholds, type GatheringPolicyThresholds } from './policy'

// Re-export date and timezone utilities
export * from './dates'
export * from './timezone'
export * from './lifecycle'
export * from './templates'
export * from './policy'

/** An `events` row plus the gathering-identity columns the shared `EventRow` type predates. */
export type EventRecord = EventRow & {
  actor_did: string | null
  actor_handle: string | null
  gathering_uri: string | null
  calendar_event_uri: string | null
  policy_uri: string | null
  atproto_published_at: string | null
  policy_thresholds: unknown
}

/**
 * What event pages may show about the gathering's public identity. Everything here is
 * already public on the network once `publishedAt` is set; before that only organizers
 * see it (the layout strips it for everyone else).
 */
export interface GatheringNetwork {
  did: string | null
  handle: string | null
  gatheringUri: string | null
  policyUri: string | null
  publishedAt: string | null
  thresholds: GatheringPolicyThresholds
}

export function networkOf(row: EventRecord): GatheringNetwork {
  return {
    did: row.actor_did,
    handle: row.actor_handle,
    gatheringUri: row.gathering_uri,
    policyUri: row.policy_uri,
    publishedAt: row.atproto_published_at,
    thresholds: readPolicyThresholds(row.policy_thresholds),
  }
}

/** `https://bsky.app/profile/<handle>` for a handle; `https://pdsls.dev/<at-uri>` for a record. */
export function networkLinks(network: Pick<GatheringNetwork, 'handle' | 'gatheringUri'>): { profile: string | null; record: string | null } {
  return {
    profile: network.handle ? `https://bsky.app/profile/${encodeURIComponent(network.handle)}` : null,
    record: network.gatheringUri?.startsWith('at://') ? `https://pdsls.dev/${network.gatheringUri}` : null,
  }
}

export interface ViewerMembership {
  role: EventRoleName
  voteCredits: number | null
}

export type EventAccess =
  | { ok: true; row: EventRecord; event: Event; viewer: Viewer | null; membership: ViewerMembership | null }
  | { ok: false; reason: 'draft' | 'private' | 'unknown' }

/** Hidden events (drafts, private gatherings) are readable only by their members. */
export function isHiddenEvent(row: { status: string; visibility: string }): boolean {
  return row.status === 'draft' || row.visibility === 'private'
}

export type JoinBlock = 'hidden' | 'archived' | 'ticket-required' | null

/**
 * Whether a signed-in account may join this gathering by explicitly asking (spec §5.5:
 * membership comes from a ticket, an invitation, or an explicit join — never from a page view).
 *   hidden           private or draft: invitations only (answer 404)
 *   archived         the gathering is over and closed
 *   ticket-required  ticketing is on with a tier that costs money: buy a ticket instead
 */
export async function joinBlock(event: { id: string; status: string; visibility: string; ticketing_enabled?: boolean | null }): Promise<JoinBlock> {
  if (isHiddenEvent(event)) return 'hidden'
  if (event.status === 'archived') return 'archived'
  const [paid] = await sql<{ n: number }[]>`
    select count(*)::int as n from ticket_tiers t join events e on e.id = t.event_id
    where t.event_id = ${event.id} and e.ticketing_enabled and t.is_active and t.price_cents > 0
  `
  return (paid?.n ?? 0) > 0 ? 'ticket-required' : null
}

async function membershipOf(eventId: string, accountId: string): Promise<ViewerMembership | null> {
  const [row] = await sql<{ role: EventRoleName; vote_credits: number | null }[]>`
    select role, vote_credits from event_members where event_id = ${eventId} and user_id = ${accountId}
  `
  return row ? { role: row.role, voteCredits: row.vote_credits } : null
}

/**
 * Resolve a slug for the current request's viewer (the session cookie). Private and draft
 * gatherings resolve only for their members; everyone else gets the gate reason, never the row.
 */
export async function loadEventForViewer(slug: string, request?: Request): Promise<EventAccess> {
  // Authorize on the gate columns first; the full row is read only once the viewer may see
  // it. (In development React records awaited values as debug info in the page payload, so a
  // row read before the gate would ride along with the access-gate page.)
  const [gates, viewer] = await Promise.all([
    sql<{ id: string; status: string; visibility: string }[]>`select id, status, visibility from events where slug = ${slug}`,
    getViewer(request),
  ])
  const gate = gates[0]
  if (!gate) return { ok: false, reason: 'unknown' }
  const membership = viewer ? await membershipOf(gate.id, viewer.accountId) : null
  if (isHiddenEvent(gate) && !membership) {
    return { ok: false, reason: gate.status === 'draft' ? 'draft' : 'private' }
  }
  const [row] = await sql<EventRecord[]>`select * from events where id = ${gate.id}`
  if (!row || (isHiddenEvent(row) && !membership)) return { ok: false, reason: 'unknown' }
  return { ok: true, row, event: transformEventRow(row), viewer, membership }
}

/** `loadEventForViewer` memoised for one server render (layout, page and metadata share it). */
export const getEventAccess = cache((slug: string) => loadEventForViewer(slug))

/** Event records are authorized before they enter a server component payload. */
export async function getEventBySlug(slug: string): Promise<Event | null> {
  const access = await getEventAccess(slug)
  return access.ok ? access.event : null
}

/**
 * Why a slug is not viewable by the current visitor. Used only to pick the access-gate
 * copy; the event payload itself is never returned here.
 */
export async function getEventAccessReason(slug: string): Promise<'draft' | 'private' | 'unknown'> {
  const access = await getEventAccess(slug)
  return access.ok ? 'unknown' : access.reason
}

/** Get event by ID (server-side), with the same visibility rule as `getEventBySlug`. */
export async function getEventById(id: string): Promise<Event | null> {
  const [row] = await sql<{ slug: string }[]>`select slug from events where id = ${id}`
  return row ? getEventBySlug(row.slug) : null
}

/** A user's membership row for an event. */
export async function getEventMembership(eventId: string, userId: string): Promise<EventMember | null> {
  const [row] = await sql<{ id: string; event_id: string; user_id: string; role: EventRoleName; vote_credits: number | null; joined_at: string }[]>`
    select id, event_id, user_id, role, vote_credits, joined_at from event_members
    where event_id = ${eventId} and user_id = ${userId}
  `
  if (!row) return null
  return {
    id: row.id,
    eventId: row.event_id,
    userId: row.user_id,
    role: row.role,
    voteCredits: row.vote_credits,
    joinedAt: new Date(row.joined_at),
  }
}

export type DirectoryEvent = EventRecord & { attendee_count: number }

/**
 * Public, non-draft, non-archived gatherings for discovery (home page, `/events`), oldest
 * start first, each with its member count. Unlisted and private gatherings never appear.
 */
export async function getDirectoryEvents(): Promise<DirectoryEvent[]> {
  return sql<DirectoryEvent[]>`
    select e.*, coalesce(m.n, 0)::int as attendee_count
    from events e
    left join (select event_id, count(*) as n from event_members group by event_id) m on m.event_id = e.id
    where e.visibility = 'public' and e.status not in ('draft', 'archived')
    order by e.start_date asc, e.name asc
  `
}

/** Get all public non-draft events (for discovery), newest first. */
export async function getPublicEvents(): Promise<Event[]> {
  const rows = await sql<EventRecord[]>`
    select * from events where visibility = 'public' and status <> 'draft' order by start_date desc
  `
  return rows.map((row) => transformEventRow(row))
}

export interface OrganizedEvent {
  id: string
  slug: string
  name: string
  tagline: string | null
  start_date: string
  end_date: string
  location_name: string | null
  status: string
  logo_url: string | null
  role: EventRoleName
  has_identity: boolean
}

/** Gatherings the account organizes (owner/admin), newest first. */
export async function getOrganizedEvents(accountId: string): Promise<OrganizedEvent[]> {
  return sql<OrganizedEvent[]>`
    select e.id, e.slug, e.name, e.tagline, e.start_date, e.end_date, e.location_name, e.status, e.logo_url,
           m.role, (e.actor_did is not null) as has_identity
    from event_members m join events e on e.id = m.event_id
    where m.user_id = ${accountId} and m.role in ('owner', 'admin')
    order by e.start_date desc, e.name asc
  `
}
