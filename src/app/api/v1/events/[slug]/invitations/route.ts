/**
 * Event invitations.
 *   GET  /api/v1/events/[slug]/invitations   open invitations (not revoked)
 *   POST /api/v1/events/[slug]/invitations   { emails?: string[], role, expiresInDays?, max_uses? }
 *
 * With `emails`: one single-use invitation per address. An address that already has an
 * account gets an in-app `event_invitation` notification (written in the same transaction);
 * an address without one gets the invitation by email. Without `emails`: a shareable link,
 * bounded by `max_uses` (required for elevated roles).
 *
 * The invite graph is the organizing graph (spec §9): invitations are app-side only, and the
 * retention job nulls the inviter 30 days after redemption.
 */
import { tx, sql } from '@/lib/db'
import { sendMail } from '@/lib/auth/mail'
import { buildEventInvitationEmail } from '@/lib/email/notification-emails'
import { appUrl } from '@/lib/email/base-template'
import { notify } from '@/lib/notifications'
import { errorResponse, fail, integer, json, readBody, requireOrganizer } from '@/lib/scheduling/admin-api'
import { formatEventDateRange } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = ['owner', 'admin'] as const
const INVITABLE_ROLES = ['attendee', 'volunteer', 'moderator', 'admin'] as const
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_EMAILS = 50

