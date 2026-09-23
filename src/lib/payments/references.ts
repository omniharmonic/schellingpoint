import 'server-only'
import type postgres from 'postgres'
import { sql, type Sql } from '@/lib/db'

/**
 * Checkout references: the application's own record of what a Stripe Checkout Session was
 * for (db/migrations/0029). Written before the buyer is sent to Stripe, resolved — never
 * trusted from metadata — before anything is settled, expired or refunded.
 *
 * Connect webhook signatures prove that *Stripe* sent the delivery. They do not prove that
 * the payment behind it is ours: a connected merchant can create their own Checkout Sessions
 * with any metadata they like on their own account. The only safe binding is this row:
 * the session id must be one we opened, its connected account must be both the account the
 * delivery arrived on and the account the gathering is connected to today, and the money
 * must match the quote recorded here.
 */

export type ChargeModel = 'direct' | 'destination' | 'platform'

export interface CheckoutReference {
  id: string
  session_id: string
  connected_account_id: string | null
  event_id: string
  tier_id: string | null
  ticket_id: string | null
  holder_account_id: string | null
  unit_amount: number
  currency: string
  contribution_percent: number
  application_fee_amount: number
  model: ChargeModel
  created_at: string
  settled_at: string | null
  expired_at: string | null
  /** Set only by a full refund: the moment admission was revoked. */
  refunded_at: string | null
  /** Accumulated refunds, in the smallest currency unit. Partial refunds leave admission alone. */
  refunded_amount: number
  application_fee_refunded_amount: number
}

/** `contribution_percent` is numeric; postgres.js returns numerics as strings, so cast it. */
function selectColumns(db: Sql) {
  return db`id, session_id, connected_account_id, event_id, tier_id, ticket_id, holder_account_id,
    unit_amount, currency, contribution_percent::float8 as contribution_percent,
    application_fee_amount, model, created_at, settled_at, expired_at, refunded_at,
    refunded_amount, application_fee_refunded_amount`
}

export interface WriteReferenceInput {
  sessionId: string
  connectedAccountId: string | null
  eventId: string
  tierId: string
  ticketId: string
  holderAccountId: string
  unitAmount: number
  currency: string
  contributionPercent: number
  applicationFeeAmount: number
  model: ChargeModel
}

/**
 * Record the quote for a session. Called inside the checkout transaction, before the URL is
 * handed to the browser, so a payment can never arrive for a session we cannot vouch for.
 */
export async function writeCheckoutReference(db: Sql, input: WriteReferenceInput): Promise<CheckoutReference> {
  const [row] = await db<CheckoutReference[]>`
    insert into checkout_references
      (session_id, connected_account_id, event_id, tier_id, ticket_id, holder_account_id,
       unit_amount, currency, contribution_percent, application_fee_amount, model)
    values (${input.sessionId}, ${input.connectedAccountId}, ${input.eventId}, ${input.tierId},
            ${input.ticketId}, ${input.holderAccountId}, ${input.unitAmount}, ${input.currency},
            ${input.contributionPercent}, ${input.applicationFeeAmount}, ${input.model})
    returning ${selectColumns(db)}
  `
  return row
}

/** The reference for a session id, or null. */
export async function findCheckoutReference(sessionId: string, db: Sql = sql): Promise<CheckoutReference | null> {
  const [row] = await db<CheckoutReference[]>`
    select ${selectColumns(db)} from checkout_references where session_id = ${sessionId}
  `
  return row ?? null
}

/** The reference for a hold, used when a checkout is restarted and its old session must be expired. */
export async function findReferenceForTicket(ticketId: string, db: Sql = sql): Promise<CheckoutReference | null> {
  const [row] = await db<CheckoutReference[]>`
    select ${selectColumns(db)} from checkout_references
    where ticket_id = ${ticketId} order by created_at desc limit 1
  `
  return row ?? null
}

export type ReferenceRejection =
  | 'NO_REFERENCE'
  | 'ACCOUNT_MISMATCH'
  | 'EVENT_ACCOUNT_CHANGED'
  | 'AMOUNT_MISMATCH'

export type ReferenceResolution =
  | { ok: true; reference: CheckoutReference }
  /**
   * `reference` is present whenever the session *was* one of ours and the refusal is about
   * something else (the gathering moved account, or the money does not match the quote). That
   * is what lets the webhook give a wrongly-taken payment back: with no reference the payment
   * is not provably ours and must never be refunded from here.
   */
  | { ok: false; rejection: ReferenceRejection; reference?: CheckoutReference }

