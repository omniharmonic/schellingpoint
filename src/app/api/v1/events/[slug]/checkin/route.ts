/**
 * Door check-in (owner, admin, moderator, volunteer — `checkInAttendees`).
 *
 *   POST /api/v1/events/[slug]/checkin   { qrToken }            — scanned QR (signed, holder-bound)
 *   POST /api/v1/events/[slug]/checkin   { ticketCode }         — manual entry: the ticket id, or its first 8+ characters
 *   → 200 { success, attendee: { name, avatarUrl, tierName, ticketId } }
 *   → 400 INVALID_TOKEN | WRONG_EVENT | WRONG_HOLDER | INVALID_CODE · 404 TICKET_NOT_FOUND · 409 AMBIGUOUS_CODE
 *   → 409 TICKET_PENDING | TICKET_CANCELLED | TICKET_REFUND_NEEDED | ALREADY_CHECKED_IN (with attendee, checkedInAt)
 *
 *   GET /api/v1/events/[slug]/checkin   → { success, stats: { total, checkedIn, pending } }
 *
 * Manual entry is for when the camera fails or the attendee cannot show the QR code. It is not a
 * bearer credential: the caller already holds a check-in role for this gathering, the lookup is
 * scoped to this event, and the response never includes the holder's email.
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { CHECKIN_ROLES, checkInTicket, jsonError, verifyTicketForCheckin, type CheckinAttendee, type CheckinVerification } from '@/lib/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** Lowercase hex and dashes only, at least 8 characters: a full ticket uuid or a prefix of one. */
const TICKET_CODE = /^[0-9a-f-]{8,36}$/

async function verifyTicketByCode(code: string, eventId: string): Promise<CheckinVerification> {
  const rows = await sql<{
    id: string; status: string; checked_in_at: string | null
    display_name: string | null; avatar_url: string | null; handle: string | null; tier_name: string | null
  }[]>`
    select tk.id, tk.status, tk.checked_in_at,
           p.display_name, p.avatar_url, a.handle, tt.name as tier_name
    from tickets tk
    join accounts a on a.id = tk.user_id
    left join profiles p on p.id = tk.user_id
    left join ticket_tiers tt on tt.id = tk.tier_id
    where tk.event_id = ${eventId} and tk.id::text like ${`${code}%`}
    limit 2
  `
  if (rows.length === 0) return { ok: false, status: 404, code: 'TICKET_NOT_FOUND', error: 'No ticket matches that code' }
  if (rows.length > 1) return { ok: false, status: 409, code: 'AMBIGUOUS_CODE', error: 'More than one ticket matches; enter a few more characters' }
  const ticket = rows[0]
  const attendee: CheckinAttendee = {
    name: ticket.display_name?.trim() || ticket.handle || 'Attendee',
    avatarUrl: ticket.avatar_url,
    tierName: ticket.tier_name,
    ticketId: ticket.id,
  }
  if (ticket.status === 'refund_needed') {
    return { ok: false, status: 409, code: 'TICKET_REFUND_NEEDED', error: 'This payment is awaiting a refund; it holds no seat', attendee }
  }
  if (ticket.status === 'cancelled') {
    return { ok: false, status: 409, code: 'TICKET_CANCELLED', error: 'This ticket has been cancelled', attendee }
  }
  if (ticket.status === 'pending') {
    return { ok: false, status: 409, code: 'TICKET_PENDING', error: 'This ticket payment is still pending', attendee }
  }
  if (ticket.status === 'checked_in') {
    return {
      ok: false, status: 409, code: 'ALREADY_CHECKED_IN', error: 'This ticket has already been checked in',
      attendee, checkedInAt: ticket.checked_in_at,
    }
  }
  return { ok: true, ticketId: ticket.id, attendee }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug } = await params
  const auth = await requireEventRole(request, slug, CHECKIN_ROLES)
  if (auth instanceof Response) return auth

  let body: { qrToken?: unknown; ticketCode?: unknown }
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }

  let verified: CheckinVerification
  if (typeof body?.qrToken === 'string' && body.qrToken) {
    verified = await verifyTicketForCheckin(sql, { token: body.qrToken, eventId: auth.event.id })
  } else if (typeof body?.ticketCode === 'string' && body.ticketCode.trim()) {
    const code = body.ticketCode.trim().toLowerCase()
    if (!TICKET_CODE.test(code)) {
      return jsonError(400, 'Enter at least the first 8 characters of the ticket ID', { field: 'ticketCode', code: 'INVALID_CODE' })
    }
    verified = await verifyTicketByCode(code, auth.event.id)
  } else {
    return jsonError(400, 'A QR token or ticket code is required', { field: 'qrToken' })
  }

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
