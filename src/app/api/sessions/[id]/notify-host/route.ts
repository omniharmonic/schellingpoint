/**
 * POST /api/sessions/[id]/notify-host — email one host that their session is on the published schedule.
 *
 * Organizers (owner, admin, moderator) of the session's event only. Idempotent: a host already
 * emailed is not emailed again.
 */
import { sql } from '@/lib/db'
import { sendMail } from '@/lib/auth/mail'
import { errorResponse, fail, isUuid, json, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { scheduledHostEmails } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('sendCommunications')

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) return fail(404, 'Session not found')
  try {
    const [session] = await sql<{ slug: string; host_notified_at: string | null; status: string }[]>`
      select e.slug, s.host_notified_at, s.status from sessions s join events e on e.id = s.event_id where s.id = ${id}
    `
    if (!session) return fail(404, 'Session not found')
    const ctx = await requireOrganizer(request, session.slug, ROLES)
    if (ctx instanceof Response) return ctx
    if (session.host_notified_at) return json({ sent: false, already_notified: true })
    if (session.status !== 'scheduled') return fail(409, 'The session is not scheduled')

    const { emails, skipped } = await scheduledHostEmails(sql, ctx.event.id, [id])
    const email = emails[0]
    if (!email) return fail(409, skipped[0]?.reason ?? 'Nothing to send', { skippable: true })
    const { delivered } = await sendMail({ to: email.to, subject: email.subject, text: email.text, html: email.html })
    await sql`update sessions set host_notified_at = now() where id = ${id} and event_id = ${ctx.event.id}`
    return json({ sent: true, delivered })
  } catch (e) {
    return errorResponse(e, 'notify host')
  }
}
