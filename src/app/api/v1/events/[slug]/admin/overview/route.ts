/**
 * GET /api/v1/events/[slug]/admin/overview — the organizer home.
 *
 * Counts by status, schedule progress, proposals awaiting review, and sessions the network
 * flagged (the proposer edited a scheduled proposal, or withdrew it). No vote numbers, ever:
 * results live on the analytics view, and only after the round closes (spec §5.3).
 */
import { sql } from '@/lib/db'
import { roundState } from '@/lib/voting'
import { errorResponse, json, requireOrganizer, rolesWithAny } from '@/lib/scheduling/admin-api'
import { loadEvent } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWithAny('approveProposals', 'manageSchedule')

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const eventId = ctx.event.id

  try {
    const [event, statusRows, scheduleRows, pending, flagged, round] = await Promise.all([
      loadEvent(eventId),
      sql<{ status: string; count: number }[]>`
        select status, count(*)::int as count from sessions where event_id = ${eventId} group by status
      `,
      sql<{ venues: number; session_slots: number; filled_slots: number; unpublished_changes: number }[]>`
        select
          (select count(*)::int from venues where event_id = ${eventId}) as venues,
          (select count(*)::int from time_slots
             where event_id = ${eventId} and not coalesce(is_break, false) and venue_id is not null) as session_slots,
          (select count(*)::int from sessions
             where event_id = ${eventId} and status = 'scheduled' and time_slot_id is not null) as filled_slots,
          (select count(*)::int from sessions
             where event_id = ${eventId}
               and ((status = 'scheduled' and time_slot_id is distinct from published_slot_id)
                 or (published_slot_id is not null and (status <> 'scheduled' or time_slot_id is null)))) as unpublished_changes
      `,
      sql<{
        id: string; title: string; format: string | null; duration: number | null; created_at: string
        host_display_name: string | null; listed_host_name: string | null; imported_from: string | null
      }[]>`
        select s.id, s.title, s.format, s.duration, s.created_at,
               case when s.host_id is not null then p.display_name end as host_display_name,
               l.host_name as listed_host_name, s.imported_from
        from sessions s
        left join profiles p on p.id = s.host_id
        left join session_host_listings l on l.session_id = s.id and l.event_id = s.event_id
        where s.event_id = ${eventId} and s.status = 'pending'
        order by s.created_at asc
        limit 50
      `,
      sql<{
        id: string; title: string; status: string; proposal_drift_at: string | null
        proposal_withdrawn_at: string | null; network_published: boolean
      }[]>`
        select id, title, status, proposal_drift_at, proposal_withdrawn_at,
               (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null) as network_published
        from sessions
        where event_id = ${eventId} and (proposal_drift_at is not null or proposal_withdrawn_at is not null)
        order by greatest(proposal_drift_at, proposal_withdrawn_at) desc nulls last
      `,
      roundState(eventId),
    ])

    const counts = { pending: 0, approved: 0, rejected: 0, scheduled: 0, total: 0 }
    for (const row of statusRows) {
      if (row.status in counts) counts[row.status as keyof typeof counts] = row.count
      counts.total += row.count
    }
    const schedule = scheduleRows[0]

    return json({
      event: { id: event.id, slug: event.slug, name: event.name, status: event.status },
      counts,
      schedule: {
        venues: schedule.venues,
        sessionSlots: schedule.session_slots,
        filledSlots: schedule.filled_slots,
        unpublishedChanges: schedule.unpublished_changes,
        publishedAt: event.schedule_published_at,
        lastChangeAt: event.last_schedule_change_at,
      },
      pendingProposals: pending,
      flagged: flagged.map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        networkPublished: s.network_published,
        kind: s.proposal_withdrawn_at ? 'withdrawn' : 'cid_drift',
        at: s.proposal_withdrawn_at ?? s.proposal_drift_at,
        message: s.proposal_withdrawn_at
          ? 'The proposer withdrew this proposal. Cancel the session or fill its slot; their record cannot be restored.'
          : 'The proposer edited this session after it was scheduled. Review the change and re-publish.',
      })),
      voting: {
        status: round.status,
        opensAt: round.round?.opensAt ?? null,
        closesAt: round.round?.closesAt ?? null,
      },
      network: { linked: Boolean(event.actor_did), publishedAt: event.atproto_published_at },
    })
  } catch (e) {
    return errorResponse(e, 'overview')
  }
}