interface InvitationRow {
  id: string
  token: string
  email: string | null
  role: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
  max_uses: number | null
  use_count: number
  /** The inviter's display name or handle; null once retention has removed the inviter (spec §9). */
  invited_by?: string | null
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const invitations = await sql<InvitationRow[]>`
      select i.id, i.token, i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, i.max_uses, i.use_count,
             case when i.created_by is null then null
                  else coalesce(p.display_name, '@' || a.handle, 'An organizer') end as invited_by
      from event_invitations i
      left join accounts a on a.id = i.created_by
      left join profiles p on p.id = i.created_by
      where i.event_id = ${ctx.event.id} and i.revoked_at is null
      order by i.created_at desc
    `
    return json({ invitations })
  } catch (e) {
    return errorResponse(e, 'list invitations')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  const role = (body.role ?? 'attendee') as string
  if (!(INVITABLE_ROLES as readonly string[]).includes(role)) {
    return fail(400, `Role must be one of ${INVITABLE_ROLES.join(', ')}`, { field: 'role' })
  }
  if (role === 'admin' && ctx.role !== 'owner') return fail(403, 'Only an event owner can invite admins')

  let emails: string[] = []
  if (body.emails !== undefined && body.emails !== null) {
    if (!Array.isArray(body.emails) || !body.emails.every((e) => typeof e === 'string')) {
      return fail(400, 'emails must be a list of addresses', { field: 'emails' })
    }
    emails = [...new Set((body.emails as string[]).map((e) => e.trim().toLowerCase()).filter(Boolean))]
    const invalid = emails.filter((e) => e.length > 254 || !EMAIL.test(e))
    if (invalid.length) return fail(400, `Not a valid email address: ${invalid.slice(0, 3).join(', ')}`, { field: 'emails' })
    if (emails.length > MAX_EMAILS) return fail(400, `At most ${MAX_EMAILS} addresses at once`, { field: 'emails' })
  }
  const isLink = emails.length === 0

  try {
    const days = integer(body, 'expiresInDays', { min: 1, max: 30, label: 'Expiry' }) ?? 7
    const maxUses = isLink ? integer(body, 'max_uses', { min: 1, max: 100000, label: 'Max uses' }) : null
    if (isLink && (role === 'admin' || role === 'moderator') && maxUses === null) {
      return fail(400, 'Shareable links for moderators and admins must set a limit (for example 1)', { field: 'max_uses' })
    }
    const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()

    const committed = await tx(async (t) => {
      const [event] = await t<{ name: string; slug: string; logo_url: string | null; start_date: string; end_date: string; location_name: string | null }[]>`
        select name, slug, logo_url, start_date, end_date, location_name from events where id = ${ctx.event.id}
      `
      const [inviter] = await t<{ display_name: string | null; handle: string | null }[]>`
        select p.display_name, a.handle from accounts a left join profiles p on p.id = a.id where a.id = ${ctx.viewer.accountId}
      `
      const inviterName = inviter?.display_name || (inviter?.handle ? `@${inviter.handle}` : 'An organizer')

      if (isLink) {
        const [invitation] = await t<InvitationRow[]>`
          insert into event_invitations (event_id, email, role, expires_at, created_by, max_uses)
          values (${ctx.event.id}, null, ${role}, ${expiresAt}, ${ctx.viewer.accountId}, ${maxUses})
          returning id, token, email, role, expires_at, accepted_at, revoked_at, created_at, max_uses, use_count
        `
        return { event, inviterName, invitations: [invitation], toEmail: [], results: [] }
      }

      const accounts = await t<{ id: string; email: string; role: string | null }[]>`
        select a.id, lower(a.email) as email, m.role
        from accounts a
        left join event_members m on m.user_id = a.id and m.event_id = ${ctx.event.id}
        where lower(a.email) in ${t(emails)}
      `
      const accountByEmail = new Map(accounts.map((a) => [a.email, a]))
      const invitations: InvitationRow[] = []
      const toEmail: InvitationRow[] = []
      const results: Array<{ email: string; sent: boolean; channel: 'notification' | 'email' | 'none'; error?: string }> = []
      for (const email of emails) {
        const account = accountByEmail.get(email)
        if (account?.role) {
          results.push({ email, sent: false, channel: 'none', error: `Already a member (${account.role})` })
          continue
        }
        const [invitation] = await t<InvitationRow[]>`
          insert into event_invitations (event_id, email, role, expires_at, created_by)
          values (${ctx.event.id}, ${email}, ${role}, ${expiresAt}, ${ctx.viewer.accountId})
          returning id, token, email, role, expires_at, accepted_at, revoked_at, created_at, max_uses, use_count
        `
        invitations.push(invitation)
        if (account) {
          await notify(t, {
            eventId: ctx.event.id,
            userIds: [account.id],
            type: 'event_invitation',
            title: `You're invited to ${event.name}`,
            body: `${inviterName} invited you to join ${event.name} as ${role === 'attendee' ? 'an attendee' : `a ${role}`}.`,
            actionUrl: `/invite/e/${invitation.token}`,
            data: { role },
          })
          results.push({ email, sent: true, channel: 'notification' })
        } else {
          toEmail.push(invitation)
        }
      }
      return { event, inviterName, invitations, toEmail, results }
    })

    // Mail after commit: an invitation that was never saved must never be mailed.
    const results = [...committed.results]
    for (const invitation of committed.toEmail) {
      try {
        const content = buildEventInvitationEmail({
          event: {
            name: committed.event.name,
            slug: committed.event.slug,
            logoUrl: committed.event.logo_url ?? undefined,
            dateRange: formatEventDateRange(committed.event.start_date, committed.event.end_date),
            location: committed.event.location_name ?? undefined,
          },
          inviteeEmail: invitation.email!,
          inviterName: committed.inviterName,
          role: invitation.role,
          inviteToken: invitation.token,
          expiresAt: invitation.expires_at,
        })
        const { delivered } = await sendMail({ to: invitation.email!, subject: content.subject, text: content.text, html: content.html })
        results.push({
          email: invitation.email!,
          sent: true,
          channel: 'email',
          ...(delivered ? {} : { error: 'Mail is not configured here; the invitation link was logged instead' }),
        })
      } catch (e) {
        console.error('[invitations] mail failed:', e instanceof Error ? e.message : e)
        results.push({ email: invitation.email!, sent: false, channel: 'email', error: 'The email could not be sent. The invitation stays open; copy its link or revoke it.' })
      }
    }

    const single = committed.invitations.length === 1 && !committed.invitations[0].email ? committed.invitations[0] : null
    return json(
      {
        success: true,
        invitations: committed.invitations,
        inviteUrl: single ? `${appUrl()}/invite/e/${single.token}` : null,
        emailResults: isLink ? undefined : results,
      },
      { status: 201 },
    )
  } catch (e) {
    return errorResponse(e, 'create invitations')
  }
}
