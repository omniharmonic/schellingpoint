import 'server-only'
import Stripe from 'stripe'
import {
  NOT_CONNECTED_STATUS,
  type CreateMerchantInput,
  type CreateMerchantResult,
  type MerchantGateway,
  type MerchantReadiness,
  type OnboardingLinkInput,
} from './merchant'
import type { CachedMerchantStatus } from './merchant-status'
import type { RefundGateway } from './refunds'

/**
 * Stripe is optional: without STRIPE_SECRET_KEY every payment route answers 503 and free
 * tickets keep working. Checkout metadata carries only opaque internal ids (ticket, event,
 * tier, holder account uuid) — never a DID or a name; the purchaser's email is passed only as
 * the receipt address. Metadata is a convenience for reading a payment in the Stripe
 * dashboard and is never trusted on the way back in: settlement resolves
 * `checkout_references` by session id (see db/migrations/0029).
 *
 * Charge model: **direct charges on the organizer's own account**. The Checkout Session is
 * created in that account's API context (`{ stripeAccount }`), the platform's cut is
 * `payment_intent_data.application_fee_amount`, and there is no `transfer_data` — Stripe
 * collects its processing fees from the organizer, not from the platform. A 1% contribution
 * is therefore 1% of revenue to the platform, never a loss.
 */
export { formatPrice, calculatePlatformFee } from './format'
export { NOT_CONNECTED_STATUS } from './merchant'
export type { MerchantReadiness, MerchantGateway } from './merchant'

const stripeSecretKey = process.env.STRIPE_SECRET_KEY

export const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, {
      apiVersion: '2026-01-28.clover',
      typescript: true,
      timeout: 15000,
      maxNetworkRetries: 1,
    })
  : null

/** True when a platform secret key is present and Stripe calls can be made. */
export function isStripeConfigured(): boolean {
  return stripe !== null
}

/** A key and a webhook secret: both are needed before a paid checkout may be opened. */
export function isPaymentsActivated(): boolean {
  return Boolean(stripe && process.env.STRIPE_WEBHOOK_SECRET)
}

/**
 * Live or test, decided by the key itself. Webhook deliveries whose `livemode` disagrees are
 * refused, so a sandbox destination pointed at a live deployment (or the reverse) can never
 * settle a ticket. `null` when no key is configured.
 */
export function stripeKeyLivemode(): boolean | null {
  if (!stripeSecretKey) return null
  return /^(sk|rk)_live_/.test(stripeSecretKey)
}

/**
 * Whether checkout may fall back to charging the platform account when an
 * event has no connected Stripe account. Opt-in via env so organizers are
 * nudged to connect their own account (Stripe Connect is the intended path).
 */
export function isPlatformChargeFallbackAllowed(): boolean {
  return process.env.STRIPE_ALLOW_PLATFORM_CHARGES === 'true'
}

/**
 * The request options that put a call in the connected account's context. Everything about a
 * direct charge — creating the session, retrieving it, expiring it, refunding it — happens
 * here; a platform-scoped call cannot even see the session.
 */
export function inAccount(connectedAccountId: string | null | undefined): Stripe.RequestOptions | undefined {
  return connectedAccountId ? { stripeAccount: connectedAccountId } : undefined
}

// ---------------------------------------------------------------------------
// Checkout (direct charges)
// ---------------------------------------------------------------------------

export interface CheckoutSessionInput {
  ticketId: string
  tierId: string
  holderId: string
  expiresAt: Date
  tierName: string
  priceCents: number
  platformFeeCents: number
  currency: string
  eventId: string
  eventName: string
  customerEmail?: string | null
  stripeAccountId?: string | null
  successUrl: string
  cancelUrl: string
}

/**
 * The Checkout Session parameters for one capacity hold. Exported so the shape can be asserted
 * without a Stripe key: with a connected account this must be a **direct charge** —
 * `application_fee_amount` and *no* `transfer_data`. `transfer_data` is what makes a charge a
 * destination charge, which bills Stripe's processing fees to the platform and can turn a 1%
 * contribution into a loss; it must never appear here.
 *
 * `expiresAt` is the hold's expiry, so the session cannot be paid after the seat is released.
 */
