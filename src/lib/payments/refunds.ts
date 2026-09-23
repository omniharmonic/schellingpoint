import 'server-only'
import { sql, tx } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { formatPrice } from './format'

/**
 * Refunds, issued by the application on the organizer's behalf.
 *
 * A direct charge lives on the organizer's own Stripe account, so the refund must be issued
 * **in that account's context** — a platform-scoped call cannot even see the payment. That is
 * the whole reason this goes through a gateway that takes the connected account id rather
 * than through a bare `stripe.refunds.create`.
 *
 * The application fee is a separate decision, and the organizer makes it:
 *
 *   full refund     `refundApplicationFee` defaults to **true** — the sale is undone, so the
 *                   contribution is given back with it — and admission is revoked.
 *   partial refund  the fee is left alone by default and admission is *not* touched: the
 *                   holder still has their ticket, they simply paid less for it.
 *
 * Nothing here is inferred: the reference records the amount refunded and the amount of the
 * contribution returned, and the ticket is only cancelled when the refund covers the whole
 * quoted price.
 */

export interface RefundGateway {
  refund(input: {
    paymentIntentId: string
    connectedAccountId: string | null
    /**
     * Always explicit, never "whatever is left": the amount comes from the immutable checkout
     * reference, so the application refunds exactly what it believes is outstanding and Stripe
     * refuses anything larger rather than silently returning a different number.
     */
    amountCents: number
    refundApplicationFee: boolean
    /**
     * Sent to Stripe as the request's idempotency key. A retried refund — a double-clicked
     * button, a webhook redelivery, a crash between the Stripe call and our own write — must
     * return the *same* refund rather than send the money twice.
     */
    idempotencyKey: string
  }): Promise<{
    id: string
    /** What this refund returned. */
    amountCents: number
    /**
     * Stripe's **cumulative** application-fee reversal for the charge, not this call's share.
     * It is stored as a high-water mark, so a replay cannot inflate it.
     */
    applicationFeeRefundedTotalCents: number
  }>
}

export type RefundFailure = {
  ok: false
  status: number
  code:
    | 'TICKET_NOT_FOUND'
    | 'NOT_A_PAYMENT'
    | 'NO_REFERENCE'
    | 'ALREADY_REFUNDED'
    | 'AMOUNT_TOO_LARGE'
    | 'INVALID_AMOUNT'
    | 'PAYMENTS_UNAVAILABLE'
    | 'REFUND_FAILED'
  error: string
}

export type RefundResult =
  | {
      ok: true
      refundId: string
      amountCents: number
      applicationFeeRefundedCents: number
      full: boolean
      admissionRevoked: boolean
    }
  | RefundFailure

interface RefundableTicket {
  ticket_id: string
  status: string
  holder_id: string
  payment_intent_id: string | null
  tier_name: string | null
  event_name: string
  event_slug: string
  session_id: string
  connected_account_id: string | null
  unit_amount: number
  currency: string
  application_fee_amount: number
  refunded_amount: number
  application_fee_refunded_amount: number
}

