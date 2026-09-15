import 'server-only'
/**
 * Event and session access for the sessions & participation APIs (work package B).
 *
 * Every event-scoped route resolves its event through `loadEventAccess`, which answers
 * 404 for a private or draft event to anyone who is not a member (existence is not
 * disclosed), and reports the viewer's appointed role. Session visibility follows the
 * baseline RLS: approved and scheduled sessions are public within a readable event;
 * pending and rejected sessions are visible only to their host, accepted co-hosts and
 * organizers.
 */
import { NextResponse } from 'next/server'
import { sql, type Sql } from '@/lib/db'
import { getViewer, type Viewer } from '@/lib/auth/viewer'
import type { EventRoleName } from '@/types/event'

export const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

/** Roles that curate the program (baseline `is_session_organizer`). */
export const ORGANIZER_ROLES: readonly EventRoleName[] = ['owner', 'admin', 'moderator']
export const PUBLIC_STATUSES = ['approved', 'scheduled'] as const
export const SESSION_STATUSES = ['pending', 'approved', 'rejected', 'scheduled'] as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })
}

export function json(body: unknown, init: { status?: number } = {}): Response {
  return NextResponse.json(body, { status: init.status ?? 200, headers: NO_STORE })
}

export interface AccessEvent {
  id: string
  slug: string
  name: string
  status: string
  visibility: string
  timezone: string
  location_name: string | null
  location_address: string | null
  require_proposal_approval: boolean | null
  gathering_uri: string | null
  actor_did: string | null
}

export interface EventAccess {
  event: AccessEvent
  viewer: Viewer | null
  role: EventRoleName | null
  /** owner / admin / moderator */
  isOrganizer: boolean
}

function readable(event: Pick<AccessEvent, 'status' | 'visibility'>, role: EventRoleName | null): boolean {
  // Mirrors public.can_read_event().
  if ((event.visibility === 'public' || event.visibility === 'unlisted') && event.status !== 'draft') return true
  if (!role) return false
  return event.status !== 'draft' || role === 'owner' || role === 'admin'
}

async function roleOf(eventId: string, accountId: string | undefined): Promise<EventRoleName | null> {
  if (!accountId) return null
  const rows = await sql<{ role: EventRoleName }[]>`
    select role from event_members where event_id = ${eventId} and user_id = ${accountId}
  `
  return rows[0]?.role ?? null
}

function accessFor(event: AccessEvent, viewer: Viewer | null, role: EventRoleName | null): EventAccess | Response {
  if (!readable(event, role)) return jsonError(404, 'Event not found')
  return { event, viewer, role, isOrganizer: !!role && ORGANIZER_ROLES.includes(role) }
}

/**
 * Resolve an event by slug for the (optional) viewer; 404 when it is not readable.
 * `request` may be omitted in server components (the viewer then comes from Next's cookies).
 */
export async function loadEventAccess(request: Request | undefined, slug: string): Promise<EventAccess | Response> {
  const [viewer, events] = await Promise.all([
    getViewer(request),
    sql<AccessEvent[]>`
      select id, slug, name, status, visibility, timezone, location_name, location_address,
             require_proposal_approval, gathering_uri, actor_did
      from events where slug = ${slug}
    `,
  ])
  const event = events[0]
  if (!event) return jsonError(404, 'Event not found')
  return accessFor(event, viewer, await roleOf(event.id, viewer?.accountId))
}

/** Resolve the event that owns `sessionId`; 404 when either is missing or unreadable. */
export async function loadSessionEventAccess(
  request: Request,
  sessionId: string,
): Promise<(EventAccess & { sessionEventId: string }) | Response> {
  if (!isUuid(sessionId)) return jsonError(404, 'Session not found')
  const [viewer, events] = await Promise.all([
    getViewer(request),
    sql<AccessEvent[]>`
      select id, slug, name, status, visibility, timezone, location_name, location_address,
             require_proposal_approval, gathering_uri, actor_did
      from events
      where id = (select event_id from sessions where id = ${sessionId})
    `,
  ])
  const event = events[0]
  if (!event) return jsonError(404, 'Session not found')
  const access = accessFor(event, viewer, await roleOf(event.id, viewer?.accountId))
  if (access instanceof Response) return jsonError(404, 'Session not found')
  return { ...access, sessionEventId: event.id }
}

/** The session's relationship to an account, straight from the rows. */
export interface SessionRelation {
  id: string
  event_id: string
  status: string
  host_id: string | null
  title: string
  proposal_uri: string | null
  proposal_cid: string | null
  calendar_event_uri: string | null
  isHost: boolean
  isCohost: boolean
}

export async function sessionRelation(db: Sql, sessionId: string, eventId: string, accountId: string | null): Promise<SessionRelation | null> {
  type Row = Omit<SessionRelation, 'isHost' | 'isCohost'> & { is_cohost: boolean }
  const rows = await db<Row[]>`
    select s.id, s.event_id, s.status, s.host_id, s.title, s.proposal_uri, s.proposal_cid, s.calendar_event_uri,
           exists (
             select 1 from session_cohosts c
             where c.session_id = s.id and c.user_id = ${accountId}::uuid
           ) as is_cohost
    from sessions s
    where s.id = ${sessionId} and s.event_id = ${eventId}
  `
  const row = rows[0]
  if (!row) return null
  const { is_cohost, ...rest } = row
  return { ...rest, isHost: !!accountId && row.host_id === accountId, isCohost: is_cohost }
}

/** Whether the viewer may see this session at all (public statuses, or their own, or organizer). */
export function canSeeSession(rel: Pick<SessionRelation, 'status' | 'isHost' | 'isCohost'>, access: Pick<EventAccess, 'isOrganizer'>): boolean {
  return (PUBLIC_STATUSES as readonly string[]).includes(rel.status) || rel.isHost || rel.isCohost || access.isOrganizer
}

/**
 * A signed-in viewer acting in a PUBLIC event becomes an attendee, exactly as the baseline
 * policy "Users can join public events" allows (and as the event layout's auto-join did).
 * Returns the resulting role, or null when the event is not open to self-joining.
 */
export async function ensurePublicMembership(db: Sql, access: EventAccess): Promise<EventRoleName | null> {
  if (!access.viewer) return null
  const [admission] = await db<{ allowed: boolean }[]>`
    select public.has_ticket_entitlement(${access.event.id}, ${access.viewer.accountId}, 'attend') as allowed
  `
  if (!admission?.allowed) return null
  if (access.role) return access.role
  if (access.event.visibility !== 'public' || access.event.status === 'draft') return null
  await db`
    insert into event_members (event_id, user_id, role)
    values (${access.event.id}, ${access.viewer.accountId}, 'attendee')
    on conflict (event_id, user_id) do nothing
  `
  const rows = await db<{ role: EventRoleName }[]>`
    select role from event_members where event_id = ${access.event.id} and user_id = ${access.viewer.accountId}
  `
  return rows[0]?.role ?? null
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  try {
    const text = await request.text()
    if (!text.trim()) return {}
    const body = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, 'Invalid JSON body')
    return body as Record<string, unknown>
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
}
