/**
 * Session host emails.
 *   GET  /api/v1/events/[slug]/admin/session-emails   hosts on the published schedule not yet emailed
 *   POST /api/v1/events/[slug]/admin/session-emails   { action: 'notify-scheduled-hosts', sessionIds? }
 *
 * Approval and rejection emails are not sent from here: they are notifications, delivered by
 * package E's outbox according to each host's preferences.
 */
import { sql } from '@/lib/db'
import { sendMail } from '@/lib/auth/mail'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { scheduledHostEmails } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('sendCommunications')

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const [[counts], pending] = await Promise.all([
      sql<{ scheduled_total: number }[]>`
        select count(*)::int as scheduled_total from sessions where event_id = ${ctx.event.id} and status = 'scheduled'
      `,
      scheduledHostEmails(sql, ctx.event.id),
    ])
    return json({
      scheduled_total: counts.scheduled_total,
      scheduled_unnotified: pending.emails.length,
      scheduled_unnotified_sessions: pending.emails.map((e) => ({ id: e.sessionId, title: e.title })),
      skipped: pending.skipped,
    })
  } catch (e) {
    return errorResponse(e, 'session email stats')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body
  if (body.action !== 'notify-scheduled-hosts') return fail(400, 'Unknown action', { field: 'action' })
  const ids = body.sessionIds
  if (ids !== undefined && (!Array.isArray(ids) || !ids.every(isUuid))) return fail(400, 'sessionIds must be session ids', { field: 'sessionIds' })

  try {
    const { emails, skipped } = await scheduledHostEmails(sql, ctx.event.id, ids as string[] | undefined)
    let sent = 0
    let logged = 0
    const errors: string[] = []
    for (const email of emails) {
      try {
        const { delivered } = await sendMail({ to: email.to, subject: email.subject, text: email.text, html: email.html })
        if (delivered) sent++
        else logged++
        await sql`update sessions set host_notified_at = now() where id = ${email.sessionId} and event_id = ${ctx.event.id}`
      } catch (e) {
        console.error('[session-emails] send failed:', e instanceof Error ? e.message : e)
        errors.push('An email could not be sent; it stays queued for the next try.')
      }
    }
    return json({ sent, logged, skipped: skipped.length, skippedSessions: skipped, total: emails.length, errors: [...new Set(errors)] })
  } catch (e) {
    return errorResponse(e, 'notify scheduled hosts')
  }
}
