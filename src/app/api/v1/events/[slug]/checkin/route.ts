/**
 * Door check-in (owner, admin, moderator, volunteer — `checkInAttendees`).
 *
 *   POST /api/v1/events/[slug]/checkin   { qrToken }
 *   → 200 { success, attendee: { name, avatarUrl, tierName, ticketId } }
 *   → 400 INVALID_TOKEN | WRONG_EVENT | WRONG_HOLDER · 404 TICKET_NOT_FOUND
 *   → 409 TICKET_PENDING | TICKET_CANCELLED | ALREADY_CHECKED_IN (with attendee, checkedInAt)
 *
 *   GET /api/v1/events/[slug]/checkin   → { success, stats: { total, checkedIn, pending } }
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { CHECKIN_ROLES, checkInTicket, jsonError, verifyTicketForCheckin } from '@/lib/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug } = await params
  const auth = await requireEventRole(request, slug, CHECKIN_ROLES)
  if (auth instanceof Response) return auth

  let body: { qrToken?: unknown }
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  if (typeof body?.qrToken !== 'string' || !body.qrToken) return jsonError(400, 'QR token is required', { field: 'qrToken' })

  const verified = await verifyTicketForCheckin(sql, { token: body.qrToken, eventId: auth.event.id })
  if (!verified.ok) {
    const { status, error, code, attendee, checkedInAt } = verified
    return Response.json({ success: false, error, code, attendee, checkedInAt }, { status, headers: NO_STORE })
  }

  const checkedIn = await checkInTicket(verified.ticketId, auth.event.id, auth.viewer.accountId)
  if (!checkedIn) {
    return Response.json(
      { success: false, error: 'This ticket has already been checked in', code: 'ALREADY_CHECKED_IN', attendee: verified.attendee },
      { status: 409, headers: NO_STORE },
    )
  }
  return Response.json({ success: true, message: 'Check-in successful', attendee: verified.attendee }, { headers: NO_STORE })
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, CHECKIN_ROLES)
  if (auth instanceof Response) return auth

  const [stats] = await sql<{ total: number; checked_in: number; pending: number }[]>`
    select count(*)::int as total,
           count(*) filter (where status = 'checked_in')::int as checked_in,
           count(*) filter (where status = 'confirmed')::int as pending
    from tickets
    where event_id = ${auth.event.id} and status in ('confirmed', 'checked_in')
  `
  return Response.json(
    { success: true, stats: { total: stats.total, checkedIn: stats.checked_in, pending: stats.pending } },
    { headers: NO_STORE },
  )
}
