import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, getViewer, requireViewer } from '@/lib/auth/viewer'
import { isHiddenEvent, joinBlock } from '@/lib/events'
import type { EventRoleName } from '@/types/event'

/**
 * The signed-in viewer's standing in one gathering (EventContext's only server call).
 *
 *   GET  → { role, member, voteCredits, joinable }   read-only; never creates membership
 *   POST → explicitly join as an attendee (same-origin, signed-in); idempotent
 *            201 joined · 200 already a member
 *            404 private/draft (invitations only; existence not disclosed)
 *            409 { code: 'TicketRequired', ticketsUrl } when a paid ticket tier applies
 *            409 { code: 'NotJoinable' } for archived gatherings
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
}

async function lookup(slug: string): Promise<EventLookup | null> {
  const [event] = await sql<EventLookup[]>`
    select id, slug, status, visibility, ticketing_enabled from events where slug = ${slug}
  `
  return event ?? null
}

async function standing(eventId: string, accountId: string) {
  const [row] = await sql<{ role: EventRoleName; vote_credits: number | null }[]>`
    select role, vote_credits from event_members where event_id = ${eventId} and user_id = ${accountId}
  `
  return row ?? null
}

const notFound = () => NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const [event, viewer] = await Promise.all([lookup(slug), getViewer(request)])
  if (!event) return notFound()
  const member = viewer ? await standing(event.id, viewer.accountId) : null
  if (isHiddenEvent(event) && !member) return notFound()
  const block = member ? null : await joinBlock(event)
  return NextResponse.json(
    {
      role: member?.role ?? null,
      member: Boolean(member),
      voteCredits: member?.vote_credits ?? null,
      joinable: !member && block === null,
      joinBlockedBy: member ? null : block,
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

  const existing = await standing(event.id, viewer.accountId)
  if (existing) {
    return NextResponse.json(
      { role: existing.role, member: true, voteCredits: existing.vote_credits, joinable: false, joinBlockedBy: null },
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

  // Credits stay null ("the gathering's default") so a later credit change still applies.
  const [row] = await sql<{ role: EventRoleName; vote_credits: number | null; inserted: boolean }[]>`
    insert into event_members (event_id, user_id, role)
    values (${event.id}, ${viewer.accountId}, 'attendee')
    on conflict (event_id, user_id) do update set role = event_members.role
    returning role, vote_credits, (xmax = 0) as inserted
  `
  return NextResponse.json(
    { role: row.role, member: true, voteCredits: row.vote_credits, joinable: false, joinBlockedBy: null },
    { status: row.inserted ? 201 : 200, headers: NO_STORE },
  )
}