export function buildCheckoutSessionParams(input: CheckoutSessionInput): Stripe.Checkout.SessionCreateParams {
  const metadata = {
    ticket_id: input.ticketId,
    event_id: input.eventId,
    tier_id: input.tierId,
    holder_id: input.holderId,
    platform_fee_cents: String(input.platformFeeCents),
  }

  const paymentIntentData: Stripe.Checkout.SessionCreateParams.PaymentIntentData = { metadata }
  if (input.stripeAccountId && input.platformFeeCents > 0) {
    // Direct charge: the organizer's account is the merchant of record and pays Stripe's
    // processing fees; the platform's cut is this fee and nothing else.
    paymentIntentData.application_fee_amount = input.platformFeeCents
  }

  return {
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency: input.currency,
          product_data: { name: input.tierName, description: `Ticket for ${input.eventName}` },
          unit_amount: input.priceCents,
        },
        quantity: 1,
      },
    ],
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    client_reference_id: input.ticketId,
    ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
    metadata,
    payment_intent_data: paymentIntentData,
    // Equal to the capacity hold's expiry (src/lib/tickets CHECKOUT_HOLD_SECONDS).
    expires_at: Math.floor(input.expiresAt.getTime() / 1000),
  }
}

/** Open the session in the organizer's account context (or the platform's, for the fallback). */
export async function createCheckoutSession(input: CheckoutSessionInput): Promise<{ id: string; url: string | null }> {
  if (!stripe) {
    throw new Error('Stripe is not configured')
  }
  const session = await stripe.checkout.sessions.create(
    buildCheckoutSessionParams(input),
    inAccount(input.stripeAccountId),
  )
  return { id: session.id, url: session.url }
}

/**
 * Close an open Checkout Session so it can no longer be paid (a holder restarting checkout).
 * Retrieval and expiry happen in the session's *original* account context — a session created
 * on a connected account is invisible to a platform-scoped call, so the account id recorded in
 * `checkout_references` is passed back in here.
 */
export async function expireCheckoutSession(
  sessionId: string,
  connectedAccountId: string | null = null,
): Promise<'expired' | 'complete' | 'open'> {
  if (!stripe) throw new Error('Stripe is not configured')
  const options = inAccount(connectedAccountId)
  const session = await stripe.checkout.sessions.retrieve(sessionId, undefined, options)
  if (session.status === 'open') {
    const closed = await stripe.checkout.sessions.expire(sessionId, undefined, options)
    return closed.status === 'expired' ? 'expired' : closed.status === 'complete' ? 'complete' : 'open'
  }
  return session.status === 'complete' ? 'complete' : 'expired'
}

/** Retrieve a checkout session in its original account context. */
export async function getCheckoutSession(
  sessionId: string,
  connectedAccountId: string | null = null,
): Promise<Stripe.Checkout.Session | null> {
  if (!stripe) return null

  try {
    return await stripe.checkout.sessions.retrieve(
      sessionId,
      { expand: ['payment_intent'] },
      inAccount(connectedAccountId),
    )
  } catch {
    return null
  }
}

/**
 * Refund a direct charge **in the account that took it**. A platform-scoped call cannot see
 * the payment at all, so the connected account id is not optional decoration.
 *
 * `refund_application_fee` is always stated explicitly, never left to a default: a refund
 * does not return the platform's contribution unless someone decided it should (see
 * `src/lib/payments/refunds.ts`, where a full refund returns it and a partial one does not).
 */
export async function refundPayment(input: {
  paymentIntentId: string
  connectedAccountId: string | null
  amountCents?: number | null
  refundApplicationFee?: boolean
  /** Required in practice: a retried refund must return the same refund, not send money twice. */
  idempotencyKey?: string
}): Promise<Stripe.Refund> {
  if (!stripe) throw new Error('Stripe is not configured')
  return stripe.refunds.create(
    {
      payment_intent: input.paymentIntentId,
      refund_application_fee: input.refundApplicationFee ?? false,
      ...(input.amountCents ? { amount: input.amountCents } : {}),
    },
    { ...inAccount(input.connectedAccountId), ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}) },
  )
}

