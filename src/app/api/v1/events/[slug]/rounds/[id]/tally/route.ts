/**
 * GET /api/v1/events/[slug]/rounds/[id]/tally
 *
 * The public, k-suppressed tally of a finalized round (spec §5.3 step 5):
 *   { round, k, ballotsCast, entries: [{ sessionId, suppressed: true } |
 *     { sessionId, suppressed: false, voters, votes, credits }], sessions: { [id]: { title, format } } }
 * 409 { error: 'RoundOpen' } until the round is finalized — for everyone, organizers included.
 * Entries are ordered by session id: the tally asserts no rank.
 */
import { sql } from '@/lib/db'
import { publicTally } from '@/lib/voting'
import { errorResponse, json, jsonError, resolveEvent } from '@/lib/voting/http'

export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ slug: string; id: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const resolved = await resolveEvent(request, slug)
  if (resolved instanceof Response) return resolved
  try {
    const tally = await publicTally(resolved.event.id, undefined, { roundId: id })
    if (!tally) return jsonError(404, 'Voting round not found')
    const ids = tally.entries.map((e) => e.sessionId)
    const rows = ids.length
      ? await sql<{ id: string; title: string; format: string | null }[]>`
          select id, title, format from sessions
          where event_id = ${resolved.event.id} and id in ${sql(ids)}
            and status in ('approved', 'scheduled')
        `
      : []
    const sessions = Object.fromEntries(rows.map((r) => [r.id, { title: r.title, format: r.format }]))
    return json({ ...tally, sessions })
  } catch (e) {
    return errorResponse(e, 'rounds/tally')
  }
}
