import Stripe from 'stripe'

// Initialize Stripe client
const stripeSecretKey = process.env.STRIPE_SECRET_KEY

if (!stripeSecretKey) {
  console.warn('STRIPE_SECRET_KEY not set - payment features will be disabled')
}

export const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, {
      apiVersion: '2026-01-28.clover',
      typescript: true,
    })
  : null

/** True when a platform secret key is present and Stripe calls can be made. */
export function isStripeConfigured(): boolean {
  return stripe !== null
}

/**
 * Platform application fee: 5% of the ticket price + 50 cents, in cents.
 * Used as `application_fee_amount` on destination charges to connected accounts.
 */
export function calculatePlatformFee(amountCents: number): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0
  return Math.round(amountCents * 0.05) + 50
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
 * Format price in cents to display string
 */
export function formatPrice(cents: number, currency: string = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/**
 * Create a Stripe Checkout session for ticket purchase
 */
export async function createCheckoutSession({
  tierId,
  tierName,
  priceCents,
  currency,
  eventId,
  eventSlug,
  eventName,
  userId,
  userEmail,
  stripeAccountId,
  successUrl,
  cancelUrl,
}: {
  tierId: string
  tierName: string
  priceCents: number
  currency: string
  eventId: string
  eventSlug: string
  eventName: string
  userId: string
  userEmail: string
  stripeAccountId?: string | null
  successUrl: string
  cancelUrl: string
}): Promise<Stripe.Checkout.Session | null> {
  if (!stripe) {
    throw new Error('Stripe is not configured')
  }

  // Build line items
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
    {
      price_data: {
        currency: currency,
        product_data: {
          name: tierName,
          description: `Ticket for ${eventName}`,
        },
        unit_amount: priceCents,
      },
      quantity: 1,
    },
  ]

  // Session parameters
  const sessionParams: Stripe.Checkout.SessionCreateParams = {
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: lineItems,
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: userEmail,
    metadata: {
      tier_id: tierId,
      event_id: eventId,
      event_slug: eventSlug,
      user_id: userId,
    },
    payment_intent_data: {
      metadata: {
        tier_id: tierId,
        event_id: eventId,
        event_slug: eventSlug,
        user_id: userId,
      },
    },
  }

  // If event has connected Stripe account, use it with application fee
  if (stripeAccountId) {
    // Platform takes 5% + $0.50 fee
    const applicationFee = calculatePlatformFee(priceCents)
    sessionParams.payment_intent_data = {
      ...sessionParams.payment_intent_data,
      application_fee_amount: applicationFee,
      transfer_data: {
        destination: stripeAccountId,
      },
    }
  }

  const session = await stripe.checkout.sessions.create(sessionParams)
  return session
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
  })
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
