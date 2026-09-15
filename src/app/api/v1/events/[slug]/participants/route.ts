import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireEventRole } from '@/lib/auth/viewer'
import type { EventRoleName } from '@/types/event'
import { NO_STORE, memberCardColumns, type Participant } from './people'

/**
 * The gathering's directory — members only, never public (spec §8: "the roster is never
 * public"; §10: profile, ENS, Telegram are members-only).
 *
 *   GET /api/v1/events/[slug]/participants
 *     → { participants: Participant[], me: { role, directory_listing, public_role } }
 *
 *   404  no such gathering, or a private/draft one the viewer is not a member of
 *   401  signed out (visible gathering)
 *   403  signed in but not a member of this gathering (a public gathering's roster is still
 *        members-only)
 *
 * Members who opted out (`directory_listing = false`) are omitted, except to themselves.
 */
export const dynamic = 'force-dynamic'

const ANY_ROLE: readonly EventRoleName[] = ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee']

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await requireEventRole(request, slug, ANY_ROLE)
  if (access instanceof Response) return access
  const { viewer, event } = access

  const [participants, [me]] = await Promise.all([
    sql<Participant[]>`
      select ${memberCardColumns()}, m.role, (m.user_id = ${viewer.accountId}) as is_self
      from event_members m
      join accounts a on a.id = m.user_id
      join profiles p on p.id = m.user_id
      where m.event_id = ${event.id}
        and (m.directory_listing or m.user_id = ${viewer.accountId})
      order by lower(coalesce(nullif(p.display_name, ''), a.handle, a.did)), a.did
    `,
    sql<{ role: EventRoleName; directory_listing: boolean; public_role: boolean }[]>`
      select role, directory_listing, public_role
      from event_members where event_id = ${event.id} and user_id = ${viewer.accountId}
    `,
  ])

  return NextResponse.json({ participants, me: me ?? null }, { headers: NO_STORE })
}
