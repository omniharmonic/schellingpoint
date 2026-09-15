import { sql } from '@/lib/db'
import { isUuid, json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { loadManageContext } from '@/app/api/v1/sessions/_lib/manage'

/** DELETE /api/sessions/[id]/invites/[inviteId] — revoke a pending invite link. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; inviteId: string }> }) {
  const { id, inviteId } = await params
  const ctx = await loadManageContext(request, id)
  if (ctx instanceof Response) return ctx
  if (!ctx.canInvite) return jsonError(403, 'Forbidden')
  if (!isUuid(inviteId)) return jsonError(404, 'Invite not found')

  const rows = await sql`
    update cohost_invites set status = 'revoked'
    where id = ${inviteId} and session_id = ${id} and event_id = ${ctx.access.event.id} and status = 'pending'
    returning id
  `
  if (!rows.length) return jsonError(404, 'Invite not found')
  return json({ success: true })
}
