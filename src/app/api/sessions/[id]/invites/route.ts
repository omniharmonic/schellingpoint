import { sql, tx } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { sendMail } from '@/lib/auth/mail'
import { buildCohostInviteEmail } from '@/lib/email/notification-emails'
import { formatEventDateRange } from '@/lib/notifications/dispatch'
import { json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { loadManageContext } from '@/app/api/v1/sessions/_lib/manage'

/**
 * Co-host invitations (spec §4.2 double opt-in). An invitation is an opaque app-side token
 * that names nobody: whoever redeems it becomes a co-host by accepting, and only then does a
 * `schellingpoint.draft.cohost` appear — in the co-host's own repository.
 *
 * POST /api/sessions/[id]/invites — create a link (the proposer or an organizer)
 *   Body: `{ email? }`. With an address, the link is also emailed there, and — when that
 *   address already belongs to an account — a `cohost_invited` notification is written to
 *   that person's feed (inventory 4.3 / P2-2). The address is never stored: `emailed_at`
 *   records only that a link went out, so a pending invite still names nobody.
 * GET  /api/sessions/[id]/invites — pending links (the proposer or an organizer)
 */
type Params = { params: Promise<{ id: string }> }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function POST(request: Request, { params }: Params) {
  const { id } = await params
  const ctx = await loadManageContext(request, id)
  if (ctx instanceof Response) return ctx
  if (!ctx.canInvite) return jsonError(403, 'Only the proposer or an event organizer can create invite links')

  const body = (await request.json().catch(() => null)) as { email?: unknown } | null
  let email: string | null = null
  if (body && body.email !== undefined && body.email !== null && body.email !== '') {
    if (typeof body.email !== 'string') return jsonError(400, 'Enter an email address', { field: 'email' })
    email = body.email.trim().toLowerCase()
    if (email.length > 254 || !EMAIL.test(email)) return jsonError(400, 'That does not look like an email address', { field: 'email' })
  }

  const open = await sql<{ n: number }[]>`
    select count(*)::int as n from cohost_invites
    where session_id = ${id} and status = 'pending' and expires_at > now()
  `
  if ((open[0]?.n ?? 0) >= 10) return jsonError(409, 'This session already has 10 open invite links. Revoke one first.')

  // Does the address already belong to an account? The inviter is never told the answer:
  // that would turn this route into an oracle for "is this person here".
  const [account] = email
    ? await sql<{ id: string }[]>`
        select id from accounts where lower(email) = ${email} and email_verified_at is not null
      `
    : []

  const [event] = await sql<{
    name: string; slug: string; logo_url: string | null; start_date: string | null
    end_date: string | null; location_name: string | null
  }[]>`
    select name, slug, logo_url, start_date, end_date, location_name from events where id = ${ctx.access.event.id}
  `
  const [inviter] = await sql<{ display_name: string | null }[]>`
    select display_name from profiles where id = ${ctx.viewer.accountId}
  `

  // The row and the invitee's in-app notification are one transaction (plan §7.2); the mail
  // goes out after it commits, so an invitation that was never saved is never delivered.
  const invite = await tx(async (t) => {
    const [row] = await t<{ id: string; token: string; status: string; expires_at: string; created_at: string }[]>`
      insert into cohost_invites (session_id, event_id, created_by)
      values (${id}, ${ctx.access.event.id}, ${ctx.viewer.accountId})
      returning id, token, status, expires_at, created_at
    `
    if (account && account.id !== ctx.viewer.accountId) {
      await notify(t, {
        eventId: ctx.access.event.id,
        userIds: [account.id],
        type: 'cohost_invited',
        title: `You have been invited to co-host "${ctx.rel.title}"`,
        body: `${inviter?.display_name?.trim() || 'An organizer'} would like you to co-host this session at ${event?.name ?? 'a gathering'}. Nothing happens until you accept.`,
        actionUrl: `/invite/${row.token}`,
        data: { session_id: id, session_title: ctx.rel.title },
      })
    }
    return row
  })

  if (!email) return json({ ...invite, emailed: false }, { status: 201 })

  let emailed = false
  let deliveryNote: string | null = null
  try {
    const content = buildCohostInviteEmail({
      event: {
        name: event?.name ?? 'a gathering',
        slug: event?.slug ?? '',
        logoUrl: event?.logo_url ?? undefined,
        dateRange: formatEventDateRange(event?.start_date ?? null, event?.end_date ?? null),
        location: event?.location_name ?? undefined,
      },
      inviterName: inviter?.display_name ?? null,
      sessionTitle: ctx.rel.title,
      inviteToken: invite.token,
      expiresAt: invite.expires_at,
    })
    const { delivered } = await sendMail({ to: email, subject: content.subject, text: content.text, html: content.html })
    emailed = true
    if (!delivered) deliveryNote = 'Mail is not configured here; the invitation link was logged instead.'
    await sql`update cohost_invites set emailed_at = now() where id = ${invite.id}`
  } catch (e) {
    console.error('[cohost-invites] mail failed:', e instanceof Error ? e.name : 'error')
    deliveryNote = 'The email could not be sent. The link is still open — copy it and send it yourself.'
  }

  return json({ ...invite, emailed, deliveryNote }, { status: 201 })
}

export async function GET(request: Request, { params }: Params) {
  const { id } = await params
  const ctx = await loadManageContext(request, id)
  if (ctx instanceof Response) return ctx
  if (!ctx.canInvite) return jsonError(403, 'Forbidden')

  const invites = await sql<{ id: string; token: string; status: string; expires_at: string; created_at: string; emailed_at: string | null }[]>`
    select id, token, status, expires_at, created_at, emailed_at
    from cohost_invites
    where session_id = ${id} and event_id = ${ctx.access.event.id} and status = 'pending' and expires_at > now()
    order by created_at desc
  `
  return json({ invites })
}
