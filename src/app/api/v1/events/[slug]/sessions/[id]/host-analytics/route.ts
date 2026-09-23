/**
 * `GET /api/v1/events/[slug]/sessions/[id]/host-analytics` — what a host may know about their
 * own session (PRD §3.2).
 *
 * The host, their accepted co-hosts, and the gathering's organizers. Nobody else, because
 * every number here is about other people's behaviour in aggregate and the aggregate is only
 * safe at the size the gathering's own k says it is.
 *
 * What it returns, and what it refuses:
 *   · RSVP, waitlist and saved ("favourite") counts — forward-looking co-presence, so counts
 *     only, never names (spec §9: `sp_rsvp` is "a forward-looking co-presence graph").
 *   · The session's entry in the k-suppressed tally, and only after the round is finalized. A
 *     round still open answers `tally: null` with `sealed: true`: no count leaves the database
 *     while voting is running, organizers included (spec §5.3).
 *   · The k-suppressed feedback summary, which is already anonymous even to organizers.
 */
import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { requireViewer, eventRole } from '@/lib/auth/viewer'
import { isAdminRole } from '@/lib/permissions'
import { eventK, publicTally, RoundOpenError } from '@/lib/voting'
import { feedbackSummary } from '@/lib/voting/feedback'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const [row] = await sql<{ event_id: string; host_id: string | null; is_cohost: boolean; rsvps: number; waitlist: number; favorites: number }[]>`
    select s.event_id, s.host_id,
           exists (select 1 from session_cohosts c where c.session_id = s.id and c.user_id = ${viewer.accountId} and c.cohost_inactive_at is null) as is_cohost,
           (select count(*)::int from session_rsvps r where r.session_id = s.id and r.status = 'confirmed') as rsvps,
           (select count(*)::int from session_rsvps r where r.session_id = s.id and r.status = 'waitlist') as waitlist,
           (select count(*)::int from favorites f where f.session_id = s.id) as favorites
    from sessions s join events e on e.id = s.event_id
    where s.id = ${id} and e.slug = ${slug}
  `
  if (!row) return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: NO_STORE })

  const role = await eventRole(row.event_id, viewer.accountId)
  const mine = row.host_id === viewer.accountId || row.is_cohost
  const organizer = role ? isAdminRole(role) || role === 'moderator' : false
  if (!mine && !organizer) return NextResponse.json({ error: 'Session not found' }, { status: 404, headers: NO_STORE })

  const k = await eventK(row.event_id)

  let tally: { voters: number; votes: number; credits: number } | null = null
  let sealed = false
  try {
    const published = await publicTally(row.event_id, k)
    const entry = published?.entries.find((e) => e.sessionId === id)
    if (entry && !entry.suppressed) tally = { voters: entry.voters, votes: entry.votes, credits: entry.credits }
  } catch (e) {
    if (e instanceof RoundOpenError) sealed = true
    else throw e
  }

  const feedback = await feedbackSummary(id, k)

  return NextResponse.json(
    {
      sessionId: id,
      k,
      rsvps: row.rsvps,
      waitlist: row.waitlist,
      favorites: row.favorites,
      /** Null while the round is open (`sealed`), and null when fewer than k people voted for it. */
      tally,
      sealed,
      feedback,
    },
    { headers: NO_STORE },
  )
}