/** The Stripe-backed refund gateway, or null when no key is configured. */
export function stripeRefundGateway(): RefundGateway | null {
  if (!stripe) return null
  return {
    async refund(input) {
      const refund = await refundPayment(input)
      // `amount` is this refund; the fee reversal Stripe reports on the charge is cumulative.
      let applicationFeeRefundedTotalCents = 0
      if (input.refundApplicationFee && refund.charge) {
        try {
          const charge = await stripe!.charges.retrieve(
            typeof refund.charge === 'string' ? refund.charge : refund.charge.id,
            { expand: ['application_fee'] },
            inAccount(input.connectedAccountId),
          )
          const fee = charge.application_fee
          if (fee && typeof fee !== 'string') applicationFeeRefundedTotalCents = fee.amount_refunded ?? 0
        } catch {
          // Reporting the reversal is best effort; the refund itself already happened.
        }
      }
      return { id: refund.id, amountCents: refund.amount, applicationFeeRefundedTotalCents }
    },
  }
}

/** Verify Stripe webhook signature against one candidate secret. */
export function constructWebhookEvent(
  payload: string | Buffer,
  signature: string,
  webhookSecret: string
): Stripe.Event {
  if (!stripe) {
    throw new Error('Stripe is not configured')
  }

  return stripe.webhooks.constructEvent(payload, signature, webhookSecret)
}

// ---------------------------------------------------------------------------
// Merchant accounts
// ---------------------------------------------------------------------------
//
// Accounts v2 (`POST /v2/core/accounts`) is the intended path: a merchant configuration with
// `card_payments` requested, `dashboard: 'full'`, and defaults of
// `fees_collector: 'stripe'` / `losses_collector: 'stripe'` — Stripe collects its fees from
// the merchant and carries the loss liability, which is exactly the direct-charge model.
// Hosted onboarding is `POST /v2/core/account_links` with
// `use_case.type: 'account_onboarding'` and `configurations: ['merchant']`.
//
// v2 has to be enabled for the platform. When it is not, Stripe answers the create call with
// an invalid-request/permission error; we then fall back to the v1 equivalent,
// `POST /v1/accounts` with `controller: { fees: { payer: 'account' }, losses: { payments:
// 'stripe' }, stripe_dashboard: { type: 'full' }, requirement_collection: 'stripe' }`, which
// produces an account with the same fee and loss responsibilities. `STRIPE_ACCOUNTS_API=v1`
// forces the fallback without a round trip.

/**
 * Invalid-request/permission codes that mean "not available here". These are the v1-shaped
 * errors; the v2 ones are handled by type below. Kept as documentation of what Stripe has
 * actually answered, and so a *typed* invalid request with one of these codes still falls back.
 *
 * Observed from v2 against the sandbox on 2026-09-25, all three in the same afternoon:
 *   non_connect_platform_accounts_v2_access_blocked — platform was never enabled for v2
 *   identity_country_required — v2 wants the merchant's country before a merchant
 *     configuration; the organizer never gave us one and this application will not invent it
 *   account_not_yet_compatible_with_v2 — a freshly created v1 account is not yet addressable
 *     through the v2 account-links API
 */
const V2_UNAVAILABLE_CODES = new Set([
  'feature_not_enabled',
  'parameter_unknown',
  'url_invalid',
  'resource_missing',
  'non_connect_platform_accounts_v2_access_blocked',
  'identity_country_required',
  'account_not_yet_compatible_with_v2',
])

function prefersV1(): boolean {
  return process.env.STRIPE_ACCOUNTS_API === 'v1'
}

