/**
 * DELETE /api/v1/events/[slug]/invitations/[id] — revoke an invitation (kept, marked revoked).
 */
import { sql } from '@/lib/db'
import { errorResponse, fail, isUuid, json, requireOrganizer } from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const ROLES = ['owner', 'admin'] as const

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Invitation not found')
  try {
    const rows = await sql`
      update event_invitations set revoked_at = coalesce(revoked_at, now())
      where id = ${id} and event_id = ${ctx.event.id}
      returning id
    `
    if (rows.length === 0) return fail(404, 'Invitation not found')
    return json({ success: true })
  } catch (e) {
    return errorResponse(e, 'revoke invitation')
  }
}
