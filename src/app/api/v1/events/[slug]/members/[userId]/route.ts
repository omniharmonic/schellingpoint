/**
 * Event member management.
 *   PATCH  /api/v1/events/[slug]/members/[userId]   { role }
 *   DELETE /api/v1/events/[slug]/members/[userId]
 *
 * Authorization:
 * - Caller must be an owner or admin of the event (403 otherwise; 404 for hidden events).
 * - Only an owner may assign the `owner` role, or change or remove a member who holds it.
 * - The last owner can never be demoted or removed (409). The event's owner rows are locked
 *   for the duration, so two concurrent demotions cannot both pass the check.
 * - Nobody changes their own role here (use another owner), so an organizer cannot lock
 *   themselves out by accident.
 * Removing a member keeps their sessions (a proposal belongs to its author). A published role
 * claim that no longer holds is retracted through package F afterwards.
 */
import { sql, tx } from '@/lib/db'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer } from '@/lib/scheduling/admin-api'
import type { EventRoleName } from '@/types/event'

export const dynamic = 'force-dynamic'

const ROLES = ['owner', 'admin'] as const
const VALID_ROLES: EventRoleName[] = ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee']

type Params = { params: Promise<{ slug: string; userId: string }> }

/**
 * A role change or removal can invalidate a published role claim (spec §4.1, §8: leaving retracts
 * it). Package F re-evaluates its three gates; only members who have a claim need the round trip.
 * Best-effort after commit: the membership change stands either way.
 */
async function resyncRoleClaim(eventId: string, accountId: string): Promise<{ outcome?: string; error?: string } | null> {
  const [claim] = await sql`select 1 from role_claims where event_id = ${eventId} and account_id = ${accountId}`
  if (!claim) return null
  try {
    const { syncRoleClaim } = await import('@/lib/atproto/role-claims')
    const result = await syncRoleClaim(eventId, accountId)
    return { outcome: result.outcome }
  } catch (e) {
    console.error('[members] role claim sync failed:', e instanceof Error ? e.message : e)
    return { error: 'The membership changed, but the member’s public role claim could not be updated. Check the Network page.' }
  }
}

interface MemberRow {
  id: string
  user_id: string
  role: EventRoleName
  joined_at: string | null
}

export async function PATCH(request: Request, { params }: Params) {
  const { slug, userId } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(userId)) return fail(404, 'Member not found')
  const body = await readBody(request)
  if (body instanceof Response) return body
  const newRole = body.role
  if (typeof newRole !== 'string' || !VALID_ROLES.includes(newRole as EventRoleName)) {
    return fail(400, `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`, { field: 'role' })
  }
  if (userId === ctx.viewer.accountId) return fail(403, 'You cannot change your own role. Ask another owner.')

  try {
    const outcome = await tx(async (t) => {
      const locked = await t<MemberRow[]>`
        select id, user_id, role, joined_at from event_members
        where event_id = ${ctx.event.id} and (role = 'owner' or user_id = ${userId})
        order by id
        for update
      `
      const target = locked.find((m) => m.user_id === userId)
      if (!target) return { ok: false as const, status: 404, error: 'Member not found' }
      if (ctx.role !== 'owner' && (newRole === 'owner' || target.role === 'owner')) {
        return { ok: false as const, status: 403, error: 'Only an event owner can assign or change the owner role' }
      }
      if (target.role === newRole) return { ok: true as const, member: target }
      const owners = locked.filter((m) => m.role === 'owner').length
      if (target.role === 'owner' && owners <= 1) {
        return { ok: false as const, status: 409, error: 'Cannot demote the last owner. Make someone else an owner first.' }
      }
      const [member] = await t<MemberRow[]>`
        update event_members set role = ${newRole} where id = ${target.id} and event_id = ${ctx.event.id}
        returning id, user_id, role, joined_at
      `
      return { ok: true as const, member }
    })
    if (!outcome.ok) return fail(outcome.status, outcome.error)
    const roleClaim = await resyncRoleClaim(ctx.event.id, userId)
    return json({ member: outcome.member, ...(roleClaim ? { roleClaim } : {}) })
  } catch (e) {
    return errorResponse(e, 'update member role')
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { slug, userId } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(userId)) return fail(404, 'Member not found')
  if (userId === ctx.viewer.accountId) return fail(403, 'You cannot remove yourself here. Leave the event from your settings.')

  try {
    const outcome = await tx(async (t) => {
      const locked = await t<MemberRow[]>`
        select id, user_id, role, joined_at from event_members
        where event_id = ${ctx.event.id} and (role = 'owner' or user_id = ${userId})
        order by id
        for update
      `
      const target = locked.find((m) => m.user_id === userId)
      if (!target) return { ok: false as const, status: 404, error: 'Member not found' }
      if (target.role === 'owner') {
        if (ctx.role !== 'owner') return { ok: false as const, status: 403, error: 'Only an event owner can remove another owner' }
        if (locked.filter((m) => m.role === 'owner').length <= 1) {
          return { ok: false as const, status: 409, error: 'Cannot remove the last owner. Make someone else an owner first.' }
        }
      }
      await t`delete from event_members where id = ${target.id} and event_id = ${ctx.event.id}`
      return { ok: true as const, member: target }
    })
    if (!outcome.ok) return fail(outcome.status, outcome.error)
    const roleClaim = await resyncRoleClaim(ctx.event.id, userId)
    return json({ success: true, member: outcome.member, ...(roleClaim ? { roleClaim } : {}) })
  } catch (e) {
    return errorResponse(e, 'remove member')
  }
}