/**
 * Does this Stripe error mean "we cannot do this through Accounts v2 here, use v1"?
 *
 * The decisive rule is the error *type*. The v2 error envelope carries no `type`, so the SDK
 * cannot classify it and reports `StripeUnknownError` — every v2 refusal observed against the
 * sandbox on 2026-09-25 arrived that way, with a different `code` each time (three of them in
 * one afternoon; see `V2_UNAVAILABLE_CODES`). Matching code-by-code is whack-a-mole, and each
 * miss left the organizer with a raw Stripe message and no way to connect at all.
 *
 * Falling back is safe: v1 produces an account with the same fee and loss responsibilities, and
 * its onboarding is Stripe-hosted too, so the worst case is using v1 where v2 would have served.
 * Refusing is not safe — it blocks the organizer. Real failures keep their own types
 * (`StripeConnectionError`, `StripeAPIError`, `StripeRateLimitError`, `StripeAuthenticationError`)
 * and still throw, so an outage or a bad key reaches the organizer instead of being retried
 * pointlessly against v1.
 *
 * Exported so the rule can be asserted against Stripe's real error shapes without a key, the
 * same way `buildCheckoutSessionParams` is.
 */
export function isV2Unavailable(err: unknown): boolean {
  if (!(err instanceof Stripe.errors.StripeError)) return false
  // An answer from v2 that the SDK cannot classify: v2 is not usable for this call. The SDK
  // sets this `type` at runtime but leaves it out of its own union, hence the widening.
  if ((err.type as string) === 'StripeUnknownError') return true
  if (err.code && V2_UNAVAILABLE_CODES.has(err.code)) return true
  if (err.type === 'StripeInvalidRequestError' || err.type === 'StripePermissionError') {
    return err.code ? V2_UNAVAILABLE_CODES.has(err.code) : true
  }
  return false
}

async function createMerchantAccountV2(input: CreateMerchantInput): Promise<CreateMerchantResult> {
  const account = await stripe!.v2.core.accounts.create(
    {
      contact_email: input.email || undefined,
      display_name: input.eventName,
      dashboard: 'full',
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
      },
      defaults: {
        // Stripe collects its processing fees from this account and carries the loss
        // liability: the platform's only cut is the per-checkout application fee.
        responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
      },
      metadata: { event_id: input.eventId, event_slug: input.eventSlug },
    },
    { idempotencyKey: `unconference-merchant-v2-${input.eventId}` },
  )
  return { accountId: account.id, api: 'v2' }
}

async function createMerchantAccountV1(input: CreateMerchantInput): Promise<CreateMerchantResult> {
  const account = await stripe!.accounts.create(
    {
      email: input.email || undefined,
      controller: {
        // The merchant pays Stripe's fees, Stripe carries the losses, and the merchant gets
        // the full Stripe dashboard: the v1 equivalent of the v2 responsibilities above.
        fees: { payer: 'account' },
        losses: { payments: 'stripe' },
        stripe_dashboard: { type: 'full' },
        requirement_collection: 'stripe',
      },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { event_id: input.eventId, event_slug: input.eventSlug },
    },
    { idempotencyKey: `unconference-merchant-v1-${input.eventId}` },
  )
  return { accountId: account.id, api: 'v1' }
}

/** Readiness from the v1 account shape (works for v1 accounts, and for v2 accounts Stripe mirrors into v1). */
function readinessFromV1(account: Stripe.Account): MerchantReadiness {
  return {
    connected: true,
    accountId: account.id,
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    detailsSubmitted: Boolean(account.details_submitted),
    requirementsDue: [
      ...(account.requirements?.currently_due ?? []),
      ...(account.requirements?.past_due ?? []),
    ].filter((v, i, arr) => arr.indexOf(v) === i),
    disabledReason: account.requirements?.disabled_reason ?? null,
    api: 'v1',
  }
}

