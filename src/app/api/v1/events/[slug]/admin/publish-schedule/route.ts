/**
 * Publish the schedule (spec §6: draft → publish).
 *   GET  /api/v1/events/[slug]/admin/publish-schedule   publish status and what changed since
 *   POST /api/v1/events/[slug]/admin/publish-schedule   publish
 *
 * POST, in one transaction: stamp `events.schedule_published_at`; tell every member the
 * schedule is live (`schedule_published`); record each session's published slot (hosts already
 * heard about their placements when they were made). The response summarises what changed
 * since the previous publish. After commit, when
 * the gathering has an actor, package F's `publishSchedule` writes the calendar event, config
 * and slot records; the per-record results are returned. A network failure never undoes the
 * app-side publish — it is reported so the organizer can retry.
 */
import { sql, tx, type Sql } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { errorResponse, json, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { loadEvent } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')

interface ChangeRow {
  id: string
  title: string
  status: string
  time_slot_id: string | null
  published_slot_id: string | null
}

function classify(rows: ChangeRow[]) {
  const added = rows.filter((r) => r.status === 'scheduled' && r.time_slot_id && !r.published_slot_id)
  const moved = rows.filter((r) => r.status === 'scheduled' && r.time_slot_id && r.published_slot_id && r.time_slot_id !== r.published_slot_id)
  const removed = rows.filter((r) => r.published_slot_id && (r.status !== 'scheduled' || !r.time_slot_id))
  return { added, moved, removed }
}

async function changeRows(eventId: string, db: Sql = sql) {
  return db<ChangeRow[]>`
    select id, title, status, time_slot_id, published_slot_id
    from sessions
    where event_id = ${eventId}
      and ((status = 'scheduled' and time_slot_id is distinct from published_slot_id)
        or (published_slot_id is not null and (status <> 'scheduled' or time_slot_id is null)))
  `
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const [event, rows, [counts]] = await Promise.all([
      loadEvent(ctx.event.id),
      changeRows(ctx.event.id),
      sql<{ scheduled: number; network_published: number }[]>`
        select count(*) filter (where status = 'scheduled' and time_slot_id is not null)::int as scheduled,
               count(*) filter (where calendar_event_uri is not null and slot_uri is not null and cancelled_at is null)::int as network_published
        from sessions where event_id = ${ctx.event.id}
      `,
    ])
    const { added, moved, removed } = classify(rows)
    return json({
      schedulePublishedAt: event.schedule_published_at,
      lastScheduleChangeAt: event.last_schedule_change_at,
      hasUnpublishedChanges: rows.length > 0,
      scheduledSessions: counts.scheduled,
      networkPublishedSessions: counts.network_published,
      networkLinked: Boolean(event.actor_did),
      changes: {
        added: added.map((r) => ({ id: r.id, title: r.title })),
        moved: moved.map((r) => ({ id: r.id, title: r.title })),
        removed: removed.map((r) => ({ id: r.id, title: r.title })),
      },
    })
  } catch (e) {
    return errorResponse(e, 'publish status')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const eventId = ctx.event.id

  try {
    const committed = await tx(async (t) => {
      // Serialize concurrent publishes of the same event.
      const [event] = await t<{ name: string; slug: string; actor_did: string | null }[]>`
        select name, slug, actor_did from events where id = ${eventId} for update
      `
      const rows = await changeRows(eventId, t)
      const { added, moved, removed } = classify(rows)
      const [{ scheduled }] = await t<{ scheduled: number }[]>`
        select count(*)::int as scheduled from sessions
        where event_id = ${eventId} and status = 'scheduled' and time_slot_id is not null
      `
      const publishedAt = new Date().toISOString()
      await t`update events set schedule_published_at = ${publishedAt} where id = ${eventId}`

      const members = await t<{ user_id: string }[]>`select user_id from event_members where event_id = ${eventId}`
      const membersNotified = await notify(t, {
        eventId,
        userIds: members.map((m) => m.user_id),
        type: 'schedule_published',
        title: `The schedule for ${event.name} is live`,
        body: `${scheduled} session${scheduled === 1 ? ' is' : 's are'} on the schedule. Plan your days and add favorites.`,
        actionUrl: `/e/${event.slug}/schedule`,
        data: { scheduled_sessions: scheduled },
      })

      await t`
        update sessions
        set published_slot_id = case when status = 'scheduled' then time_slot_id else null end
        where event_id = ${eventId}
          and published_slot_id is distinct from (case when status = 'scheduled' then time_slot_id else null end)
      `
      return {
        publishedAt,
        scheduled,
        actorDid: event.actor_did,
        changes: { added: added.length, moved: moved.length, removed: removed.length },
        notified: { members: membersNotified },
      }
    })

    let network:
      | { attempted: false }
      | { attempted: true; published: number; failed: number; skipped: number; results: Array<{ kind: string; id: string; uri?: string; error?: string }>; error?: string }
      = { attempted: false }
    if (committed.actorDid) {
      try {
        const { publishSchedule } = await import('@/lib/atproto/publish')
        const { results } = await publishSchedule({ eventId, callerUserId: ctx.viewer.accountId })
        const failedIds = new Set(results.filter((r) => r.error).map((r) => r.id))
        const skipped = results.filter((r) => r.skipped)
        const publishedIds = new Set(results.filter((r) => r.kind === 'slot' && !r.error && !r.skipped).map((r) => r.id))
        for (const id of failedIds) publishedIds.delete(id)
        network = {
          attempted: true,
          published: publishedIds.size,
          failed: failedIds.size,
          skipped: skipped.length,
          results: results.map((r) => ({
            kind: r.kind,
            id: r.id,
            uri: r.uri,
            error: r.error ?? (r.skipped === 'requires-approval'
              ? 'Moved since it was published: move it in the schedule builder, which asks for approvals'
              : r.skipped === 'proposal-withdrawn'
                ? 'The proposer withdrew this proposal: cancel the session or fill its slot'
                : r.skipped ? `Skipped (${r.skipped})` : undefined),
          })),
        }
      } catch (e) {
        console.error('[publish-schedule] network publish failed:', e instanceof Error ? e.message : e)
        network = {
          attempted: true,
          published: 0,
          failed: 0,
          skipped: 0,
          results: [],
          error: 'The schedule is published here, but the network copy could not be written. Retry the publish.',
        }
      }
    }

    return json({
      success: true,
      publishedAt: committed.publishedAt,
      scheduledSessions: committed.scheduled,
      changes: committed.changes,
      notified: committed.notified,
      network,
      message: `Schedule published with ${committed.scheduled} scheduled session${committed.scheduled === 1 ? '' : 's'}`,
    })
  } catch (e) {
    return errorResponse(e, 'publish schedule')
  }
}
