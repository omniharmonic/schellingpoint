import 'server-only'
import type Stripe from 'stripe'
import { sql, tx } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { cancelRefundedTicket, releaseCheckoutHold, settlePaidCheckout } from '@/lib/tickets'
import { withDelivery, type DeliveryRecord } from './deliveries'
import { formatPrice } from './format'
import { applyMerchantCapabilities } from './merchant-status'
import { markReference, recordPartialRefund, resolveDelivery, type CheckoutReference } from './references'
import type { RefundGateway } from './refunds'

/**
 * What a signed Stripe delivery is allowed to do.
 *
 * The signature proves Stripe sent it. It does not prove the payment is ours: under direct
 * charges the delivery arrives on the organizer's own account, and that organizer can create
 * payments — with any metadata they like — on the same account. So nothing here reads
 * admission out of metadata. Every session event is resolved against `checkout_references`
 * (db/migrations/0029) by session id, and the reference must agree with
 *
 *   - `event.account`, the account the delivery arrived on, and
 *   - `events.stripe_account_id`, the account the gathering is connected to now,
 *
 * before the money it records is settled. Refunds are matched the same way through the hold
 * the payment bought, and `account.updated` only moves the capability flags of gatherings
 * actually connected to the account that changed.
 *
 * Idempotency has two layers. Each delivery is claimed by its Stripe event id under a row
 * lock held across the whole handler (`stripe_events`), so a redelivery — even a simultaneous
 * one — does nothing at all; and every individual effect is convergent anyway, so a retry
 * after a crash is still safe. Out-of-order delivery is handled by the effects themselves: an
 * expiry after a payment releases nothing, and a completion replayed after a full refund never
 * restores the cancelled entitlement.
 *
 * A paid delivery that cannot be matched is not simply dropped. Somebody's card was charged
 * and no admission was granted, so the refusal is recorded on `stripe_events` and shown to the
 * organizer; and where the payment is provably one of ours — the session is in our references,
 * the refusal is about the gathering having moved account or the money not matching the quote
 * — it is refunded automatically in the merchant's own context. A delivery that arrived on the
 * wrong account is *not* provably ours and is only recorded.
 */

export type WebhookOutcome =
  | 'settled'
  | 'released'
  | 'refunded'
  | 'capabilities'
  | 'duplicate'
  | 'ignored'
  | 'rejected'
  | 'unhandled'

export interface WebhookResult {
  type: string
  outcome: WebhookOutcome
  /** Why a delivery was refused, for the server log. Never returned to Stripe. */
  detail?: string
}

export interface WebhookDeps {
  /** Used to return money automatically when a payment arrives with no seat left to give. */
  refunds?: RefundGateway | null
}

function paymentIntentId(value: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id
}

/** The connected account a delivery arrived on, or null for a platform-scoped delivery. */
export function deliveredAccountOf(event: Stripe.Event): string | null {
  const account = (event as { account?: string | null }).account
  return typeof account === 'string' && account.length > 0 ? account : null
}

/**
 * Capability flags out of either Accounts API. v1 says `charges_enabled` / `payouts_enabled`;
 * v2 says the merchant configuration's `card_payments` status and the recipient
 * configuration's `stripe_balance.payouts` status.
 */
function capabilitiesOf(object: unknown): { accountId: string; chargesEnabled: boolean; payoutsEnabled: boolean } | null {
  const account = object as Partial<Stripe.Account> & Partial<Stripe.V2.Core.Account>
  if (!account || typeof account.id !== 'string') return null
  if (typeof (account as Stripe.Account).charges_enabled === 'boolean') {
    const v1 = account as Stripe.Account
    return {
      accountId: v1.id,
      chargesEnabled: Boolean(v1.charges_enabled),
      payoutsEnabled: Boolean(v1.payouts_enabled),
    }
  }
  const v2 = account as Stripe.V2.Core.Account
  const configuration = v2.configuration
  if (!configuration) return null
  return {
    accountId: v2.id,
    chargesEnabled: configuration.merchant?.capabilities?.card_payments?.status === 'active',
    payoutsEnabled: configuration.recipient?.capabilities?.stripe_balance?.payouts?.status === 'active',
  }
}

