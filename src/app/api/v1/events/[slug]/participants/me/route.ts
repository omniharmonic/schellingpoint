import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import type { EventRoleName } from '@/types/event'
import { NO_STORE, jsonError } from '../people'
import { applyRoleClaimOptIn, type RoleClaimOutcome } from './role-claim'

/**
 * The viewer's own directory settings in one gathering.
 *
 *   GET   → { role, directory_listing, public_role, publish_roles, mention_in_posts, feed_posts,
 *             has_handle, share_contact, share_email, has_telegram, has_email }
 *   PATCH { directory_listing?, public_role?, mention_in_posts?, share_contact?, share_email? }
 *         → same body, plus `role_claim` when `public_role` changed
 *
 * `mention_in_posts` (default off, design §7.2) is the viewer's per-gathering consent to be
 * @-mentioned in the gathering's feed posts about sessions they host; the gathering actor port
 * re-checks it (with host/co-host and repo visibility) for every post.
 *
 * `share_contact` (default on) and `share_email` (default off) are the viewer's per-gathering
 * consent to show their messaging handle and their email address on their card in this
 * gathering's directory (design §3.3, migration 0038). They are read by the directory's own
 * projection (`people.ts`); nothing here ever reaches a record.
 *
 * `directory_listing` (default on) lists the viewer in this gathering's members-only directory.
 * `public_role` (default off) is the viewer's consent to a public "host of this gathering" role
 * claim; it only reaches the network when the gathering's policy allows role publishing and the
 * viewer's derived role is at least Host (spec §4.1, §10). Members only: 404 for private/draft
 * gatherings to non-members, 403 for a public gathering the viewer has not joined.
 */
export const dynamic = 'force-dynamic'

const ANY_ROLE: readonly EventRoleName[] = ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee']

/** The only fields a member may write on their own membership row — never `role`. */
const WRITABLE = ['directory_listing', 'public_role', 'mention_in_posts', 'share_contact', 'share_email'] as const

interface Settings {
  role: EventRoleName
  directory_listing: boolean
  public_role: boolean
  publish_roles: boolean
  /** Feed (design §7.2): the viewer's consent to be @-mentioned in this gathering's posts about their sessions. */
  mention_in_posts: boolean
  /** Whether the gathering posts to its feed at all (so the UI can say the switch is dormant). */
  feed_posts: boolean
  /** Whether the viewer's account has a handle a mention could render (`accounts.handle`). */
  has_handle: boolean
  /** Design §3.3: show the messaging handle to fellow members of this gathering (default on). */
  share_contact: boolean
  /** Design §3.3: show the email address to fellow members of this gathering (default off). */
  share_email: boolean
  /** Whether there is a messaging handle to share at all (so the UI can say the switch is idle). */
  has_telegram: boolean
  /** Whether the account has an email address (an OAuth-only account has none). */
  has_email: boolean
}

async function load(eventId: string, accountId: string): Promise<Settings | null> {
  const [row] = await sql<Settings[]>`
    select m.role, m.directory_listing, m.public_role,
           coalesce((to_jsonb(e) -> 'policy_thresholds' ->> 'publishRoles')::boolean, false) as publish_roles,
           m.mention_in_posts, e.feed_posts,
           (a.handle is not null) as has_handle,
           m.share_contact, m.share_email,
           (p.telegram is not null) as has_telegram,
           (a.email is not null) as has_email
    from event_members m
    join events e on e.id = m.event_id
    join accounts a on a.id = m.user_id
    join profiles p on p.id = m.user_id
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
  const unknown = Object.keys(body).filter((k) => !(WRITABLE as readonly string[]).includes(k))
  if (unknown.length) return jsonError(400, `Unknown field: ${unknown.join(', ')}`, { field: unknown[0] })
  for (const key of WRITABLE) {
    if (key in body && typeof body[key] !== 'boolean') return jsonError(400, `${key} must be true or false`, { field: key })
  }
  const listing = typeof body.directory_listing === 'boolean' ? body.directory_listing : null
  const publicRole = typeof body.public_role === 'boolean' ? body.public_role : null
  const mention = typeof body.mention_in_posts === 'boolean' ? body.mention_in_posts : null
  const shareContact = typeof body.share_contact === 'boolean' ? body.share_contact : null
  const shareEmail = typeof body.share_email === 'boolean' ? body.share_email : null

  const before = await load(event.id, viewer.accountId)
  if (!before) return jsonError(403, 'Forbidden')

  if (listing !== null) {
    await sql`
      update event_members set directory_listing = ${listing}
      where event_id = ${event.id} and user_id = ${viewer.accountId}
    `
  }
  if (shareContact !== null) {
    await sql`
      update event_members set share_contact = ${shareContact}
      where event_id = ${event.id} and user_id = ${viewer.accountId}
    `
  }
  if (shareEmail !== null) {
    // Their own switch only: the directory projection re-reads it on every read, so turning it
    // off hides the address again immediately. It never reached a record to begin with.
    await sql`
      update event_members set share_email = ${shareEmail}
      where event_id = ${event.id} and user_id = ${viewer.accountId}
    `
  }
  if (mention !== null) {
    // The viewer's own switch only (R9): the port re-reads it for every post it writes, so turning
    // it off takes effect on the next post; posts already made are not rewritten.
    await sql`
      update event_members set mention_in_posts = ${mention}
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
