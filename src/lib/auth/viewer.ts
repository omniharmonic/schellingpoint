import 'server-only'
/**
 * Who is asking, and may they? (plan §3.2)
 *
 * The viewer is the `sp_at_session` cookie's session joined to its `accounts` row. There
 * is no bearer token anywhere: the browser holds only the HttpOnly cookie.
 *
 * Route order for a mutation (plan §3.4):
 *   const bad = assertSameOrigin(request); if (bad) return bad
 *   const viewer = await requireViewer(request); if (viewer instanceof Response) return viewer
 */
import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import type { EventRoleName } from '@/types/event'
import { publicUrl } from '@/lib/atproto/config'
import { sessionIdFrom } from '@/lib/atproto/session'

export interface Viewer {
  accountId: string
  did: string
  handle: string | null
  email: string | null
  kind: 'custodial' | 'oauth'
  sessionId: string
}

export interface ViewerEvent {
  id: string
  slug: string
  status: string
  visibility: string
  actor_did: string | null
}

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function jsonError(status: number, error: string): Response {
  return NextResponse.json({ error }, { status, headers: NO_STORE })
}

/** The signed-in viewer from the request's cookie (or Next's request cookies), or null. */
export async function getViewer(request?: Request): Promise<Viewer | null> {
  let sessionId: string | null
  try {
    sessionId = await sessionIdFrom(request)
  } catch {
    return null
  }
  if (!sessionId) return null
  const rows = await sql<{
    session_id: string; expires_at: string; account_id: string; did: string; handle: string | null
    email: string | null; kind: 'custodial' | 'oauth'
  }[]>`
    select s.id as session_id, s.expires_at, a.id as account_id, a.did, a.handle, a.email, a.kind
    from at_sessions s join accounts a on a.id = s.user_id
    where s.id = ${sessionId}
  `
  const row = rows[0]
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await sql`delete from at_sessions where id = ${sessionId}`
    return null
  }
  return { accountId: row.account_id, did: row.did, handle: row.handle, email: row.email, kind: row.kind, sessionId: row.session_id }
}

/** The viewer, or a 401 `{ error: 'Unauthorized' }` response. */
export async function requireViewer(request: Request): Promise<Viewer | Response> {
  const viewer = await getViewer(request)
  return viewer ?? jsonError(401, 'Unauthorized')
}

/** The account's appointed role in the event, or null. */
export async function eventRole(eventId: string, accountId: string): Promise<EventRoleName | null> {
  const rows = await sql<{ role: EventRoleName }[]>`
    select role from event_members where event_id = ${eventId} and user_id = ${accountId}
  `
  return rows[0]?.role ?? null
}

/**
 * Resolve `slug`, then require one of `roles`.
 *   404  no such event, or a private/draft event the viewer is not a member of
 *        (existence is not disclosed to non-members)
 *   401  no viewer (for a visible event)
 *   403  a role outside `roles`
 */
export async function requireEventRole(
  request: Request,
  slug: string,
  roles: readonly EventRoleName[],
): Promise<{ viewer: Viewer; event: ViewerEvent; role: EventRoleName } | Response> {
  const [viewer, events] = await Promise.all([
    getViewer(request),
    sql<ViewerEvent[]>`select id, slug, status, visibility, actor_did from events where slug = ${slug}`,
  ])
  const event = events[0]
  if (!event) return jsonError(404, 'Event not found')
  const role = viewer ? await eventRole(event.id, viewer.accountId) : null
  const hidden = event.visibility === 'private' || event.status === 'draft'
  if (hidden && !role) return jsonError(404, 'Event not found')
  if (!viewer) return jsonError(401, 'Unauthorized')
  if (!role || !roles.includes(role)) return jsonError(403, 'Forbidden')
  return { viewer, event, role }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

function appHost(): string | null {
  try {
    return new URL(publicUrl()).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

function hostnameOf(value: string | null): string | null {
  if (!value || value === 'null') return null
  try {
    return new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * CSRF guard for unsafe methods. Allowed when the `Origin` (or `Referer`) host is the app
 * host, a subdomain of it (gathering subdomains), or the host this request was addressed
 * to. A request with neither header is allowed only when `Sec-Fetch-Site` is absent too
 * (server-to-server, curl, tests) — browsers always send one of them. `Sec-Fetch-Site:
 * cross-site` is refused outright. Returns null when allowed, else a 403 response.
 */
export function assertSameOrigin(request: Request): Response | null {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null
  const refuse = () => jsonError(403, 'Cross-origin request refused')

  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase() ?? null
  if (fetchSite === 'cross-site') return refuse()

  const originHeader = request.headers.get('origin')
  const refererHeader = request.headers.get('referer')
  if (!originHeader && !refererHeader) return fetchSite === null ? null : refuse()

  const source = originHeader ?? refererHeader
  const host = hostnameOf(source)
  if (!host) return refuse()

  const app = appHost()
  if (app && (host === app || host.endsWith(`.${app}`))) return null
  const addressed = (request.headers.get('host') ?? '').split(':')[0]?.toLowerCase()
  if (addressed && host === addressed) return null
  return refuse()
}
