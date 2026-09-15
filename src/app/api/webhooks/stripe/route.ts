/**
 * Stripe webhook: ticket payment lifecycle.
 *
 *   checkout.session.completed (payment_status paid) / async_payment_succeeded
 *       → settle under the tier lock: confirm the hold (membership + `ticket_confirmed`, one
 *         transaction); if the hold lapsed, confirm only if a seat is still free, otherwise
 *         mark `refund_needed` (logged, shown on the organizer revenue page)
 *   checkout.session.expired / async_payment_failed → release that session's hold
 *   charge.refunded (full refund)                   → cancel the ticket (or refund-needed row)
 *
 * The hold is found by `metadata.ticket_id` (set at checkout), checked against
 * `metadata.event_id`; `tier_id`/`holder_id` settle a payment whose hold was already swept. Every handler is idempotent. 503 when Stripe or the webhook secret is
 * not configured. Logs name the event type only.
 */
import type Stripe from 'stripe'
import { constructWebhookEvent, stripe } from '@/lib/payments/stripe'
import { cancelRefundedTicket, releaseCheckoutHold, settlePaidCheckout } from '@/lib/tickets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function ticketRef(session: Stripe.Checkout.Session): { ticketId: string; eventId: string; tierId: string | null; holderId: string | null } | null {
  const m = session.metadata ?? {}
  if (!m.ticket_id || !m.event_id || !UUID.test(m.ticket_id) || !UUID.test(m.event_id)) return null
  return {
    ticketId: m.ticket_id,
    eventId: m.event_id,
    tierId: m.tier_id && UUID.test(m.tier_id) ? m.tier_id : null,
    holderId: m.holder_id && UUID.test(m.holder_id) ? m.holder_id : null,
  }
}

function paymentIntentId(value: string | Stripe.PaymentIntent | null): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

export async function POST(request: Request): Promise<Response> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
  if (!stripe || !webhookSecret) {
    return Response.json({ error: 'Payments are not configured' }, { status: 503 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) return Response.json({ error: 'Missing signature' }, { status: 400 })

  let event: Stripe.Event
  try {
    event = constructWebhookEvent(await request.text(), signature, webhookSecret)
  } catch {
    return Response.json({ error: 'Invalid signature' }, { status: 400 })
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object as Stripe.Checkout.Session
        const ref = ticketRef(session)
        if (!ref) break
        // `completed` also fires for delayed payment methods before the money arrives.
        if (session.payment_status !== 'paid') break
        await settlePaidCheckout({
          ...ref,
          sessionId: session.id,
          paymentIntentId: paymentIntentId(session.payment_intent),
          amountPaidCents: session.amount_total ?? null,
          currency: session.currency,
          platformFeeCents: /^\d+$/.test(session.metadata?.platform_fee_cents ?? '') ? Number(session.metadata!.platform_fee_cents) : null,
        })
        break
      }

      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object as Stripe.Checkout.Session
        const ref = ticketRef(session)
        if (ref) await releaseCheckoutHold({ ticketId: ref.ticketId, eventId: ref.eventId, sessionId: session.id })
        break
      }

      case 'charge.refunded': {
        const charge = event.data.object as Stripe.Charge
        const pi = paymentIntentId(charge.payment_intent)
        if (pi && charge.refunded) await cancelRefundedTicket(pi)
        break
      }

      default:
        break
    }
  } catch (err) {
    // Non-2xx makes Stripe retry; handlers are idempotent.
    console.error(`[webhooks:stripe] ${event.type} failed:`, err instanceof Error ? err.name : 'error')
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 })
  }

  return Response.json({ received: true })
}
