/**
 * PATCH /api/v1/events/[slug]/sessions/batch — review many sessions at once.
 *
 * Body: { action: 'approve' | 'reject' | 'assign_track' | 'delete', session_ids: uuid[], reason?, track_id? }
 *
 * Runs as the organizer's account (`asAccount`) so the session update rules and RLS apply at
 * the database boundary. Each host gets one notification per session whose status actually
 * changed (`session_approved` / `session_rejected`), written in the same transaction (plan §7.2).
 *
 *   approve       pending | rejected → approved
 *   reject        pending | approved → rejected (reason stored and sent to the host)
 *   assign_track  any status; track_id null clears it
 *   delete        owners/admins; refused for sessions already published on the network
 *                 (cancel those from the schedule builder — cancelling is destructive, spec §6)
 *
 * Sessions that cannot take the action are reported in `skipped` with a reason.
 */
import { asAccount } from '@/lib/db'
import { notify } from '@/lib/notifications'
import {
  InputError,
  errorResponse,
  fail,
  isUuid,
  json,
  readBody,
  requireOrganizer,
  rolesWith,
  text,
  uuidOrNull,
} from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const REVIEW_ROLES = rolesWith('approveProposals')
const DELETE_ROLES = rolesWith('manageSchedule')
const ACTIONS = ['approve', 'reject', 'assign_track', 'delete'] as const
type Action = (typeof ACTIONS)[number]
const MAX_IDS = 200

interface Skipped {
  id: string
  title: string
  reason: string
}

export async function PATCH(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, REVIEW_ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  const action = body.action as Action
  if (!ACTIONS.includes(action)) return fail(400, `action must be one of ${ACTIONS.join(', ')}`, { field: 'action' })
  if (action === 'delete' && !DELETE_ROLES.includes(ctx.role)) {
    return fail(403, 'Only owners and admins can delete sessions')
  }
  const ids = body.session_ids
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUuid)) {
    return fail(400, 'session_ids must be a non-empty list of session ids', { field: 'session_ids' })
  }
  if (ids.length > MAX_IDS) return fail(400, `At most ${MAX_IDS} sessions can be changed at once`, { field: 'session_ids' })
  const sessionIds = [...new Set(ids)]

  try {
    const reason = action === 'reject' ? text(body, 'reason', { max: 500, label: 'Reason' }) : null
    const trackId = action === 'assign_track' ? uuidOrNull(body, 'track_id', 'Track') : null
    const eventId = ctx.event.id
    const slugPath = `/e/${ctx.event.slug}/sessions`

    const outcome = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [event] = await tx<{ name: string }[]>`select name from events where id = ${eventId}`
      const rows = await tx<{ id: string; title: string; status: string; network_published: boolean }[]>`
        select id, title, status, (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null) as network_published
        from sessions
        where event_id = ${eventId} and id in ${tx(sessionIds)}
        for update
      `
      const found = new Set(rows.map((r) => r.id))
      const missing = sessionIds.filter((id) => !found.has(id))
      if (missing.length > 0) {
        throw new InputError('Some sessions were not found in this event', 'session_ids', 400, 'NotInEvent')
      }

      type Row = (typeof rows)[number]
      const skipped: Skipped[] = []
      let changed: Row[] = []

      if (action === 'approve') {
        changed = rows.filter((r) => r.status === 'pending' || r.status === 'rejected')
        for (const r of rows) if (!changed.includes(r)) skipped.push({ id: r.id, title: r.title, reason: `Already ${r.status}` })
        if (changed.length) {
          await tx`
            update sessions set status = 'approved', rejection_reason = null
            where event_id = ${eventId} and id in ${tx(changed.map((r) => r.id))}
          `
          const hosts = await tx<{ id: string; host_id: string | null }[]>`
            select id, host_id from sessions where event_id = ${eventId} and id in ${tx(changed.map((r) => r.id))}
          `
          const hostOf = new Map(hosts.map((h) => [h.id, h.host_id]))
          for (const r of changed) {
            await notify(tx, {
              eventId,
              userIds: [hostOf.get(r.id)],
              type: 'session_approved',
              title: 'Your session has been approved',
              body: `"${r.title}" has been approved for ${event.name}.`,
              actionUrl: `${slugPath}/${r.id}`,
              data: { session_id: r.id, session_title: r.title },
            })
          }
        }
      } else if (action === 'reject') {
        changed = rows.filter((r) => r.status === 'pending' || r.status === 'approved')
        for (const r of rows) {
          if (changed.includes(r)) continue
          skipped.push({
            id: r.id,
            title: r.title,
            reason: r.status === 'scheduled' ? 'Scheduled — remove it from the schedule first' : 'Already rejected',
          })
        }
        if (changed.length) {
          await tx`
            update sessions set status = 'rejected', rejection_reason = ${reason}
            where event_id = ${eventId} and id in ${tx(changed.map((r) => r.id))}
          `
          const hosts = await tx<{ id: string; host_id: string | null }[]>`
            select id, host_id from sessions where event_id = ${eventId} and id in ${tx(changed.map((r) => r.id))}
          `
          const hostOf = new Map(hosts.map((h) => [h.id, h.host_id]))
          for (const r of changed) {
            await notify(tx, {
              eventId,
              userIds: [hostOf.get(r.id)],
              type: 'session_rejected',
              title: 'Session not selected',
              body: `"${r.title}" was not selected for ${event.name}.${reason ? ` Reason: ${reason}` : ''}`,
              actionUrl: `${slugPath}/${r.id}`,
              data: { session_id: r.id, session_title: r.title, ...(reason ? { rejection_reason: reason } : {}) },
            })
          }
        }
      } else if (action === 'assign_track') {
        if (trackId) {
          const [track] = await tx`select id from tracks where id = ${trackId} and event_id = ${eventId}`
          if (!track) throw new InputError('That track does not belong to this event', 'track_id')
        }
        changed = rows
        await tx`
          update sessions set track_id = ${trackId}
          where event_id = ${eventId} and id in ${tx(rows.map((r) => r.id))}
        `
      } else {
        changed = rows.filter((r) => !r.network_published)
        for (const r of rows) {
          if (r.network_published) {
            skipped.push({ id: r.id, title: r.title, reason: 'Published on the network — cancel it from the schedule builder instead' })
          }
        }
        if (changed.length) {
          await tx`delete from sessions where event_id = ${eventId} and id in ${tx(changed.map((r) => r.id))}`
        }
      }

      return { affected: changed.map((r) => r.id), skipped }
    })

    const n = outcome.affected.length
    return json({
      success: true,
      action,
      affected: n,
      affectedIds: outcome.affected,
      skipped: outcome.skipped,
      message: `${action.replace('_', ' ')}: ${n} session${n === 1 ? '' : 's'} updated${outcome.skipped.length ? `, ${outcome.skipped.length} skipped` : ''}`,
    })
  } catch (e) {
    return errorResponse(e, `batch ${action}`)
  }
}
