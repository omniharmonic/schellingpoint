import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, getViewer, requireViewer } from '@/lib/auth/viewer'
import { isHiddenEvent, joinBlock } from '@/lib/events'
import { proposalQuota } from '@/lib/sessions/quota'
import { leaveGathering } from '@/lib/members/leave'
import type { EventRoleName } from '@/types/event'

/**
 * The signed-in viewer's standing in one gathering (EventContext's only server call).
 *
 *   GET  → { role, member, voteCredits, joinable, proposals }   read-only; never creates membership
 *   POST → explicitly join as an attendee (same-origin, signed-in); idempotent
 *            201 joined · 200 already a member
 *            404 private/draft (invitations only; existence not disclosed)
 *            409 { code: 'TicketRequired', ticketsUrl } when a paid ticket tier applies
 *            409 { code: 'NotJoinable' } for archived gatherings
 *            409 { code: 'ConductAcceptanceRequired', codeOfConductUrl } until `{ acceptConduct: true }`
 *   DELETE → leave the gathering (same-origin, signed-in)
 *            200 left · 404 not a member · 409 { code: 'LastOwner' }
 *
 * Membership shows the roster and fellow members' contact fields (package G), so a page view
 * must never create it (spec §3, §8): joining is always a deliberate POST. It never raises a
 * role, and never opens a private gathering.
 */

const NO_STORE = { 'Cache-Control': 'private, no-store' }

interface EventLookup {
  id: string
  slug: string
  status: string
  visibility: string
  ticketing_enabled: boolean
  max_proposals_per_user: number | null
  code_of_conduct_url: string | null
  require_conduct_acceptance: boolean
}

async function lookup(slug: string): Promise<EventLookup | null> {
  const [event] = await sql<EventLookup[]>`
    select id, slug, status, visibility, ticketing_enabled, max_proposals_per_user,
           code_of_conduct_url, coalesce(require_conduct_acceptance, false) as require_conduct_acceptance
    from events where slug = ${slug}
  `
  return event ?? null
}

async function standing(eventId: string, accountId: string) {
  const [row] = await sql<{ role: EventRoleName; vote_credits: number | null; conduct_accepted_at: string | null }[]>`
    select role, vote_credits, conduct_accepted_at from event_members
    where event_id = ${eventId} and user_id = ${accountId}
  `
  return row ?? null
}

