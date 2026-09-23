/**
 * Your gathering — the participant's home inside an event.
 *
 * Loaded on the server (no browser database access, plan §3): session counts, recently
 * approved proposals, the viewer's own proposals and saved sessions. Vote state comes
 * from `useVoting` in the client component. No vote counts are shown here, ever: there is
 * no leaderboard and no "top sessions" (spec §3 "attestations, not scores"; §5.3).
 */
import { notFound } from 'next/navigation'
import { sql } from '@/lib/db'
import { eventRole, getViewer } from '@/lib/auth/viewer'
import { DashboardClient, type DashboardData } from './DashboardClient'

export const dynamic = 'force-dynamic'

interface PageProps {
  params: Promise<{ slug: string }>
}

const ORGANIZER_ROLES = new Set(['owner', 'admin', 'moderator'])

export default async function DashboardPage({ params }: PageProps) {
  const { slug } = await params
  const [event] = await sql<{ id: string; status: string; visibility: string }[]>`
    select id, status, visibility from events where slug = ${slug}
  `
  if (!event) notFound()
  const viewer = await getViewer()
  const role = viewer ? await eventRole(event.id, viewer.accountId) : null
  if ((event.visibility === 'private' || event.status === 'draft') && !role) notFound()
  const isOrganizer = !!role && ORGANIZER_ROLES.has(role)

  const [counts] = await sql<{ public_sessions: number; scheduled: number; pending: number; members: number }[]>`
    select
      -- Hidden by moderation is out of the public counts as well as the public lists (0033).
      count(*) filter (where s.status in ('approved', 'scheduled') and not coalesce(s.hidden_by_moderation, false))::int as public_sessions,
      count(*) filter (where s.status = 'scheduled' and not coalesce(s.hidden_by_moderation, false))::int as scheduled,
      count(*) filter (where s.status = 'pending')::int as pending,
      (select count(*) from event_members m where m.event_id = ${event.id})::int as members
    from sessions s
    where s.event_id = ${event.id}
  `

  const recent = await sql<DashboardData['recentSessions']>`
    select s.id, s.title, s.format, s.status, s.created_at,
           p.display_name as host_display_name,
           case when t.id is null then null else json_build_object('name', t.name, 'color', t.color) end as track
    from sessions s
    left join profiles p on p.id = s.host_id
    left join tracks t on t.id = s.track_id and t.event_id = s.event_id
    where s.event_id = ${event.id} and s.status in ('approved', 'scheduled')
      -- Hidden by moderation: out of the listings, including this one (0033).
      and not coalesce(s.hidden_by_moderation, false)
    order by s.created_at desc
    limit 6
  `

  let mine: DashboardData['mySessions'] = []
  let favorites = 0
  if (viewer) {
    mine = await sql<DashboardData['mySessions']>`
      select s.id, s.title, s.description, s.format, s.status, s.created_at
      from sessions s
      where s.event_id = ${event.id}
        and (s.host_id = ${viewer.accountId}
          or exists (select 1 from session_cohosts c where c.session_id = s.id and c.user_id = ${viewer.accountId}))
      order by s.created_at desc
    `
    const [fav] = await sql<{ n: number }[]>`
      select count(*)::int as n from favorites where event_id = ${event.id} and user_id = ${viewer.accountId}
    `
    favorites = fav?.n ?? 0
  }

  const data: DashboardData = {
    stats: {
      sessions: counts?.public_sessions ?? 0,
      scheduled: counts?.scheduled ?? 0,
      pending: isOrganizer ? (counts?.pending ?? 0) : null,
      // The roster is members-only (0008); so is its size.
      participants: role ? (counts?.members ?? 0) : null,
    },
    recentSessions: recent,
    mySessions: mine,
    favorites,
    isOrganizer,
  }
  return <DashboardClient data={data} />
}
