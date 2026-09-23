/**
 * `GET /api/calendar/<token>` — one person's subscribable .ics feed (MT §12.8).
 *
 * The sessions they have saved, across every gathering they are still a member of, with a
 * 15-minute reminder on each and a refresh hint for the client. The token in the path is the
 * credential (a calendar client holds no cookie); it is read-only, revocable, and resolves to
 * exactly one account.
 *
 * Privacy: this is the person's own schedule and nobody else's. Locations follow the same
 * public tier as every other export — a private residence shows its locality, a self-hosted
 * place is never written into a file that leaves the app. Membership is re-checked on every
 * fetch, so leaving a gathering empties it from the feed at the client's next poll.
 */
import { sql } from '@/lib/db'
import { publicUrl } from '@/lib/atproto/config'
import { generateICS, sessionToICSEvent, type ICSEvent } from '@/lib/calendar/ics'
import { accountForFeedToken, FEED_REFRESH_INTERVAL } from '@/lib/calendar/feed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface FeedRow {
  session_id: string
  title: string
  description: string | null
  host_display_name: string | null
  start_time: string
  end_time: string
  is_self_hosted: boolean | null
  event_slug: string
  event_name: string
  event_location_name: string | null
  event_location_address: string | null
  venue_name: string | null
  venue_address: string | null
  venue_locality: string | null
  venue_is_private_residence: boolean | null
}

function appOrigin(): string {
  try {
    return publicUrl().replace(/\/+$/, '')
  } catch {
    return 'http://localhost:3001'
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const accountId = await accountForFeedToken(token)
  if (!accountId) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
  }

  const rows = await sql<FeedRow[]>`
    select s.id as session_id, s.title, s.description, hp.display_name as host_display_name,
           coalesce(ts.start_time, s.self_hosted_start_time) as start_time,
           coalesce(ts.end_time, s.self_hosted_end_time) as end_time,
           s.is_self_hosted,
           e.slug as event_slug, e.name as event_name,
           e.location_name as event_location_name, e.location_address as event_location_address,
           v.name as venue_name, v.address as venue_address, v.locality as venue_locality,
           v.is_private_residence as venue_is_private_residence
    from favorites f
    join sessions s on s.id = f.session_id
    join events e on e.id = s.event_id
    -- Membership is re-checked on every fetch: a feed never outlives the standing behind it.
    join event_members m on m.event_id = e.id and m.user_id = ${accountId}
    left join profiles hp on hp.id = s.host_id
    left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
    left join venues v on v.id = s.venue_id and v.event_id = s.event_id
    where f.user_id = ${accountId}
      and s.status = 'scheduled'
      and not coalesce(s.hidden_by_moderation, false)
      and coalesce(ts.start_time, s.self_hosted_start_time) is not null
      and coalesce(ts.end_time, s.self_hosted_end_time) is not null
    order by coalesce(ts.start_time, s.self_hosted_start_time) asc
    limit 2000
  `

  const origin = appOrigin()
  const events: ICSEvent[] = rows.map((row) => {
    const address = row.venue_is_private_residence ? row.venue_locality : row.venue_address
    const location = row.is_self_hosted
      ? 'Self-hosted — see the session page'
      : [row.venue_name || row.event_location_name, address || (row.venue_name ? null : row.event_location_address)]
          .filter(Boolean)
          .join(', ') || null
    const entry = sessionToICSEvent(
      {
        id: row.session_id,
        title: row.title,
        description: row.description,
        hostLabel: row.host_display_name,
        startTime: row.start_time,
        endTime: row.end_time,
        location,
        eventSlug: row.event_slug,
      },
      origin,
    )
    return { ...entry, title: `${row.title} · ${row.event_name}` }
  })

  const ics = generateICS({
    name: 'My unconference schedule',
    description: 'The sessions you saved, across every gathering you belong to. Updates on its own.',
    refreshInterval: FEED_REFRESH_INTERVAL,
    source: `${origin}/api/calendar/${token}`,
    events,
  })

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="my-unconference-schedule.ics"',
      // A subscription URL is a credential: never let a shared cache hold the answer.
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
  })
}