/** Readiness from the v2 configuration statuses. */
function readinessFromV2(account: Stripe.V2.Core.Account): MerchantReadiness {
  const merchant = account.configuration?.merchant
  const recipient = account.configuration?.recipient
  const entries = account.requirements?.entries ?? []
  return {
    connected: true,
    accountId: account.id,
    chargesEnabled: merchant?.capabilities?.card_payments?.status === 'active',
    payoutsEnabled: recipient?.capabilities?.stripe_balance?.payouts?.status === 'active',
    // v2 reports outstanding collection per requirement entry rather than a single flag.
    detailsSubmitted: entries.length === 0,
    requirementsDue: entries
      .map((entry) => entry.description ?? '')
      .filter((value, index, all) => value !== '' && all.indexOf(value) === index),
    disabledReason: null,
    api: 'v2',
  }
}

/**
 * The Stripe-backed merchant gateway, or null when no key is configured. Onboarding is
 * always Stripe-hosted; this application never sends a business detail it was not given by
 * the organizer themselves.
 */
export function stripeMerchantGateway(): MerchantGateway | null {
  if (!stripe) return null
  const client = stripe
  return {
    async createAccount(input: CreateMerchantInput): Promise<CreateMerchantResult> {
      if (prefersV1()) return createMerchantAccountV1(input)
      try {
        return await createMerchantAccountV2(input)
      } catch (err) {
        if (!isV2Unavailable(err)) throw err
        console.warn('[stripe] Accounts v2 is unavailable on this platform; creating a v1 merchant account instead')
        return createMerchantAccountV1(input)
      }
    },

    async onboardingLink(input: OnboardingLinkInput): Promise<string> {
      if (!prefersV1()) {
        try {
          const link = await client.v2.core.accountLinks.create({
            account: input.accountId,
            use_case: {
              type: 'account_onboarding',
              account_onboarding: {
                configurations: ['merchant'],
                refresh_url: input.refreshUrl,
                return_url: input.returnUrl,
              },
            },
          })
          return link.url
        } catch (err) {
          if (!isV2Unavailable(err)) throw err
        }
      }
      const link = await client.accountLinks.create({
        account: input.accountId,
        type: 'account_onboarding',
        refresh_url: input.refreshUrl,
        return_url: input.returnUrl,
      })
      return link.url
    },

    async readiness(accountId: string): Promise<MerchantReadiness> {
      try {
        return readinessFromV1(await client.accounts.retrieve(accountId))
      } catch (err) {
        // A v2-only account is not always visible through v1; ask v2 before giving up.
        try {
          const account = await client.v2.core.accounts.retrieve(accountId, {
            include: ['configuration.merchant', 'configuration.recipient', 'requirements'],
          })
          return readinessFromV2(account)
        } catch {
          throw err
        }
      }
    },

    async dashboardLink(accountId: string): Promise<string> {
      const link = await client.accounts.createLoginLink(accountId)
      return link.url
    },
  }
}

/**
 * Readiness for an event's account, or `NOT_CONNECTED_STATUS` when there is none.
 *
 * A live read from Stripe is authoritative. When it cannot be made — no key, or Stripe is
 * unreachable — what `account.updated` last told us about the account is used instead
 * (`cached`), so a merchant Stripe has already suspended is not treated as healthy just
 * because we could not ask. With neither, the answer is `null`: unknown, and the readiness
 * gate refuses rather than guesses.
 */
export async function readMerchantReadiness(
  gateway: MerchantGateway | null,
  accountId: string | null,
  cached?: CachedMerchantStatus | null,
): Promise<MerchantReadiness | null> {
  if (!accountId) return NOT_CONNECTED_STATUS
  if (gateway) {
    try {
      return await gateway.readiness(accountId)
    } catch {
      // Fall through to whatever Stripe last told us.
    }
  }
  if (cached && cached.chargesEnabled !== null && cached.payoutsEnabled !== null) {
    return {
      connected: true,
      accountId,
      chargesEnabled: cached.chargesEnabled,
      payoutsEnabled: cached.payoutsEnabled,
      detailsSubmitted: cached.chargesEnabled,
      requirementsDue: [],
      api: null,
    }
  }
  return null
}
