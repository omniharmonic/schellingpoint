/**
 * Announcements to every member.
 *   POST /api/v1/events/[slug]/admin/broadcast   { title, message, ctaUrl?, ctaText? }
 *   GET  /api/v1/events/[slug]/admin/broadcast   the ten most recent announcements
 *
 * Emits `admin_announcement` through `notify` (one feed row per member; package E's outbox
 * emails them according to each member's preferences). The sender is not recorded on the
 * recipients' rows.
 */
import { tx, sql } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { InputError, errorResponse, json, readBody, requireOrganizer, rolesWith, text } from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('sendCommunications')

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    const title = text(body, 'title', { required: true, max: 100, label: 'Title' })!
    const message = text(body, 'message', { required: true, max: 1000, label: 'Message' })!
    const ctaUrl = text(body, 'ctaUrl', { max: 500, label: 'Link' })
    const ctaText = text(body, 'ctaText', { max: 30, label: 'Link text' })
    if (ctaUrl && !(ctaUrl.startsWith('/') && !ctaUrl.startsWith('//')) && !/^https:\/\/[^\s]+$/i.test(ctaUrl)) {
      throw new InputError('Links must start with https:// or be a path on this site (/e/…)', 'ctaUrl')
    }

    const sent = await tx(async (t) => {
      const members = await t<{ user_id: string }[]>`
        select user_id from event_members where event_id = ${ctx.event.id} and user_id <> ${ctx.viewer.accountId}
      `
      return notify(t, {
        eventId: ctx.event.id,
        userIds: members.map((m) => m.user_id),
        type: 'admin_announcement',
        title,
        body: message,
        actionUrl: ctaUrl ?? `/e/${ctx.event.slug}`,
        data: ctaText ? { cta_text: ctaText } : {},
      })
    })
    return json({
      success: true,
      sent,
      message: sent === 0 ? 'There are no other members to notify yet' : `Announcement sent to ${sent} member${sent === 1 ? '' : 's'}`,
    })
  } catch (e) {
    return errorResponse(e, 'broadcast')
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const broadcasts = await sql<{ title: string; body: string | null; action_url: string | null; created_at: string; recipients: number }[]>`
      select title, body, action_url, min(created_at) as created_at, count(*)::int as recipients
      from notifications
      where event_id = ${ctx.event.id} and type = 'admin_announcement'
      group by title, body, action_url, date_trunc('minute', created_at)
      order by min(created_at) desc
      limit 10
    `
    return json({ broadcasts })
  } catch (e) {
    return errorResponse(e, 'broadcast history')
  }
}
