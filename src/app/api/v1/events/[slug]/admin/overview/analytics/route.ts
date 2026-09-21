/**
 * GET /api/v1/events/[slug]/admin/overview/analytics — organizer-only program analytics.
 *
 * Program shape (status, tracks, formats, rooms, roles) is always available. Voting results
 * are sealed while a round is open — not only for attendees, for organizers too (spec §5.3) —
 * and come from `organizerResults` (package C) once it has closed. Counts are the round's own
 * results; there is no leaderboard beyond the organizer's private sort.
 */
import { sql } from '@/lib/db'
import { organizerResults, publicTally, roundState, RoundOpenError } from '@/lib/voting'
import { errorResponse, json, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('viewAnalytics')

/**
 * The attendance round (design §11) for the analytics page. Sealed while open — like the
 * pre-event round — and, once closed, the k-suppressed tally rather than raw sums: the
 * "attendance signal" is a public-shaped artifact even on the organizer page. Sessions
 * that were never scheduled are left out (they could not take an attendance vote).
 */
type AttendanceAnalytics =
  | { enabled: boolean; status: 'none' | 'upcoming' | 'open'; sealed: true; closesAt: string | null }
  | {
      enabled: boolean
      status: 'closed'
      sealed: false
      k: number
      ballotsCast: number
      credits: number
      closedAt: string | null
      entries: Array<{ sessionId: string; title: string; suppressed: true } | { sessionId: string; title: string; suppressed: false; voters: number; votes: number; credits: number }>
    }

async function attendanceAnalytics(
  eventId: string,
  enabled: boolean,
  sessions: Array<{ id: string; title: string; time_slot_id: string | null }>,
): Promise<AttendanceAnalytics> {
  const state = await roundState(eventId, 'attendance')
  if (state.status !== 'closed') {
    return { enabled, status: state.status, sealed: true, closesAt: state.round?.closesAt ?? null }
  }
  const tally = await publicTally(eventId, undefined, { phase: 'attendance' })
  if (!tally) return { enabled, status: 'none', sealed: true, closesAt: null }
  const scheduled = new Map(sessions.filter((s) => s.time_slot_id).map((s) => [s.id, s.title]))
  return {
    enabled,
    status: 'closed',
    sealed: false,
    k: tally.k,
    ballotsCast: tally.ballotsCast,
    credits: tally.round.credits,
    closedAt: tally.round.finalizedAt,
    entries: tally.entries
      .filter((e) => scheduled.has(e.sessionId))
      .map((e) =>
        e.suppressed
          ? { sessionId: e.sessionId, title: scheduled.get(e.sessionId) ?? '', suppressed: true as const }
          : { sessionId: e.sessionId, title: scheduled.get(e.sessionId) ?? '', suppressed: false as const, voters: e.voters, votes: e.votes, credits: e.credits },
      ),
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const eventId = ctx.event.id

  try {
    const [sessions, tracks, venues, slots, roles, round] = await Promise.all([
      sql<{ id: string; title: string; status: string; format: string | null; track_id: string | null; venue_id: string | null; time_slot_id: string | null }[]>`
        select id, title, status, format, track_id, venue_id, time_slot_id from sessions where event_id = ${eventId}
      `,
      sql<{ id: string; name: string; color: string | null }[]>`
        select id, name, color from tracks where event_id = ${eventId} order by display_order, name
      `,
      sql<{ id: string; name: string; capacity: number | null }[]>`
        select id, name, capacity from venues where event_id = ${eventId} order by is_primary desc, name
      `,
      sql<{ venue_id: string | null }[]>`
        select venue_id from time_slots where event_id = ${eventId} and not coalesce(is_break, false)
      `,
      sql<{ role: string; count: number }[]>`
        select role, count(*)::int as count from event_members where event_id = ${eventId} group by role
      `,
      roundState(eventId),
    ])
    const [settings] = await sql<{ attendance_voting_enabled: boolean }[]>`
      select attendance_voting_enabled from events where id = ${eventId}
    `
    const attendance = await attendanceAnalytics(eventId, !!settings?.attendance_voting_enabled, sessions)

    const byStatus = { pending: 0, approved: 0, rejected: 0, scheduled: 0 }
    const byFormat = new Map<string, number>()
    const byTrack = new Map<string | null, number>()
    for (const s of sessions) {
      if (s.status in byStatus) byStatus[s.status as keyof typeof byStatus]++
      if (s.format) byFormat.set(s.format, (byFormat.get(s.format) ?? 0) + 1)
      byTrack.set(s.track_id, (byTrack.get(s.track_id) ?? 0) + 1)
    }
    const scheduled = sessions.filter((s) => s.status === 'scheduled' && s.time_slot_id)
    const members = roles.reduce((sum, r) => sum + r.count, 0)

    let voting:
      | { status: string; sealed: true; closesAt: string | null; message: string }
      | { status: string; sealed: false; results: Array<{ sessionId: string; title: string; voters: number; votes: number; credits: number }> }
    if (round.status === 'open') {
      voting = {
        status: 'open',
        sealed: true,
        closesAt: round.round?.closesAt ?? null,
        message: 'Voting in progress — results are sealed until the round closes.',
      }
    } else {
      try {
        const titles = new Map(sessions.map((s) => [s.id, s.title]))
        const results = await organizerResults(eventId)
        voting = {
          status: round.status,
          sealed: false,
          results: results
            .filter((r) => titles.has(r.sessionId))
            .map((r) => ({ sessionId: r.sessionId, title: titles.get(r.sessionId) ?? '', voters: r.voters, votes: r.votes, credits: r.credits })),
        }
      } catch (e) {
        if (!(e instanceof RoundOpenError)) throw e
        voting = { status: 'open', sealed: true, closesAt: round.round?.closesAt ?? null, message: 'Voting in progress — results are sealed until the round closes.' }
      }
    }

    return json({
      proposals: {
        total: sessions.length,
        byStatus,
        approvalRate: sessions.length ? Math.round(((byStatus.approved + byStatus.scheduled) / sessions.length) * 100) : 0,
        byFormat: [...byFormat.entries()].map(([format, count]) => ({ format, count })).sort((a, b) => b.count - a.count),
        byTrack: [
          ...tracks.map((t) => ({ id: t.id, name: t.name, color: t.color, count: byTrack.get(t.id) ?? 0 })),
          ...(byTrack.get(null) ? [{ id: null, name: 'No track', color: null, count: byTrack.get(null) ?? 0 }] : []),
        ],
      },
      members: { total: members, byRole: Object.fromEntries(roles.map((r) => [r.role, r.count])) },
      schedule: {
        sessionSlots: slots.length,
        filledSlots: scheduled.length,
        utilization: slots.length ? Math.round((scheduled.length / slots.length) * 100) : 0,
        venues: venues.map((v) => {
          const venueSlots = slots.filter((s) => s.venue_id === v.id).length
          const venueSessions = scheduled.filter((s) => s.venue_id === v.id).length
          return {
            id: v.id,
            name: v.name,
            capacity: v.capacity,
            slots: venueSlots,
            sessions: venueSessions,
            utilization: venueSlots ? Math.round((venueSessions / venueSlots) * 100) : 0,
          }
        }),
      },
      voting,
      attendance,
    })
  } catch (e) {
    return errorResponse(e, 'analytics')
  }
}