/**
 * Resolve a delivery to a reference we wrote, or refuse it.
 *
 *   `deliveredAccount`  the `account` field of the webhook envelope: the connected account
 *                       the event was delivered for, or null for a platform-scoped delivery.
 *   `amountTotal`       when given, must equal the price quoted at checkout.
 *
 * Both account checks must pass: the delivery has to have arrived on the account the session
 * was opened in, *and* the gathering has to still be connected to that account. An organizer
 * who reconnects a different account mid-checkout gets a refusal, not a settlement.
 */
export async function resolveDelivery(
  input: { sessionId: string; deliveredAccount: string | null; amountTotal?: number | null },
  db: Sql = sql,
): Promise<ReferenceResolution> {
  const reference = await findCheckoutReference(input.sessionId, db)
  if (!reference) return { ok: false, rejection: 'NO_REFERENCE' }

  // A direct charge is delivered on the merchant's account; the legacy destination and
  // platform models were charged on the platform and are delivered without one.
  const expectedDelivery = reference.model === 'direct' ? reference.connected_account_id : null
  // No `reference` on the way out: a delivery on the wrong account is not proof that the
  // payment it names is ours, so nothing may be refunded in response to it.
  if ((input.deliveredAccount ?? null) !== expectedDelivery) return { ok: false, rejection: 'ACCOUNT_MISMATCH', reference: undefined }

  const [event] = await db<{ stripe_account_id: string | null }[]>`
    select stripe_account_id from events where id = ${reference.event_id}
  `
  if (!event || (event.stripe_account_id ?? null) !== (reference.connected_account_id ?? null)) {
    return { ok: false, rejection: 'EVENT_ACCOUNT_CHANGED', reference }
  }

  if (input.amountTotal !== undefined && input.amountTotal !== null && input.amountTotal !== reference.unit_amount) {
    return { ok: false, rejection: 'AMOUNT_MISMATCH', reference }
  }

  return { ok: true, reference }
}

/**
 * Stamp a lifecycle timestamp once. Replays and out-of-order deliveries are no-ops: the
 * column is only written while it is still null, so the first delivery wins and the return
 * value reports whether this call was the one that did it.
 */
export async function markReference(
  sessionId: string,
  field: 'settled_at' | 'expired_at' | 'refunded_at',
  db: Sql = sql,
): Promise<boolean> {
  const result =
    field === 'settled_at'
      ? await db`update checkout_references set settled_at = now() where session_id = ${sessionId} and settled_at is null`
      : field === 'expired_at'
        ? await db`update checkout_references set expired_at = now() where session_id = ${sessionId} and expired_at is null`
        : await db`update checkout_references set refunded_at = now() where session_id = ${sessionId} and refunded_at is null`
  return result.count > 0
}

/**
 * Mark the settled sales behind these sessions fully refunded.
 *
 * Scoped by session id *and* `settled_at`, never by hold alone: a holder who restarts checkout
 * reuses their hold, so one ticket can carry several references and all but the last were
 * never paid. Marking those refunded would invent money that went back.
 */
export async function markReferencesRefundedForSessions(
  db: postgres.TransactionSql,
  sessionIds: readonly string[],
): Promise<number> {
  const ids = sessionIds.filter((id): id is string => Boolean(id))
  if (ids.length === 0) return 0
  const result = await db`
    update checkout_references
    set refunded_at = coalesce(refunded_at, now()),
        refunded_amount = unit_amount
    where session_id in ${db(ids)}
      and settled_at is not null
      and refunded_amount < unit_amount
  `
  return result.count
}

/**
 * A partial refund reported by Stripe. `amountRefunded` is Stripe's *cumulative* total for the
 * charge, so it is taken as a high-water mark rather than added: replays and out-of-order
 * deliveries cannot inflate it.
 */
export async function recordPartialRefund(
  db: Sql,
  input: { paymentIntentId: string; amountRefunded: number },
): Promise<number> {
  const result = await db`
    update checkout_references
    set refunded_amount = least(unit_amount, greatest(refunded_amount, ${input.amountRefunded}))
    where settled_at is not null
      and session_id in (
        select checkout_session_id from tickets
        where payment_intent_id = ${input.paymentIntentId} and checkout_session_id is not null
      )
  `
  return result.count
}