type ReturnReason = 'no_seat' | 'account_changed' | 'amount_mismatch'

const RETURN_EXPLANATION: Record<ReturnReason, string> = {
  no_seat: 'sold out while your checkout was open',
  account_changed: 'changed its payment account while your checkout was open',
  amount_mismatch: 'could not match the amount charged to the ticket price you were quoted',
}

/**
 * Give a payment back. The money is the buyer's, not the organizer's, so it goes back
 * automatically in the merchant's own account context and the buyer is told what happened.
 * Used both when a seat is no longer available and when a delivery was refused for a reason
 * that still proves the payment was ours. If no refund gateway is available the sale is left
 * for the organizer, which the revenue page surfaces — the old behaviour, now the fallback
 * rather than the outcome.
 */
async function returnPayment(
  reference: CheckoutReference,
  paymentIntent: string | null,
  refunds: RefundGateway | null | undefined,
  reason: ReturnReason,
): Promise<string> {
  if (!refunds || !paymentIntent) return 'refund_needed'
  try {
    const outstanding = reference.unit_amount - reference.refunded_amount
    if (outstanding <= 0) return 'already_refunded'
    const refund = await refunds.refund({
      paymentIntentId: paymentIntent,
      connectedAccountId: reference.connected_account_id,
      amountCents: outstanding,
      refundApplicationFee: true,
      idempotencyKey: `refund-${reference.session_id}-${outstanding}`,
    })
    await tx(async (t) => {
      await t`
        update checkout_references
        set refunded_amount = least(unit_amount, refunded_amount + ${refund.amountCents}),
            application_fee_refunded_amount = least(application_fee_amount, greatest(application_fee_refunded_amount, ${refund.applicationFeeRefundedTotalCents})),
            refunded_at = coalesce(refunded_at, now())
        where session_id = ${reference.session_id}
      `
      await t`
        update tickets set status = 'cancelled', hold_expires_at = null, updated_at = now()
        where checkout_session_id = ${reference.session_id} and status in ('pending', 'refund_needed')
      `
      if (reference.holder_account_id) {
        const [event] = await t<{ slug: string; name: string }[]>`
          select slug, name from events where id = ${reference.event_id}
        `
        await notify(t, {
          eventId: reference.event_id,
          userIds: [reference.holder_account_id],
          type: 'ticket_refunded',
          title: 'Your payment was refunded',
          body: `${event?.name ?? 'The gathering'} ${RETURN_EXPLANATION[reason]}, so ${formatPrice(refund.amountCents, reference.currency)} has been refunded in full. No ticket was issued.`,
          actionUrl: `/e/${event?.slug ?? ''}/tickets`,
        })
      }
    })
    return 'auto_refunded'
  } catch (err) {
    console.error('[webhooks:stripe] a seatless payment could not be refunded automatically:', err instanceof Error ? err.name : 'error')
    return 'refund_needed'
  }
}