/** True when this member is the only owner: they may not leave until they hand the gathering over. */
async function isLastOwner(eventId: string, accountId: string, role: EventRoleName): Promise<boolean> {
  if (role !== 'owner') return false
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from event_members where event_id = ${eventId} and role = 'owner'
  `
  return (row?.n ?? 0) <= 1
}

const notFound = () => NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const [event, viewer] = await Promise.all([lookup(slug), getViewer(request)])
  if (!event) return notFound()
  const member = viewer ? await standing(event.id, viewer.accountId) : null
  if (isHiddenEvent(event) && !member) return notFound()
  const block = member ? null : await joinBlock(event)
  // The role matters: owners and admins are exempt from the cap in the trigger, so they must
  // read as uncapped here too.
  const proposals = viewer
    ? await proposalQuota(event.id, viewer.accountId, event.max_proposals_per_user, member?.role ?? null)
    : null
  return NextResponse.json(
    {
      role: member?.role ?? null,
      member: Boolean(member),
      voteCredits: member?.vote_credits ?? null,
      joinable: !member && block === null,
      joinBlockedBy: member ? null : block,
      proposals,
      codeOfConductUrl: event.code_of_conduct_url,
      conductAcceptanceRequired: event.require_conduct_acceptance,
      conductAcceptedAt: member?.conduct_accepted_at ?? null,
      // Whether "Leave this gathering" is offered: the last owner is refused, and the button
      // asks the server rather than guessing from the role.
      canLeave: Boolean(member) && viewer !== null && !(await isLastOwner(event.id, viewer.accountId, member!.role)),
    },
    { headers: NO_STORE },
  )
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { slug } = await params
  const event = await lookup(slug)
  if (!event) return notFound()

  let body: Record<string, unknown> = {}
  try {
    const raw = await request.text()
    if (raw) body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }

  const existing = await standing(event.id, viewer.accountId)
  if (existing) {
    return NextResponse.json(
      {
        role: existing.role, member: true, voteCredits: existing.vote_credits, joinable: false, joinBlockedBy: null,
        codeOfConductUrl: event.code_of_conduct_url, conductAcceptedAt: existing.conduct_accepted_at,
      },
      { headers: NO_STORE },
    )
  }

  const block = await joinBlock(event)
  if (block === 'hidden') return notFound()
  if (block === 'ticket-required') {
    return NextResponse.json(
      { error: 'This gathering admits people with a ticket. Get a ticket to join.', code: 'TicketRequired', ticketsUrl: `/e/${event.slug}/tickets` },
      { status: 409, headers: NO_STORE },
    )
  }
  if (block === 'archived') {
    return NextResponse.json({ error: 'This gathering is archived and no longer takes new members.', code: 'NotJoinable' }, { status: 409, headers: NO_STORE })
  }

  // A gathering may require accepting its own code of conduct before anyone joins (MT §12.19).
  // The acceptance is stamped on the membership row, in the same insert, so there is no state
  // in which somebody is a member without having accepted.
  const accepted = body.acceptConduct === true
  if (event.require_conduct_acceptance && !accepted) {
    return NextResponse.json(
      {
        error: 'Read and accept this gathering’s code of conduct to join.',
        code: 'ConductAcceptanceRequired',
        codeOfConductUrl: event.code_of_conduct_url,
      },
      { status: 409, headers: NO_STORE },
    )
  }

  // Credits stay null ("the gathering's default") so a later credit change still applies.
  const [row] = await sql<{ role: EventRoleName; vote_credits: number | null; conduct_accepted_at: string | null; inserted: boolean }[]>`
    insert into event_members (event_id, user_id, role, conduct_accepted_at)
    values (${event.id}, ${viewer.accountId}, 'attendee', ${accepted ? new Date() : null})
    on conflict (event_id, user_id) do update set role = event_members.role
    returning role, vote_credits, conduct_accepted_at, (xmax = 0) as inserted
  `
  return NextResponse.json(
    {
      role: row.role, member: true, voteCredits: row.vote_credits, joinable: false, joinBlockedBy: null,
      codeOfConductUrl: event.code_of_conduct_url, conductAcceptedAt: row.conduct_accepted_at,
    },
    { status: row.inserted ? 201 : 200, headers: NO_STORE },
  )
}

/**
 * DELETE — leave this gathering.
 *
 * The production bug this fixes: joining was a one-way door. Everything the departure means
 * lives in `leaveGathering` (spec §8), so a person leaving and an organizer removing them have
 * exactly the same consequences. The last owner is refused: hand the gathering over first.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { slug } = await params
  const event = await lookup(slug)
  if (!event) return notFound()

  const result = await leaveGathering(event.id, viewer.accountId)
  if (!result.ok) {
    if (result.reason === 'not-a-member') {
      return NextResponse.json({ error: 'You are not a member of this gathering.' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json(
      {
        error: 'You are the only owner of this gathering. Make someone else an owner before you leave.',
        code: 'LastOwner',
      },
      { status: 409, headers: NO_STORE },
    )
  }
  return NextResponse.json(
    {
      left: true,
      role: null,
      member: false,
      voteCredits: null,
      joinable: null,
      joinBlockedBy: null,
      rsvpsCancelled: result.rsvpsCancelled,
      cohostInvitesRevoked: result.cohostInvitesRevoked,
      proposalsKept: result.proposalsKept,
    },
    { headers: NO_STORE },
  )
}
