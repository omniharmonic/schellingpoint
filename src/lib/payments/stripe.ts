import 'server-only'
import Stripe from 'stripe'

/**
 * Stripe is optional: without STRIPE_SECRET_KEY every payment route answers 503 and free
 * tickets keep working. Checkout metadata carries only opaque internal ids (ticket, event,
 * tier, holder account uuid) — never a DID or a name; the purchaser's email is passed only as
 * the receipt address.
 */
export { formatPrice, calculatePlatformFee } from './format'

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

/**
 * Whether checkout may fall back to charging the platform account when an
 * event has no connected Stripe account. Opt-in via env so organizers are
 * nudged to connect their own account (Stripe Connect is the intended path).
 */
export function isPlatformChargeFallbackAllowed(): boolean {
  return process.env.STRIPE_ALLOW_PLATFORM_CHARGES === 'true'
}

/**
 * Create a Stripe Checkout session for one capacity hold. `expiresAt` is the hold's expiry, so
 * the session cannot be paid after the seat is released. The webhook finds the hold by
 * `metadata.ticket_id`; `tier_id` and `holder_id` let it settle a payment whose hold row was
 * already swept.
 */
export async function createCheckoutSession({
  ticketId,
  tierId,
  holderId,
  expiresAt,
  tierName,
  priceCents,
  platformFeeCents,
  currency,
  eventId,
  eventName,
  customerEmail,
  stripeAccountId,
  successUrl,
  cancelUrl,
}: {
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
}): Promise<Stripe.Checkout.Session> {
  if (!stripe) {
    throw new Error('Stripe is not configured')
  }

  const metadata = { ticket_id: ticketId, event_id: eventId, tier_id: tierId, holder_id: holderId, platform_fee_cents: String(platformFeeCents) }

  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    mode: 'payment',
    line_items: [
      {
        price_data: {
          currency,
          product_data: { name: tierName, description: `Ticket for ${eventName}` },
          unit_amount: priceCents,
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: ticketId,
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    metadata,
    payment_intent_data: { metadata },
    // Equal to the capacity hold's expiry (src/lib/tickets CHECKOUT_HOLD_SECONDS).
    expires_at: Math.floor(expiresAt.getTime() / 1000),
  }

  // The fee is snapshotted when the checkout hold is created.
  if (stripeAccountId) {
    sessionParams.payment_intent_data = {
      ...sessionParams.payment_intent_data,
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: stripeAccountId },
    }
  }

  return stripe.checkout.sessions.create(sessionParams)
}

/**
 * Close an open Checkout session so it can no longer be paid (a holder restarting checkout).
 * Returns the session's resulting status; `complete` means it was already paid.
 */
export async function expireCheckoutSession(sessionId: string): Promise<'expired' | 'complete' | 'open'> {
  if (!stripe) throw new Error('Stripe is not configured')
  const session = await stripe.checkout.sessions.retrieve(sessionId)
  if (session.status === 'open') {
    const closed = await stripe.checkout.sessions.expire(sessionId)
    return closed.status === 'expired' ? 'expired' : closed.status === 'complete' ? 'complete' : 'open'
  }
  return session.status === 'complete' ? 'complete' : 'expired'
}

/**
 * Retrieve a checkout session by ID
 */
export async function getCheckoutSession(sessionId: string): Promise<Stripe.Checkout.Session | null> {
  if (!stripe) return null

  try {
    return await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    })
  } catch {
    return null
  }
}

/**
 * Verify Stripe webhook signature
 */
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
// Stripe Connect (Express) helpers
// API shapes verified against docs.stripe.com/connect/onboarding/quickstart,
// docs.stripe.com/api/accounts/login_link and stripe-node v20 typings.
// ---------------------------------------------------------------------------

export interface ConnectAccountStatus {
  connected: boolean
  accountId: string | null
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requirementsDue: string[]
  disabledReason?: string | null
}

export const NOT_CONNECTED_STATUS: ConnectAccountStatus = {
  connected: false,
  accountId: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: [],
}

/**
 * Create an Express connected account for an event.
 * POST /v1/accounts — type=express, card_payments + transfers capabilities.
 */
export async function createConnectAccount({
  eventId,
  eventSlug,
  eventName,
  email,
}: {
  eventId: string
  eventSlug: string
  eventName: string
  email?: string | null
}): Promise<Stripe.Account> {
  if (!stripe) throw new Error('Stripe is not configured')

  return stripe.accounts.create({
    type: 'express',
    email: email || undefined,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    business_profile: {
      name: eventName,
    },
    metadata: {
      event_id: eventId,
      event_slug: eventSlug,
    },
  }, { idempotencyKey: `unconference-connect-${eventId}` })
}

/**
 * Create a single-use hosted onboarding link for a connected account.
 * POST /v1/account_links — type=account_onboarding.
 */
export async function createOnboardingLink({
  accountId,
  refreshUrl,
  returnUrl,
}: {
  accountId: string
  refreshUrl: string
  returnUrl: string
}): Promise<string> {
  if (!stripe) throw new Error('Stripe is not configured')

  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: refreshUrl,
    return_url: returnUrl,
  })
  return link.url
}

/**
 * Retrieve a connected account and summarise its readiness.
 * GET /v1/accounts/:id — charges_enabled, payouts_enabled, details_submitted,
 * requirements.currently_due.
 */
export async function getConnectAccountStatus(accountId: string): Promise<ConnectAccountStatus> {
  if (!stripe) throw new Error('Stripe is not configured')

  const account = await stripe.accounts.retrieve(accountId)
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
  }
}

/**
 * Create an Express Dashboard login link for a connected account.
 * POST /v1/accounts/:id/login_links (stripe-node: accounts.createLoginLink).
 */
export async function createDashboardLoginLink(accountId: string): Promise<string> {
  if (!stripe) throw new Error('Stripe is not configured')

  const link = await stripe.accounts.createLoginLink(accountId)
  return link.url
}
