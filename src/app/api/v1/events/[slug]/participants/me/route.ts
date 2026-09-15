import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import type { EventRoleName } from '@/types/event'
import { NO_STORE, jsonError } from '../people'
import { applyRoleClaimOptIn, type RoleClaimOutcome } from './role-claim'

/**
 * The viewer's own directory settings in one gathering.
 *
 *   GET   → { role, directory_listing, public_role, publish_roles }
 *   PATCH { directory_listing?: boolean, public_role?: boolean }
 *         → same body, plus `role_claim` when `public_role` changed
 *
 * `directory_listing` (default on) lists the viewer in this gathering's members-only directory.
 * `public_role` (default off) is the viewer's consent to a public "host of this gathering" role
 * claim; it only reaches the network when the gathering's policy allows role publishing and the
 * viewer's derived role is at least Host (spec §4.1, §10). Members only: 404 for private/draft
 * gatherings to non-members, 403 for a public gathering the viewer has not joined.
 */
export const dynamic = 'force-dynamic'

const ANY_ROLE: readonly EventRoleName[] = ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee']

interface Settings {
  role: EventRoleName
  directory_listing: boolean
  public_role: boolean
  publish_roles: boolean
}

async function load(eventId: string, accountId: string): Promise<Settings | null> {
  const [row] = await sql<Settings[]>`
    select m.role, m.directory_listing, m.public_role,
           coalesce((to_jsonb(e) -> 'policy_thresholds' ->> 'publishRoles')::boolean, false) as publish_roles
    from event_members m join events e on e.id = m.event_id
    where m.event_id = ${eventId} and m.user_id = ${accountId}
  `
  return row ?? null
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const access = await requireEventRole(request, (await params).slug, ANY_ROLE)
  if (access instanceof Response) return access
  const settings = await load(access.event.id, access.viewer.accountId)
  if (!settings) return jsonError(403, 'Forbidden')
  return NextResponse.json(settings, { headers: NO_STORE })
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const access = await requireEventRole(request, (await params).slug, ANY_ROLE)
  if (access instanceof Response) return access
  const { viewer, event } = access

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, 'Expected a JSON object')
  const unknown = Object.keys(body).filter((k) => k !== 'directory_listing' && k !== 'public_role')
  if (unknown.length) return jsonError(400, `Unknown field: ${unknown.join(', ')}`, { field: unknown[0] })
  for (const key of ['directory_listing', 'public_role'] as const) {
    if (key in body && typeof body[key] !== 'boolean') return jsonError(400, `${key} must be true or false`, { field: key })
  }
  const listing = typeof body.directory_listing === 'boolean' ? body.directory_listing : null
  const publicRole = typeof body.public_role === 'boolean' ? body.public_role : null

  const before = await load(event.id, viewer.accountId)
  if (!before) return jsonError(403, 'Forbidden')

  if (listing !== null) {
    await sql`
      update event_members set directory_listing = ${listing}
      where event_id = ${event.id} and user_id = ${viewer.accountId}
    `
  }

  let roleClaim: RoleClaimOutcome | undefined
  if (publicRole !== null && publicRole !== before.public_role) {
    // F's writer stores the opt-in first, then evaluates the other gates and writes or retracts
    // the record; a slow or unreachable PDS never loses the person's choice.
    roleClaim = await applyRoleClaimOptIn({ eventId: event.id, accountId: viewer.accountId, optIn: publicRole })
  }

  const after = await load(event.id, viewer.accountId)
  if (!after) return jsonError(403, 'Forbidden')
  return NextResponse.json({ ...after, ...(roleClaim ? { role_claim: roleClaim } : {}) }, { headers: NO_STORE })
}
