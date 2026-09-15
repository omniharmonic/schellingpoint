import { sql } from '@/lib/db'
import { json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { loadManageContext } from '@/app/api/v1/sessions/_lib/manage'

/**
 * Co-host invitations (spec §4.2 double opt-in). An invitation is an opaque app-side token
 * that names nobody: whoever redeems it becomes a co-host by accepting, and only then does a
 * `schellingpoint.draft.cohost` appear — in the co-host's own repository.
 *
 * POST /api/sessions/[id]/invites — create a link (the proposer or an organizer)
 * GET  /api/sessions/[id]/invites — pending links (the proposer or an organizer)
 */
type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const { id } = await params
  const ctx = await loadManageContext(request, id)
  if (ctx instanceof Response) return ctx
  if (!ctx.canInvite) return jsonError(403, 'Only the proposer or an event organizer can create invite links')

  const open = await sql<{ n: number }[]>`
    select count(*)::int as n from cohost_invites
    where session_id = ${id} and status = 'pending' and expires_at > now()
  `
  if ((open[0]?.n ?? 0) >= 10) return jsonError(409, 'This session already has 10 open invite links. Revoke one first.')

  const [invite] = await sql<{ id: string; token: string; status: string; expires_at: string; created_at: string }[]>`
    insert into cohost_invites (session_id, event_id, created_by)
    values (${id}, ${ctx.access.event.id}, ${ctx.viewer.accountId})
    returning id, token, status, expires_at, created_at
  `
  return json(invite, { status: 201 })
}

export async function GET(request: Request, { params }: Params) {
  const { id } = await params
  const ctx = await loadManageContext(request, id)
  if (ctx instanceof Response) return ctx
  if (!ctx.canInvite) return jsonError(403, 'Forbidden')

  const invites = await sql<{ id: string; token: string; status: string; expires_at: string; created_at: string }[]>`
    select id, token, status, expires_at, created_at
    from cohost_invites
    where session_id = ${id} and event_id = ${ctx.access.event.id} and status = 'pending' and expires_at > now()
    order by created_at desc
  `
  return json({ invites })
}
