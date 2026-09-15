/**
 * POST /api/v1/invitations/[token]/accept — join the event the invitation is for.
 *
 * In one transaction, with the invitation row locked:
 * - revoked / expired → 410; an email invitation for another address → 403
 * - already a member: an invitation to a higher role upgrades them (never an owner, never a
 *   downgrade); otherwise nothing is granted and a link use is not consumed
 * - email invitations are single-use (`accepted_at`); links consume one use with a
 *   compare-and-swap (`use_count < max_uses`), so concurrent accepts can never exceed the limit
 * - each redemption stamps `last_redeemed_at` for the 30-day inviter retention (spec §9)
 */
import { tx } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { isRoleHigherThan } from '@/lib/permissions'
import { errorResponse, fail, json } from '@/lib/scheduling/admin-api'
import type { EventRoleName } from '@/types/event'

export const dynamic = 'force-dynamic'

const TOKEN = /^[0-9a-f]{64}$/

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return fail(401, 'Sign in to accept this invitation')
  const { token } = await params
  if (!TOKEN.test(token)) return fail(404, 'Invalid invitation')

  try {
    const outcome = await tx(async (t) => {
      const [inv] = await t<{
        id: string; event_id: string; email: string | null; role: EventRoleName; accepted_at: string | null
        revoked_at: string | null; max_uses: number | null; use_count: number; expired: boolean
        slug: string; name: string
      }[]>`
        select i.id, i.event_id, i.email, i.role, i.accepted_at, i.revoked_at, i.max_uses, i.use_count,
               i.expires_at <= now() as expired, e.slug, e.name
        from event_invitations i join events e on e.id = i.event_id
        where i.token = ${token}
        for update of i
      `
      if (!inv) return { ok: false as const, status: 404, error: 'Invalid invitation' }
      if (inv.revoked_at) return { ok: false as const, status: 410, error: 'This invitation has been revoked' }
      if (inv.expired) return { ok: false as const, status: 410, error: 'This invitation has expired' }
      const isEmailInvite = Boolean(inv.email)
      if (isEmailInvite && inv.accepted_at) return { ok: false as const, status: 409, error: 'This invitation has already been used' }
      if (isEmailInvite && (viewer.email ?? '').toLowerCase() !== inv.email!.toLowerCase()) {
        return { ok: false as const, status: 403, error: 'This invitation was sent to a different email address' }
      }

      const [member] = await t<{ id: string; role: EventRoleName }[]>`
        select id, role from event_members where event_id = ${inv.event_id} and user_id = ${viewer.accountId} for update
      `
      const upgrade = member && member.role !== 'owner' && isRoleHigherThan(inv.role, member.role)
      if (member && !upgrade) {
        if (isEmailInvite) {
          await t`update event_invitations set accepted_at = now(), last_redeemed_at = now() where id = ${inv.id} and accepted_at is null`
        }
        return { ok: true as const, eventSlug: inv.slug, role: member.role, message: `You are already a member of ${inv.name}` }
      }

      if (isEmailInvite) {
        const claimed = await t`
          update event_invitations set accepted_at = now(), last_redeemed_at = now()
          where id = ${inv.id} and accepted_at is null
          returning id
        `
        if (claimed.length === 0) return { ok: false as const, status: 409, error: 'This invitation has already been used' }
      } else {
        const claimed = await t`
          update event_invitations set use_count = use_count + 1, last_redeemed_at = now()
          where id = ${inv.id} and use_count = ${inv.use_count} and (max_uses is null or use_count < max_uses)
          returning id
        `
        if (claimed.length === 0) return { ok: false as const, status: 410, error: 'This invitation has reached its use limit' }
      }

      if (member) {
        await t`update event_members set role = ${inv.role} where id = ${member.id}`
      } else {
        await t`insert into event_members (event_id, user_id, role) values (${inv.event_id}, ${viewer.accountId}, ${inv.role})`
      }
      return { ok: true as const, eventSlug: inv.slug, role: inv.role, message: `Welcome to ${inv.name}!` }
    })
    if (!outcome.ok) return fail(outcome.status, outcome.error)
    return json({ success: true, message: outcome.message, eventSlug: outcome.eventSlug, role: outcome.role })
  } catch (e) {
    return errorResponse(e, 'accept invitation')
  }
}
