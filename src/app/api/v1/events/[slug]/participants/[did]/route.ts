import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireEventRole } from '@/lib/auth/viewer'
import type { EventRoleName } from '@/types/event'
import { NO_STORE, decodeDidParam, isDid, jsonError, memberCardColumns, type Participant } from '../people'

/**
 * One person as this gathering's members see them — what the profile page at
 * `/e/[slug]/people/[did]` renders (design §3.1).
 *
 *   GET /api/v1/events/[slug]/participants/[did]
 *     → { member: Participant, sessions: { id, title, status, start_time, venue_name }[] }
 *
 *   404  no such gathering; a private/draft one the viewer is not a member of; a DID that is not
 *        a member here; or a member who is not listed in the directory (and is not the viewer).
 *        Never 403 for the person: that would confirm the DID holds an account here.
 *   401  signed out (visible gathering)
 *   403  signed in but not a member of this gathering
 *
 * The messaging handle and the email address follow the person's own per-gathering switches
 * (`share_contact`, default on; `share_email`, default off) — `memberCardColumns` applies both,
 * so neither can leak through this route (design §3.3). The switches apply to the viewer's own
 * card as well: this page tells them what members here see, so it must not show more. `sessions` are only the sessions they
 * host in THIS gathering, and only those the viewer may already see on the sessions pages:
 * approved or scheduled, or the viewer's own.
 */
export const dynamic = 'force-dynamic'

const ANY_ROLE: readonly EventRoleName[] = ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee']

export interface HostedSession {
  id: string
  title: string
  status: string
  start_time: string | null
  venue_name: string | null
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string; did: string }> }) {
  const { slug, did: rawDid } = await params
  const access = await requireEventRole(request, slug, ANY_ROLE)
  if (access instanceof Response) return access
  const { viewer, event } = access

  const did = decodeDidParam(rawDid)
  const notFound = () => jsonError(404, 'Member not found')
  if (!isDid(did)) return notFound()

  const [member] = await sql<Participant[]>`
    select ${memberCardColumns(sql`m.share_contact`, sql`m.share_email`)},
      m.role, m.joined_at, (m.user_id = ${viewer.accountId}) as is_self
    from event_members m
    join accounts a on a.id = m.user_id
    join profiles p on p.id = m.user_id
    where m.event_id = ${event.id}
      and a.did = ${did}
      and (m.directory_listing or m.user_id = ${viewer.accountId})
  `
  if (!member) return notFound()

  const sessions = await sql<HostedSession[]>`
    select s.id, s.title, s.status,
           coalesce(ts.start_time, case when s.is_self_hosted then s.self_hosted_start_time end) as start_time,
           v.name as venue_name
    from sessions s
    left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
    left join venues v on v.id = s.venue_id and v.event_id = s.event_id
    where s.event_id = ${event.id}
      and s.host_id = ${member.id}
      and s.author_inactive_at is null
      and s.proposal_withdrawn_at is null
      and (s.status in ('approved', 'scheduled') or s.host_id = ${viewer.accountId})
    order by coalesce(ts.start_time, s.self_hosted_start_time) asc nulls last, lower(s.title)
    limit 100
  `

  return NextResponse.json({ member, sessions }, { headers: NO_STORE })
}
