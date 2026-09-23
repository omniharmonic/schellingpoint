/**
 * Refund one paid ticket (owner or admin).
 *
 *   POST /api/v1/events/[slug]/admin/ticketing-settings/sales/[ticketId]/refund
 *     { amountCents?: number, refundApplicationFee?: boolean }
 *   → 200 { refundId, amountCents, applicationFeeRefundedCents, full, admissionRevoked }
 *
 * Omit `amountCents` for a full refund: the whole remaining amount goes back, the platform
 * contribution goes back with it by default, and the ticket is cancelled. Give an amount for
 * a partial refund: it is recorded against the checkout reference and admission is left
 * alone — the holder paid less, they did not stop being admitted.
 *
 * The refund is issued in the organizer's own Stripe account, because that is where a direct
 * charge lives. 404 for a ticket that is not this gathering's; 409 for one with no recorded
 * payment; 503 when this deployment has no Stripe key.
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { refundTicket } from '@/lib/payments/refunds'
import { stripeRefundGateway } from '@/lib/payments/stripe'
import { jsonError, TICKET_ADMIN_ROLES } from '@/lib/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; ticketId: string }> },
): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug, ticketId } = await params
  if (!UUID.test(ticketId)) return jsonError(404, 'Ticket not found')
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth

  let body: { amountCents?: unknown; refundApplicationFee?: unknown } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text)
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, 'Expected a refund object')
  if (body.amountCents !== undefined && body.amountCents !== null && typeof body.amountCents !== 'number') {
    return jsonError(400, 'The refund amount must be a number of cents', { field: 'amountCents' })
  }
  if (body.refundApplicationFee !== undefined && typeof body.refundApplicationFee !== 'boolean') {
    return jsonError(400, 'refundApplicationFee must be true or false', { field: 'refundApplicationFee' })
  }

  const result = await refundTicket(
    {
      eventId: auth.event.id,
      ticketId,
      amountCents: (body.amountCents as number | undefined) ?? null,
      refundApplicationFee: body.refundApplicationFee as boolean | undefined,
    },
    stripeRefundGateway(),
  )
  if (!result.ok) {
    console.warn(`[refunds] refund refused for ${slug}: ${result.code}`)
    return jsonError(result.status, result.error, { code: result.code })
  }
  console.info(`[refunds] ${result.full ? 'full' : 'partial'} refund issued for a ticket at ${slug}`)
  return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
}