async function dispatch(event: Stripe.Event, deps: WebhookDeps, record: DeliveryRecord): Promise<WebhookResult> {
  const deliveredAccount = deliveredAccountOf(event)

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object as Stripe.Checkout.Session
      // `completed` also fires for delayed payment methods before the money arrives.
      if (session.payment_status !== 'paid') return { type: event.type, outcome: 'ignored', detail: 'not paid yet' }

      const intent = paymentIntentId(session.payment_intent)
      const resolved = await resolveDelivery({
        sessionId: session.id,
        deliveredAccount,
        amountTotal: session.amount_total,
      })
      if (!resolved.ok) {
        // Money was taken and no admission was granted. Record it where the organizer can
        // see it, and — when the payment is provably ours — give it straight back.
        record.rejection = resolved.rejection
        record.sessionId = session.id
        record.eventId = resolved.reference?.event_id ?? null
        const returned = resolved.reference
          ? await returnPayment(
              resolved.reference,
              intent,
              deps.refunds,
              resolved.rejection === 'AMOUNT_MISMATCH' ? 'amount_mismatch' : 'account_changed',
            )
          : 'not_ours'
        return { type: event.type, outcome: 'rejected', detail: `${resolved.rejection} (${returned})` }
      }
      const reference = resolved.reference
      record.sessionId = reference.session_id
      record.eventId = reference.event_id

      // Everything below comes from the reference, not from the delivery's metadata. When the
      // hold was already swept, `ticket_id` is null and settlement rebuilds the seat from the
      // reference's own tier and holder — never from anything the delivery said.
      const outcome = await settlePaidCheckout({
        ticketId: reference.ticket_id,
        eventId: reference.event_id,
        tierId: reference.tier_id,
        holderId: reference.holder_account_id,
        sessionId: reference.session_id,
        paymentIntentId: intent,
        amountPaidCents: reference.unit_amount,
        currency: reference.currency,
        platformFeeCents: reference.application_fee_amount,
      })
      if (outcome === 'confirmed' || outcome === 'already_confirmed') {
        await markReference(reference.session_id, 'settled_at')
        return { type: event.type, outcome: 'settled', detail: outcome }
      }
      if (outcome === 'refund_needed') {
        // The money arrived with no seat to give. It was collected, so the reference is
        // settled; then it goes straight back to the buyer.
        await markReference(reference.session_id, 'settled_at')
        const detail = await returnPayment(reference, intent, deps.refunds, 'no_seat')
        return { type: event.type, outcome: 'settled', detail }
      }
      return { type: event.type, outcome: 'ignored', detail: outcome }
    }

    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object as Stripe.Checkout.Session
      // Nothing was charged here, so a refusal is not a lost payment: it is only refused.
      const resolved = await resolveDelivery({ sessionId: session.id, deliveredAccount })
      if (!resolved.ok) return { type: event.type, outcome: 'rejected', detail: resolved.rejection }
      const reference = resolved.reference
      record.sessionId = reference.session_id
      record.eventId = reference.event_id
      if (reference.ticket_id) {
        await releaseCheckoutHold({
          ticketId: reference.ticket_id,
          eventId: reference.event_id,
          sessionId: reference.session_id,
        })
      }
      await markReference(reference.session_id, 'expired_at')
      return { type: event.type, outcome: 'released' }
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      const pi = paymentIntentId(charge.payment_intent)
      if (!pi) return { type: event.type, outcome: 'ignored', detail: 'no payment intent' }
      if (!charge.refunded) {
        // A partial refund leaves the ticket alone; only the settled reference records it,
        // and `amount_refunded` is Stripe's running total, so it is a high-water mark.
        await recordPartialRefund(sql, { paymentIntentId: pi, amountRefunded: charge.amount_refunded ?? 0 })
        return { type: event.type, outcome: 'ignored', detail: 'partial refund recorded' }
      }
      const cancelled = await cancelRefundedTicket(pi, deliveredAccount)
      if (cancelled === 'account_mismatch') {
        return { type: event.type, outcome: 'rejected', detail: 'ACCOUNT_MISMATCH' }
      }
      return { type: event.type, outcome: 'refunded', detail: `cancelled=${cancelled}` }
    }

    // Stripe telling us a merchant's capabilities changed. v2 platforms get the v2 event.
    case 'account.updated':
    case 'v2.core.account.updated' as Stripe.Event['type']: {
      const capabilities = capabilitiesOf(event.data.object)
      if (!capabilities) return { type: event.type, outcome: 'ignored', detail: 'no capabilities in payload' }
      // The envelope's account, when present, must be the account the payload describes.
      if (deliveredAccount && deliveredAccount !== capabilities.accountId) {
        return { type: event.type, outcome: 'rejected', detail: 'ACCOUNT_MISMATCH' }
      }
      const applied = await applyMerchantCapabilities(capabilities)
      return {
        type: event.type,
        outcome: 'capabilities',
        detail: `events=${applied.events} paused=${applied.paused} resumed=${applied.resumed}`,
      }
    }

    default:
      return { type: event.type, outcome: 'unhandled' }
  }
}

export async function handleStripeEvent(event: Stripe.Event, deps: WebhookDeps = {}): Promise<WebhookResult> {
  const outcome = await withDelivery(
    { id: event.id, type: event.type, account: deliveredAccountOf(event) },
    (record) => dispatch(event, deps, record),
  )
  return outcome.done ? { type: event.type, outcome: 'duplicate' } : outcome.result
}
