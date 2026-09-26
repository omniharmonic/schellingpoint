/**
 * GET /api/v1/events/[slug]/next-up
 *
 * "Next for you" on Home (mobile shell design §3.2): the next session the viewer saved, or — with
 * nothing saved — the next one in the program, plus what is in session right now and whether any
 * feedback window is open (the "over" state's Feedback link).
 *
 * Every session here comes out of `listSessions`, so it has already been through the one R9 filter:
 * no vote counts (spec §5.3), no foreign DIDs, and a self-hosted place at the tier the caller is
 * entitled to — the exact point only for confirmed attendees, hosts and organizers, the coarse
 * ≈1 km point for everyone else. `live` counts sessions, never votes.
 */
import { sql } from '@/lib/db'
import { json, loadEventAccess } from '@/app/api/v1/sessions/_lib/access'
import { listSessions, type SessionView } from '@/app/api/v1/sessions/_lib/read'

export const dynamic = 'force-dynamic'

/** A session is "happening now" from 15 minutes before it starts until 15 minutes after it ends. */
const GRACE_MS = 15 * 60 * 1000

export interface NextUpSession {
  id: string
  title: string
  format: string | null
  startsAt: string
  endsAt: string | null
  /** Room name, "Self-hosted", or null when neither is known. */
  room: string | null
  /** Whole postal address for the directions link, at the caller's tier; null when there is none. */
  directionsQuery: string | null
  geo: { lat: number; lng: number } | null
  isSelfHosted: boolean
  /**
   * True when the only place this link can point at is the coarse ≈1 km point — a self-hosted
   * session with no written address, seen by someone who is not entitled to the exact one. Home
   * says "Directions to the area" then, because the pin is a neighbourhood, not a door.
   */
  coarseLocation: boolean
}

export interface NextUpResponse {
  publishedAt: string | null
  /** `saved` when it is one of the viewer's own, `program` when it is just the next thing on. */
  kind: 'saved' | 'program' | null
  next: NextUpSession | null
  /** Sessions in session right now, and how many of those the viewer saved. Not a vote count. */
  live: { total: number; saved: number }
  feedbackOpen: boolean
}

function when(session: SessionView): { start: string; end: string | null } | null {
  const start = session.time_slot?.start_time ?? (session.is_self_hosted ? session.self_hosted_start_time : null)
  const end = session.time_slot?.end_time ?? (session.is_self_hosted ? session.self_hosted_end_time : null)
  return start ? { start, end } : null
}

function serialize(session: SessionView): NextUpSession | null {
  const w = when(session)
  if (!w) return null
  return {
    id: session.id,
    title: session.title,
    format: session.format,
    startsAt: w.start,
    endsAt: w.end,
    room: session.is_self_hosted ? (session.public_place ?? 'Self-hosted') : (session.venue?.name ?? null),
    directionsQuery: session.is_self_hosted ? (session.custom_location ?? null) : (session.venue?.directions_query ?? null),
    geo: session.is_self_hosted
      ? session.location_geo
        ? { lat: session.location_geo.lat, lng: session.location_geo.lng }
        : null
      : (session.venue?.geo ?? null),
    isSelfHosted: session.is_self_hosted,
    coarseLocation:
      session.is_self_hosted && !session.custom_location && !!session.location_geo && !session.location_geo.exact,
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  const [row] = await sql<{ schedule_published_at: string | null }[]>`
    select schedule_published_at from events where id = ${access.event.id}
  `
  const publishedAt = row?.schedule_published_at ?? null

  const [program, saved] = await Promise.all([
    listSessions(access, { statuses: ['scheduled'], timed: true, sort: 'time' }),
    access.viewer ? listSessions(access, { favorites: true, timed: true, sort: 'time' }) : Promise.resolve([]),
  ])

  const now = Date.now()
  const upcoming = (rows: SessionView[]) =>
    rows
      .map((s) => ({ s, w: when(s) }))
      .filter((r): r is { s: SessionView; w: { start: string; end: string | null } } => !!r.w)
      .filter((r) => new Date(r.w.start).getTime() + GRACE_MS >= now)
      .sort((a, b) => a.w.start.localeCompare(b.w.start))[0] ?? null

  const savedNext = upcoming(saved)
  const programNext = savedNext ? null : upcoming(program)
  const chosen = savedNext ?? programNext
  const kind: NextUpResponse['kind'] = savedNext ? 'saved' : programNext ? 'program' : null

  const isLive = (s: SessionView) => {
    const w = when(s)
    if (!w) return false
    const start = new Date(w.start).getTime()
    const end = w.end ? new Date(w.end).getTime() : start + 60 * 60 * 1000
    return now >= start - GRACE_MS && now <= end + GRACE_MS
  }
  const savedLive = saved.filter(isLive)
  const liveTotal = new Set([...program.filter(isLive).map((s) => s.id), ...savedLive.map((s) => s.id)]).size

  // Any open feedback window in this gathering, so Home can offer "Feedback" once it is over.
  // A window opens when a session starts and closes FEEDBACK_WINDOW_HOURS after it ends; the count
  // of them is not a rating and not a tally.
  const [open] = await sql<{ any: boolean }[]>`
    select exists (
      select 1 from feedback_windows w
      where w.event_id = ${access.event.id} and w.finalized_at is null
        and w.opens_at <= now() and w.closes_at > now()
    ) as any
  `

  const body: NextUpResponse = {
    publishedAt,
    kind: chosen ? kind : null,
    next: chosen ? serialize(chosen.s) : null,
    live: { total: liveTotal, saved: savedLive.length },
    feedbackOpen: !!open?.any,
  }
  return json(body)
}
