/**
 * A fresh check-in QR code for the signed-in holder's own ticket.
 *
 *   GET /api/v1/events/[slug]/tickets/[ticketId]/qr
 *   → { success, qrDataUrl, ticketId, expiresAt }
 *
 * Holder only (404 for anyone else — the token carries the holder's DID and admits them at
 * the door). Confirmed and checked-in tickets only. Tokens expire after TICKET_QR_TTL_SECONDS
 * and are never stored.
 */
import { requireViewer } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { jsonError } from '@/lib/tickets'
import { mintTicketToken, ticketQrDataUrl } from '@/lib/tickets/qr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
): Promise<Response> {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { slug, ticketId } = await params
  if (!UUID.test(ticketId)) return jsonError(404, 'Ticket not found')

  const [ticket] = await sql<{ id: string; event_id: string; status: string }[]>`
    select tk.id, tk.event_id, tk.status
    from tickets tk join events e on e.id = tk.event_id
    where tk.id = ${ticketId} and e.slug = ${slug} and tk.user_id = ${viewer.accountId}
  `
  if (!ticket) return jsonError(404, 'Ticket not found')
  if (ticket.status !== 'confirmed' && ticket.status !== 'checked_in') {
    return jsonError(409, 'QR code only available for confirmed tickets', { code: 'NOT_CONFIRMED' })
  }

  const { token, expiresAt } = await mintTicketToken({ event_id: ticket.event_id, ticket_id: ticket.id, did: viewer.did })
  const qrDataUrl = await ticketQrDataUrl(token)
  return Response.json(
    { success: true, qrDataUrl, ticketId: ticket.id, expiresAt },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
