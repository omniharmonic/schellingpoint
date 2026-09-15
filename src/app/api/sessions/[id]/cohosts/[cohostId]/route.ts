import { sql } from '@/lib/db'
import { isUuid, json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { withdrawCohostFor } from '@/app/api/v1/sessions/_lib/atproto'
import { loadManageContext } from '@/app/api/v1/sessions/_lib/manage'

/**
 * DELETE /api/sessions/[id]/cohosts/[cohostId]
 *
 * `cohostId` is `me` (a co-host stepping down) or a co-host row id from the session payload
 * (the proposer removing someone from their session).
 *
 * Stepping down deletes the co-host's own `schellingpoint.draft.cohost` first, so no public
 * claim outlives the pairing. The proposer's removal is app-side only: the record is the
 * co-host's, and nobody else may delete it (spec §4.2). Organizers cannot un-co-host anyone.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string; cohostId: string }> }) {
  const { id, cohostId } = await params
  const ctx = await loadManageContext(request, id)
  if (ctx instanceof Response) return ctx

  const rows = cohostId === 'me'
    ? await sql<{ id: string; user_id: string; cohost_uri: string | null }[]>`
        select id, user_id, cohost_uri from session_cohosts where session_id = ${id} and user_id = ${ctx.viewer.accountId}
      `
    : isUuid(cohostId)
      ? await sql<{ id: string; user_id: string; cohost_uri: string | null }[]>`
          select id, user_id, cohost_uri from session_cohosts where session_id = ${id} and id = ${cohostId}
        `
      : []
  const row = rows[0]
  if (!row) return jsonError(404, 'Co-host not found')

  const self = row.user_id === ctx.viewer.accountId
  if (!self && !ctx.rel.isHost) {
    return jsonError(403, 'Only the co-host or the proposer can end a co-hosting')
  }

  let atproto
  if (self && row.cohost_uri) {
    atproto = await withdrawCohostFor(id, ctx.viewer.accountId)
    if (atproto.error) {
      return jsonError(502, 'Your co-host record could not be removed from your repository. Try again.', { atproto })
    }
  }
  await sql`delete from session_cohosts where id = ${row.id} and session_id = ${id}`
  return json({ success: true, ...(atproto ? { atproto } : {}) })
}
