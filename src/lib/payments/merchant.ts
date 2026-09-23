/**
 * The merchant-account seam.
 *
 * Every organizer who sells a paid ticket is a *merchant of record* on their own Stripe
 * account: Stripe collects its processing fees from that account and unconference receives
 * only the contribution the organizer chose (the Checkout Session's
 * `payment_intent_data.application_fee_amount`). This file holds the shapes; the Stripe
 * implementation is `stripeMerchantGateway()` in `./stripe`, and tests substitute their own.
 *
 * No Stripe types leak through this interface, so the readiness gate below is exercised
 * without any Stripe key present — which is the only way it can be tested here, since this
 * deployment has none.
 */

/** Which Accounts API created (or is reporting on) the merchant account. */
export type MerchantApi = 'v2' | 'v1'

export interface MerchantReadiness {
  connected: boolean
  accountId: string | null
  /** v1 `charges_enabled`; v2 merchant configuration `card_payments.status === 'active'`. */
  chargesEnabled: boolean
  /** v1 `payouts_enabled`; v2 recipient configuration `stripe_balance.payouts.status === 'active'`. */
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  requirementsDue: string[]
  disabledReason?: string | null
  /** Which API answered. Null when the account is not connected at all. */
  api?: MerchantApi | null
}

export const NOT_CONNECTED_STATUS: MerchantReadiness = {
  connected: false,
  accountId: null,
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
  requirementsDue: [],
  api: null,
}

export interface CreateMerchantInput {
  eventId: string
  eventSlug: string
  eventName: string
  /** Contact address for Stripe's own correspondence with the merchant. Never attested as a business detail. */
  email?: string | null
}

export interface CreateMerchantResult {
  accountId: string
  api: MerchantApi
}

export interface OnboardingLinkInput {
  accountId: string
  refreshUrl: string
  returnUrl: string
}

/**
 * Merchant onboarding and readiness. Onboarding is always Stripe-hosted: identity, country,
 * legal entity and payout details are collected by Stripe from the organizer. The application
 * never attests to a business detail on someone else's behalf.
 */
export interface MerchantGateway {
  createAccount(input: CreateMerchantInput): Promise<CreateMerchantResult>
  onboardingLink(input: OnboardingLinkInput): Promise<string>
  readiness(accountId: string): Promise<MerchantReadiness>
  /** Stripe-hosted dashboard link, when the account's dashboard type allows one. */
  dashboardLink(accountId: string): Promise<string>
}

// ---------------------------------------------------------------------------
// The readiness gate
// ---------------------------------------------------------------------------

export type PaidSalesBlock =
  | { code: 'STRIPE_NOT_CONFIGURED'; reason: string }
  | { code: 'NO_MERCHANT_ACCOUNT'; reason: string }
  | { code: 'ONBOARDING_INCOMPLETE'; reason: string }
  | { code: 'PAYOUTS_DISABLED'; reason: string }
  | { code: 'PAYMENTS_PAUSED'; reason: string }
  | { code: 'READINESS_UNKNOWN'; reason: string }

export interface PaidSalesGateInput {
  /** Does the gathering have at least one tier that costs money? Free-only ticketing never touches Stripe. */
  hasPaidTiers: boolean
  /** A platform secret key and a webhook secret are both present. */
  stripeConfigured: boolean
  /** Readiness as the merchant gateway reported it, or null when it could not be read. */
  readiness: MerchantReadiness | null
  /** The opt-in fallback that charges the platform account when no merchant is connected. */
  platformFallbackAllowed?: boolean
  /**
   * Set when an `account.updated` delivery reported that the merchant lost a capability
   * (`events.paid_sales_paused_reason`). Paid sales stay refused until Stripe says otherwise,
   * even if a stale readiness read still looks healthy.
   */
  pausedReason?: string | null
}

/**
 * Why paid sales may not be switched on — `null` means they may. Used by the ticketing
 * settings route (which refuses the write), the checkout route (which refuses the charge)
 * and the admin page (which shows the reason before either is attempted), so the three can
 * never disagree.
 */
export function paidSalesBlock(input: PaidSalesGateInput): PaidSalesBlock | null {
  if (!input.hasPaidTiers) return null
  if (!input.stripeConfigured) {
    return {
      code: 'STRIPE_NOT_CONFIGURED',
      reason:
        'Payments are not activated on this deployment, so paid tickets cannot be sold. Free tiers still work once every paid tier is removed or deactivated.',
    }
  }
  if (input.pausedReason) {
    return {
      code: 'PAYMENTS_PAUSED',
      reason: `${input.pausedReason} Paid ticket sales are paused until it is resolved in your Stripe dashboard; free tickets and tickets already sold are unaffected.`,
    }
  }
  if (!input.readiness) {
    return {
      code: 'READINESS_UNKNOWN',
      reason: 'Your Stripe account could not be checked just now. Try again in a moment.',
    }
  }
  if (!input.readiness.connected || !input.readiness.accountId) {
    if (input.platformFallbackAllowed) return null
    return {
      code: 'NO_MERCHANT_ACCOUNT',
      reason:
        'Connect a Stripe account before enabling ticket sales. You have paid ticket types and there is no merchant account to receive the money.',
    }
  }
  if (!input.readiness.chargesEnabled) {
    return {
      code: 'ONBOARDING_INCOMPLETE',
      reason:
        'Stripe has not finished verifying your account, so it cannot accept charges yet. Finish onboarding, then try again.',
    }
  }
  if (!input.readiness.payoutsEnabled) {
    return {
      code: 'PAYOUTS_DISABLED',
      reason:
        'Stripe can accept charges for your account but cannot pay out yet. Finish the outstanding payout requirements before selling tickets.',
    }
  }
  return null
}
