import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { eventRole, requireViewer } from '@/lib/auth/viewer'

/**
 * Interest suggestions for the profile editor and onboarding.
 *
 *   GET /api/me/profile/interests?event=<slug>
 *     → { suggested: string[], existing: string[] }
 *
 * `suggested` is the organizers' `suggested_topics` for the named gathering (when the viewer may
 * see it) or, without `event`, for every gathering the viewer belongs to. `existing` is interests
 * already used by listed fellow members of the viewer's gatherings (scoped to `event` when the
 * viewer is a member of it), plus the viewer's own, most used first. Nothing from gatherings the
 * viewer does not belong to: profiles are members-only (spec §10).
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const LIMIT = 200

export async function GET(request: Request) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const slug = new URL(request.url).searchParams.get('event')?.trim() || null
  let scopeEventId: string | null = null
  let suggested: string[] = []

  if (slug) {
    const [event] = await sql<{ id: string; status: string | null; visibility: string | null; suggested_topics: string[] | null }[]>`
      select id, status, visibility, suggested_topics from events where slug = ${slug}
    `
    if (event) {
      const role = await eventRole(event.id, viewer.accountId)
      const visible = role !== null || (event.visibility !== 'private' && event.status !== 'draft')
      if (visible) suggested = event.suggested_topics ?? []
      if (role !== null) scopeEventId = event.id
    }
  } else {
    const rows = await sql<{ topic: string }[]>`
      select distinct t as topic
      from event_members m join events e on e.id = m.event_id, unnest(e.suggested_topics) t
      where m.user_id = ${viewer.accountId}
    `
    suggested = rows.map((r) => r.topic)
  }

  const existing = await sql<{ interest: string }[]>`
    with pool as (
      select p.id, i as interest
      from event_members mine
      join event_members theirs on theirs.event_id = mine.event_id
        and (theirs.directory_listing or theirs.user_id = ${viewer.accountId})
      join profiles p on p.id = theirs.user_id, unnest(p.interests) i
      where mine.user_id = ${viewer.accountId}
        and (${scopeEventId}::uuid is null or mine.event_id = ${scopeEventId}::uuid)
      union
      select p.id, i from profiles p, unnest(p.interests) i where p.id = ${viewer.accountId}
    )
    select min(interest) as interest
    from pool
    group by lower(interest)
    order by count(distinct id) desc, lower(interest)
    limit ${LIMIT}
  `

  const seen = new Set<string>()
  const dedupe = (list: string[]) =>
    list
      .map((s) => s.trim())
      .filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()))

  return NextResponse.json(
    { suggested: dedupe(suggested), existing: dedupe(existing.map((r) => r.interest)) },
    { headers: NO_STORE },
  )
}
