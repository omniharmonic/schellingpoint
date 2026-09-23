import { randomUUID } from 'node:crypto'
import type Stripe from 'stripe'
import type { CheckoutGateway } from '../../src/lib/tickets'
import type { MerchantGateway, MerchantReadiness } from '../../src/lib/payments/merchant'

/**
 * The payment fakes. Nothing here ships: the application defines the seams
 * (`CheckoutGateway`, `MerchantGateway`) and the tests supply the only substitutes, so no
 * pretend-Stripe code can ever run in production.
 *
 * Between them these cover what this deployment cannot exercise for real — it holds no Stripe
 * key at all: onboarding readiness true and false, a session opened in a connected account's
 * context, and completed / failed / expired / refunded deliveries arriving on the right
 * account, on the wrong one, twice, and out of order.
 */

export interface FakeCheckoutCall {
  sessionId: string
  /** The account the session was opened in — null means a platform-scoped call. */
  account: string | null
  priceCents: number
  platformFeeCents: number
  currency: string
  ticketId: string
  expiresAt: Date
}

export interface FakeCheckoutGateway {
  gateway: CheckoutGateway
  created: FakeCheckoutCall[]
  /** [sessionId, accountContext] for each expire call. */
  expired: Array<[string, string | null]>
}

/** Stands in for Stripe at the CheckoutGateway boundary, recording the account context used. */
export function fakeCheckoutGateway(opts: { fail?: boolean; expireResult?: 'expired' | 'complete' | 'open' } = {}): FakeCheckoutGateway {
  const created: FakeCheckoutCall[] = []
  const expired: Array<[string, string | null]> = []
  const gateway: CheckoutGateway = {
    createSession: async (input) => {
      if (opts.fail) throw new Error('stripe down')
      const id = `cs_test_${randomUUID().replace(/-/g, '')}`
      created.push({
        sessionId: id,
        account: input.stripeAccountId ?? null,
        priceCents: input.priceCents,
        platformFeeCents: input.platformFeeCents,
        currency: input.currency,
        ticketId: input.ticketId,
        expiresAt: input.expiresAt,
      })
      return { id, url: `https://checkout.stripe.test/${id}` }
    },
    expireSession: async (sessionId, connectedAccountId) => {
      expired.push([sessionId, connectedAccountId])
      return opts.expireResult ?? 'expired'
    },
  }
  return { gateway, created, expired }
}

/**
 * A merchant gateway whose accounts start un-onboarded and become ready when the test says so.
 * `createAccount` reports `v2`, matching the Accounts v2 path the real gateway prefers.
 */
export function fakeMerchantGateway(initial: Record<string, Partial<MerchantReadiness>> = {}) {
  const accounts = new Map<string, MerchantReadiness>()
  const set = (accountId: string, patch: Partial<MerchantReadiness>) => {
    accounts.set(accountId, {
      connected: true,
      accountId,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsDue: [],
      api: 'v2',
      ...patch,
    })
  }
  for (const [id, patch] of Object.entries(initial)) set(id, patch)

  const gateway: MerchantGateway = {
    createAccount: async () => {
      const accountId = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      set(accountId, { requirementsDue: ['identity.individual.first_name'] })
      return { accountId, api: 'v2' }
    },
    onboardingLink: async ({ accountId }) => `https://connect.stripe.test/onboard/${accountId}`,
    readiness: async (accountId) => {
      const found = accounts.get(accountId)
      if (!found) throw new Error(`no such account: ${accountId}`)
      return found
    },
    dashboardLink: async (accountId) => `https://dashboard.stripe.test/${accountId}`,
  }

  return {
    gateway,
    /** Finish onboarding: charges and payouts both live. */
    complete(accountId: string) {
      set(accountId, { chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true })
    },
    /** Charges work but the payout requirements are still outstanding. */
    chargesOnly(accountId: string) {
      set(accountId, { chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true, requirementsDue: ['external_account'] })
    },
    set,
  }
}

export interface FakeRefundCall {
  paymentIntentId: string
  connectedAccountId: string | null
  amountCents: number
  refundApplicationFee: boolean
  idempotencyKey: string
}

/**
 * Stands in for Stripe's refunds API, recording the account context, the exact amount and the
 * fee decision — the three things a direct-charge refund must get right.
 */
export function fakeRefundGateway(opts: { fail?: boolean; feePercent?: number } = {}) {
  const calls: FakeRefundCall[] = []
  const feePercent = opts.feePercent ?? 10
  // Stripe reports the application-fee reversal cumulatively per charge, and honours the
  // idempotency key: a repeated key returns the first refund instead of sending money again.
  const feeTotals = new Map<string, number>()
  const byKey = new Map<string, { id: string; amountCents: number; applicationFeeRefundedTotalCents: number }>()
  const gateway: import('../../src/lib/payments/refunds').RefundGateway = {
    refund: async (input) => {
      if (opts.fail) throw new Error('stripe refused the refund')
      const seen = byKey.get(input.idempotencyKey)
      if (seen) return seen
      calls.push(input)
      const reversed = input.refundApplicationFee ? Math.round((input.amountCents * feePercent) / 100) : 0
      const total = (feeTotals.get(input.paymentIntentId) ?? 0) + reversed
      feeTotals.set(input.paymentIntentId, total)
      const refund = {
        id: `re_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        amountCents: input.amountCents,
        applicationFeeRefundedTotalCents: total,
      }
      byKey.set(input.idempotencyKey, refund)
      return refund
    },
  }
  return { gateway, calls }
}

/**
 * A Stripe event envelope as the webhook receives it. `account` is what a Connect delivery
 * carries: the connected account the event happened on, absent for a platform-scoped one.
 */
export function stripeEvent<T>(
  type: string,
  object: T,
  options: { account?: string | null; livemode?: boolean } = {},
): Stripe.Event {
  return {
    id: `evt_test_${randomUUID().replace(/-/g, '')}`,
    object: 'event',
    api_version: '2026-01-28.clover',
    created: Math.floor(Date.now() / 1000),
    livemode: options.livemode ?? false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
    ...(options.account ? { account: options.account } : {}),
  } as unknown as Stripe.Event
}

/** A minimal paid `checkout.session` object. */
export function paidSession(input: { sessionId: string; amountTotal: number; paymentIntentId: string; currency?: string }) {
  return {
    id: input.sessionId,
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    amount_total: input.amountTotal,
    currency: input.currency ?? 'usd',
    payment_intent: input.paymentIntentId,
    // Deliberately wrong: nothing may be settled from metadata.
    metadata: { ticket_id: randomUUID(), event_id: randomUUID() },
  }
}
