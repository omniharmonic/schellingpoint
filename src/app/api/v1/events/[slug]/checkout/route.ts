/**
 * Get a ticket.
 *
 *   POST /api/v1/events/[slug]/checkout   { tierId }
 *   free tier → 200 { success, ticketId, status: 'confirmed' }   (created server-side, membership + notification)
 *   paid tier → 200 { success, url, sessionId, ticketId, status: 'pending' }
 *               (a seat is held until the Stripe Checkout session expires; the webhook confirms it)
 *
 * 401 signed out · 404 unknown/hidden event or tier · 409 sold out (confirmed + unexpired holds), outside the
 * sale window, or ticket already held
 * · 400 ticketing off · 503 paid tier while Stripe is not configured.
 */
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { publicUrl } from '@/lib/atproto/config'
import { createCheckoutSession, expireCheckoutSession, isPlatformChargeFallbackAllowed, stripe } from '@/lib/payments/stripe'
import { claimFreeTicket, jsonError, loadTicketEvent, startPaidCheckout } from '@/lib/tickets'
import { sql } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Origin for Stripe redirects: the (already same-origin-checked) request origin, else the app URL. */
function redirectOrigin(request: Request): string {
  const origin = request.headers.get('origin')
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).origin
    } catch {
      // fall through
    }
  }
  return publicUrl()
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const { slug } = await params
  const loaded = await loadTicketEvent(request, slug)
  if (loaded instanceof Response) return loaded
  const { event } = loaded

  let body: { tierId?: unknown }
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  const tierId = body?.tierId
  if (typeof tierId !== 'string' || !UUID.test(tierId)) return jsonError(400, 'Tier ID is required', { field: 'tierId' })
  if (!event.ticketing_enabled) return jsonError(400, 'Ticketing is not enabled for this event')

  // Refuse a paid tier before reserving anything when payments are unavailable.
  const [tier] = await sql<{ price_cents: number }[]>`
    select price_cents from ticket_tiers where id = ${tierId} and event_id = ${event.id}
  `
  if (!tier) return jsonError(404, 'Ticket tier not found')
  if (tier.price_cents > 0 && !stripe) return jsonError(503, 'Payments are not configured')
  if (tier.price_cents > 0 && !event.stripe_account_id && !isPlatformChargeFallbackAllowed()) {
    return jsonError(503, 'This event cannot accept payments yet', { code: 'NO_PAYOUT_ACCOUNT' })
  }

  if (tier.price_cents === 0) {
    const claim = await claimFreeTicket({ eventId: event.id, tierId, accountId: viewer.accountId })
    if (!claim.ok) return jsonError(claim.status, claim.error, { code: claim.code })
    return Response.json(
      { success: true, ticketId: claim.ticketId, status: 'confirmed', message: 'Free ticket created successfully' },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const checkout = await startPaidCheckout(
    {
      event,
      tierId,
      holder: { accountId: viewer.accountId, email: viewer.email },
      origin: redirectOrigin(request),
    },
    { createSession: createCheckoutSession, expireSession: expireCheckoutSession },
  )
  if (!checkout.ok) return jsonError(checkout.status, checkout.error, { code: checkout.code })
  return Response.json(
    { success: true, url: checkout.url, sessionId: checkout.sessionId, ticketId: checkout.ticketId, status: 'pending' },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
