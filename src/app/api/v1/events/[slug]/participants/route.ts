import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireEventRole } from '@/lib/auth/viewer'
import type { EventRoleName } from '@/types/event'
import { NO_STORE, memberCardColumns, type Participant } from './people'

/**
 * The gathering's directory — members only, never public (spec §8: "the roster is never
 * public"; §10: profile, ENS and the messaging handle are members-only).
 *
 *   GET /api/v1/events/[slug]/participants
 *     → { participants: Participant[],
 *         me: { role, directory_listing, public_role, share_email, share_contact },
 *         sharedInterests: { id, interests: string[] }[] }
 *
 *   404  no such gathering, or a private/draft one the viewer is not a member of
 *   401  signed out (visible gathering)
 *   403  signed in but not a member of this gathering (a public gathering's roster is still
 *        members-only)
 *
 * Members who opted out (`directory_listing = false`) are omitted, except to themselves.
 *
 * A card carries the person's messaging handle only where they left `share_contact` on (default
 * on) and their email only where they turned `share_email` on for THIS gathering (default off) —
 * `memberCardColumns` applies both (design §3.3). A non-member never reaches this route at all.
 *
 * The list is not paged: the whole roster of one gathering comes back in one response, so the
 * People page sorts and filters it in the browser (design §3.4) and this route keeps its one
 * deterministic order (name, then DID).
 *
 * `sharedInterests` is "People who share your interests" (release design §6): computed here for
 * the viewer only, from interest overlap with the listed members, ordered by overlap. It is never
 * stored and never a record; votes are not an input.
 */
export const dynamic = 'force-dynamic'

const ANY_ROLE: readonly EventRoleName[] = ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee']

/** How many "people who share your interests" to suggest. */
const SHARED_INTERESTS_LIMIT = 6

export interface SharedInterests {
  /** accounts.id of the other member. */
  id: string
  /** The viewer's interests this person also lists, in the viewer's order. */
  interests: string[]
}

// Not exported: Next's route module type-check allows only handlers and config as value exports.
function sharedInterestsFor(participants: Participant[]): SharedInterests[] {
  const me = participants.find((p) => p.is_self)
  const mine = (me?.interests ?? []).map((i) => i.trim()).filter(Boolean)
  if (!mine.length) return []
  const mineByKey = new Map(mine.map((i) => [i.toLowerCase(), i] as const))
  const out: SharedInterests[] = []
  for (const p of participants) {
    if (p.is_self || !p.interests?.length) continue
    const theirs = new Set(p.interests.map((i) => i.trim().toLowerCase()))
    const overlap = [...mineByKey.entries()].filter(([key]) => theirs.has(key)).map(([, label]) => label)
    if (overlap.length) out.push({ id: p.id, interests: overlap })
  }
  return out.sort((a, b) => b.interests.length - a.interests.length).slice(0, SHARED_INTERESTS_LIMIT)
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await requireEventRole(request, slug, ANY_ROLE)
  if (access instanceof Response) return access
  const { viewer, event } = access

  const [participants, [me]] = await Promise.all([
    sql<Participant[]>`
      select ${memberCardColumns(sql`m.share_contact`, sql`m.share_email`)},
        m.role, m.joined_at, (m.user_id = ${viewer.accountId}) as is_self
      from event_members m
      join accounts a on a.id = m.user_id
      join profiles p on p.id = m.user_id
      where m.event_id = ${event.id}
        and (m.directory_listing or m.user_id = ${viewer.accountId})
      order by lower(coalesce(nullif(p.display_name, ''), a.handle, a.did)), a.did
    `,
    sql<{ role: EventRoleName; directory_listing: boolean; public_role: boolean; share_email: boolean; share_contact: boolean }[]>`
      select role, directory_listing, public_role, share_email, share_contact
      from event_members where event_id = ${event.id} and user_id = ${viewer.accountId}
    `,
  ])

  return NextResponse.json(
    { participants, me: me ?? null, sharedInterests: sharedInterestsFor(participants) },
    { headers: NO_STORE },
  )
}