export async function refundTicket(
  input: {
    eventId: string
    ticketId: string
    /** null or omitted = the whole remaining amount. */
    amountCents?: number | null
    /** Defaults to true for a full refund, false for a partial one. */
    refundApplicationFee?: boolean
  },
  gateway: RefundGateway | null,
): Promise<RefundResult> {
  if (!gateway) {
    return { ok: false, status: 503, code: 'PAYMENTS_UNAVAILABLE', error: 'Payments are not configured on this deployment' }
  }

  const [row] = await sql<RefundableTicket[]>`
    select tk.id as ticket_id, tk.status, tk.user_id as holder_id, tk.payment_intent_id,
           tt.name as tier_name, e.name as event_name, e.slug as event_slug,
           cr.session_id, cr.connected_account_id, cr.unit_amount, cr.currency,
           cr.application_fee_amount, cr.refunded_amount, cr.application_fee_refunded_amount
    from tickets tk
    join events e on e.id = tk.event_id
    left join ticket_tiers tt on tt.id = tk.tier_id
    join checkout_references cr on cr.ticket_id = tk.id
    where tk.id = ${input.ticketId} and tk.event_id = ${input.eventId}
    order by cr.created_at desc
    limit 1
  `
  if (!row) {
    // Either no such ticket at this gathering, or a free/legacy one with no reference: never
    // guess at a payment we have no record of.
    const [exists] = await sql<{ n: number }[]>`
      select count(*)::int as n from tickets where id = ${input.ticketId} and event_id = ${input.eventId}
    `
    return exists.n > 0
      ? { ok: false, status: 409, code: 'NO_REFERENCE', error: 'This ticket has no recorded payment to refund' }
      : { ok: false, status: 404, code: 'TICKET_NOT_FOUND', error: 'Ticket not found' }
  }
  if (!row.payment_intent_id) {
    return { ok: false, status: 409, code: 'NOT_A_PAYMENT', error: 'This ticket has no settled payment to refund' }
  }

  const remaining = row.unit_amount - row.refunded_amount
  if (remaining <= 0) {
    return { ok: false, status: 409, code: 'ALREADY_REFUNDED', error: 'This payment has already been refunded in full' }
  }
  const requested = input.amountCents ?? remaining
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return { ok: false, status: 400, code: 'INVALID_AMOUNT', error: 'Enter a refund amount greater than zero' }
  }
  if (requested > remaining) {
    return {
      ok: false,
      status: 400,
      code: 'AMOUNT_TOO_LARGE',
      error: `At most ${formatPrice(remaining, row.currency)} is left to refund on this payment`,
    }
  }

  const full = requested === remaining && row.refunded_amount + requested === row.unit_amount
  const refundApplicationFee = input.refundApplicationFee ?? full

  let refund: { id: string; amountCents: number; applicationFeeRefundedTotalCents: number }
  try {
    refund = await gateway.refund({
      paymentIntentId: row.payment_intent_id,
      connectedAccountId: row.connected_account_id,
      amountCents: requested,
      refundApplicationFee,
      idempotencyKey: `refund-${row.session_id}-${requested}`,
    })
  } catch (err) {
    console.error('[refunds] Stripe refused the refund:', err instanceof Error ? err.name : 'error')
    return { ok: false, status: 502, code: 'REFUND_FAILED', error: 'Stripe could not process this refund. Try again from your Stripe dashboard.' }
  }

  const admissionRevoked = full && ['pending', 'confirmed', 'checked_in', 'refund_needed'].includes(row.status)
  await tx(async (t) => {
    await t`
      update checkout_references
      set refunded_amount = least(unit_amount, refunded_amount + ${refund.amountCents}),
          -- Stripe reports the fee reversal cumulatively; take the high-water mark so a
          -- redelivered or retried refund cannot add the same reversal twice.
          application_fee_refunded_amount = least(application_fee_amount, greatest(application_fee_refunded_amount, ${refund.applicationFeeRefundedTotalCents})),
          refunded_at = ${full ? t`coalesce(refunded_at, now())` : t`refunded_at`}
      where session_id = ${row.session_id}
    `
    if (full) {
      // The same tombstone the webhook writes, so a completion replayed afterwards cannot
      // restore the entitlement this refund just took away.
      const { createHash } = await import('node:crypto')
      await t`insert into refunded_payments (payment_fingerprint)
        values (${createHash('sha256').update(row.payment_intent_id!).digest('hex')}) on conflict do nothing`
      await t`
        update tickets set status = 'cancelled', hold_expires_at = null, updated_at = now()
        where id = ${row.ticket_id} and status in ('pending', 'confirmed', 'checked_in', 'refund_needed')
      `
      await notify(t, {
        eventId: input.eventId,
        userIds: [row.holder_id],
        type: 'ticket_refunded',
        title: 'Your ticket was refunded',
        body: `${formatPrice(refund.amountCents, row.currency)} for ${row.tier_name ?? 'your ticket'} at ${row.event_name} has been refunded. The ticket no longer admits you; the money takes a few days to reach your card.`,
        actionUrl: `/e/${row.event_slug}/tickets`,
        data: { ticket_id: row.ticket_id },
      })
    }
  })

  return {
    ok: true,
    refundId: refund.id,
    amountCents: refund.amountCents,
    applicationFeeRefundedCents: refund.applicationFeeRefundedTotalCents,
    full,
    admissionRevoked,
  }
}
