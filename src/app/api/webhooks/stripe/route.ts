/**
 * Stripe webhook: ticket payment lifecycle.
 *
 *   checkout.session.completed (payment_status paid) / async_payment_succeeded
 *       → settle under the tier lock: confirm the hold (membership + `ticket_confirmed`, one
 *         transaction); if the hold lapsed, confirm only if a seat is still free, otherwise
 *         mark `refund_needed` (logged, shown on the organizer revenue page)
 *   checkout.session.expired / async_payment_failed → release that session's hold
 *   charge.refunded (full refund)                   → cancel the ticket (or refund-needed row);
 *                                                     a partial refund is recorded, not revoked
 *   account.updated / v2.core.account.updated       → record the merchant's capabilities and
 *                                                     pause paid sales if one was lost
 *
 * This route does three things and delegates the rest to `handleStripeEvent`:
 *
 *   1. verifies the signature against every configured secret (STRIPE_WEBHOOK_SECRET, plus
 *      STRIPE_WEBHOOK_SECRET_CONNECT when the Connect destination has its own),
 *   2. refuses any delivery whose `livemode` disagrees with the configured key, so a sandbox
 *      destination and a live one can never settle each other's tickets even if both point
 *      here by mistake,
 *   3. passes the event on, where the connected account in the envelope and the app's own
 *      `checkout_references` row decide what may happen. Metadata never grants admission.
 *
 * Every handler is idempotent. 503 when Stripe or the webhook secret is not configured.
 * Logs name the event type, the outcome and — for a refusal — the machine-readable reason.
 * No secret, signature or payload is ever logged.
 */
import type Stripe from 'stripe'
import { constructWebhookEvent, stripe, stripeKeyLivemode, stripeRefundGateway } from '@/lib/payments/stripe'
import { handleStripeEvent } from '@/lib/payments/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Both destinations may sign with their own secret; a delivery has to match one of them. */
function webhookSecrets(): string[] {
  return [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_WEBHOOK_SECRET_CONNECT]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

export async function POST(request: Request): Promise<Response> {
  const secrets = webhookSecrets()
  if (!stripe || secrets.length === 0) {
    return Response.json({ error: 'Payments are not configured' }, { status: 503 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) return Response.json({ error: 'Missing signature' }, { status: 400 })

  const payload = await request.text()
  let event: Stripe.Event | null = null
  for (const secret of secrets) {
    try {
      event = constructWebhookEvent(payload, signature, secret)
      break
    } catch {
      // Try the next configured destination secret.
    }
  }
  if (!event) return Response.json({ error: 'Invalid signature' }, { status: 400 })

  // Sandbox and live are never mixed: the key decides which world this deployment is in.
  const livemode = stripeKeyLivemode()
  if (livemode !== null && event.livemode !== livemode) {
    console.error(`[webhooks:stripe] ${event.type} refused: livemode=${event.livemode} but this deployment is ${livemode ? 'live' : 'test'}`)
    return Response.json({ error: 'Wrong Stripe mode for this endpoint' }, { status: 400 })
  }

  try {
    const result = await handleStripeEvent(event, { refunds: stripeRefundGateway() })
    if (result.outcome === 'rejected') {
      // A refusal is final, not a retry: answer 2xx so Stripe stops redelivering it.
      console.error(`[webhooks:stripe] ${result.type} rejected: ${result.detail ?? 'unverified'}`)
    } else if (result.outcome !== 'unhandled') {
      console.info(`[webhooks:stripe] ${result.type} ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`)
    }
    return Response.json({ received: true, outcome: result.outcome })
  } catch (err) {
    // Non-2xx makes Stripe retry; handlers are idempotent.
    console.error(`[webhooks:stripe] ${event.type} failed:`, err instanceof Error ? err.name : 'error')
    return Response.json({ error: 'Webhook handler failed' }, { status: 500 })
  }
}
