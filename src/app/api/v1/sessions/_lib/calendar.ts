import 'server-only'
/** Scheduled sessions as calendar entries (ICS downloads). */
import { sql } from '@/lib/db'
import { publicUrl } from '@/lib/atproto/config'
import { sessionToICSEvent, type ICSEvent } from '@/lib/calendar/ics'
import type { AccessEvent } from './access'

interface CalendarRow {
  id: string
  title: string
  description: string | null
  host_display_name: string | null
  start_time: string
  end_time: string
  is_self_hosted: boolean | null
  venue_name: string | null
  venue_address: string | null
  venue_locality: string | null
  venue_is_private_residence: boolean | null
}

function appUrl(): string {
  try {
    return publicUrl()
  } catch {
    return 'http://localhost:3001'
  }
}

/**
 * Scheduled sessions with a time, optionally limited to `sessionIds`. Locations follow the
 * public tier: a venue's address unless it is a private residence (locality only); a
 * self-hosted place is never put in a downloadable file.
 */
export async function scheduledCalendarEvents(event: AccessEvent, sessionIds?: string[]): Promise<ICSEvent[]> {
  if (sessionIds && sessionIds.length === 0) return []
  const rows = await sql<CalendarRow[]>`
    select s.id, s.title, s.description, hp.display_name as host_display_name,
           coalesce(ts.start_time, s.self_hosted_start_time) as start_time,
           coalesce(ts.end_time, s.self_hosted_end_time) as end_time,
           s.is_self_hosted, v.name as venue_name, v.address as venue_address, v.locality as venue_locality,
           v.is_private_residence as venue_is_private_residence
    from sessions s
    left join profiles hp on hp.id = s.host_id
    left join time_slots ts on ts.id = s.time_slot_id and ts.event_id = s.event_id
    left join venues v on v.id = s.venue_id and v.event_id = s.event_id
    where s.event_id = ${event.id}
      and s.status = 'scheduled'
      and not coalesce(s.hidden_by_moderation, false)
      and coalesce(ts.start_time, s.self_hosted_start_time) is not null
      and coalesce(ts.end_time, s.self_hosted_end_time) is not null
      ${sessionIds ? sql`and s.id in ${sql(sessionIds)}` : sql``}
    order by coalesce(ts.start_time, s.self_hosted_start_time) asc
  `
  const origin = appUrl()
  return rows.map((row) => {
    let location: string | null
    if (row.is_self_hosted) {
      location = 'Self-hosted — see the session page'
    } else {
      const address = row.venue_is_private_residence ? row.venue_locality : row.venue_address
      location = [row.venue_name || event.location_name, address || (row.venue_name ? null : event.location_address)]
        .filter(Boolean)
        .join(', ') || null
    }
    return sessionToICSEvent({
      id: row.id,
      title: row.title,
      description: row.description,
      hostLabel: row.host_display_name,
      startTime: row.start_time,
      endTime: row.end_time,
      location,
      eventSlug: event.slug,
    }, origin)
  })
}

/**
 * `disposition: 'inline'` is what a calendar client subscribing to the URL needs: it reads the
 * body rather than handing the browser a download. Everything else is unchanged.
 */
export function icsResponse(ics: string, filename: string, opts: { disposition?: 'attachment' | 'inline' } = {}): Response {
  const safe = filename.replace(/[\r\n"]/g, '').slice(0, 120) || 'schedule.ics'
  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `${opts.disposition ?? 'attachment'}; filename="${encodeURIComponent(safe)}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
