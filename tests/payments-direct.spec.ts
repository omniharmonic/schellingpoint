import { createHash, randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, withServerOnlyShim, TEST_BASE_URL } from './helpers/gathering'
import { fakeCheckoutGateway, fakeMerchantGateway, fakeRefundGateway, paidSession, stripeEvent } from './helpers/payments'

for (const value of [process.env.DATABASE_MIGRATION_URL, process.env.PDS_INTERNAL_URL || process.env.PDS_URL, TEST_BASE_URL]) {
  if (!value || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) {
    throw new Error('Payment tests require the isolated local database, PDS and AppView')
  }
}

/**
 * Direct charges: the organizer is the merchant of record, the platform takes an application
 * fee, and a signed webhook is only allowed to do what the application's own checkout
 * reference says it may.
 *
 * Real local database, real identities, real routes. Only Stripe is substituted — this
 * deployment holds no key — and only at the two seams the application defines
 * (`CheckoutGateway`, `MerchantGateway`), so every rule below is the shipped rule.
 */

const db = () => postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })

type Tickets = typeof import('../src/lib/tickets')
type Webhook = typeof import('../src/lib/payments/webhook')
type References = typeof import('../src/lib/payments/references')
type StripeLib = typeof import('../src/lib/payments/stripe')
type Merchant = typeof import('../src/lib/payments/merchant')
type Connect = typeof import('../src/lib/payments/connect')
type MerchantStatus = typeof import('../src/lib/payments/merchant-status')
type Refunds = typeof import('../src/lib/payments/refunds')

/* eslint-disable @typescript-eslint/no-require-imports */
const load = <T>(path: string) => withServerOnlyShim(() => require(path) as T)
/* eslint-enable @typescript-eslint/no-require-imports */

test.describe('direct charges', () => {
  test('a $25 ticket at 1% is an application fee of 25 cents with no transfer_data', async () => {
    const stripe = await load<StripeLib>('../src/lib/payments/stripe')
    const { calculatePlatformFee } = stripe

    expect(calculatePlatformFee(2500, 1)).toBe(25)
    expect(calculatePlatformFee(2500, 3)).toBe(75)
    // round(price x percent), with no hidden floor: a ticket too small to round up to a cent
    // contributes nothing rather than being charged a cent the organizer never chose.
    expect(calculatePlatformFee(20, 1)).toBe(0)
    expect(calculatePlatformFee(50, 1)).toBe(1)

    const params = stripe.buildCheckoutSessionParams({
      ticketId: randomUUID(),
      tierId: randomUUID(),
      holderId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      tierName: 'Admission',
      priceCents: 2500,
      platformFeeCents: calculatePlatformFee(2500, 1),
      currency: 'usd',
      eventId: randomUUID(),
      eventName: 'Direct charge check',
      stripeAccountId: 'acct_merchant_direct',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/no',
    })
    const intent = params.payment_intent_data!
    expect(intent.application_fee_amount).toBe(25)
    // `transfer_data` is what makes a charge a destination charge — the model that bills
    // Stripe's processing fees to the platform. It must never be built.
    expect(intent).not.toHaveProperty('transfer_data')
    expect(JSON.stringify(params)).not.toContain('transfer_data')
    // And the call itself is made in the merchant's context.
    expect(stripe.inAccount('acct_merchant_direct')).toEqual({ stripeAccount: 'acct_merchant_direct' })
    expect(stripe.inAccount(null)).toBeUndefined()
  })

  test('checkout opens in the merchant context and records an immutable reference', async () => {
    const sql = db()
    const account = await createTestAccount('direct-ref', { sql })
    const event = await createTestGathering(sql, { tag: 'direct-ref', ticketingEnabled: true })
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const references = await load<References>('../src/lib/payments/references')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount}, platform_fee_percent = 1 where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`

      const fake = fakeCheckoutGateway()
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fake.gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      expect(fake.created).toHaveLength(1)
      expect(fake.created[0]).toMatchObject({ account: merchantAccount, priceCents: 2500, platformFeeCents: 25 })

      const reference = await references.findCheckoutReference(checkout.sessionId, sql)
      expect(reference).toMatchObject({
        session_id: checkout.sessionId,
        connected_account_id: merchantAccount,
        event_id: event.id,
        tier_id: tier.id,
        ticket_id: checkout.ticketId,
        holder_account_id: account.id,
        unit_amount: 2500,
        currency: 'usd',
        contribution_percent: 1,
        application_fee_amount: 25,
        model: 'direct',
        settled_at: null,
      })

      // Immutable: the quote a settlement verifies against cannot be rewritten.
      await expect(
        sql`update checkout_references set unit_amount = 1 where session_id = ${checkout.sessionId}`,
      ).rejects.toMatchObject({ code: '42501' })
      await expect(
        sql`update checkout_references set connected_account_id = 'acct_someone_else' where session_id = ${checkout.sessionId}`,
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('deliveries settle only on the account the session was opened in', async () => {
    const sql = db()
    const account = await createTestAccount('direct-hook', { sql })
    const event = await createTestGathering(sql, { tag: 'direct-hook', ticketingEnabled: true })
    const paymentIntentId = `pi_direct_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const references = await load<References>('../src/lib/payments/references')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount}, platform_fee_percent = 1 where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`

      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)
      const session = paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId })

      // Another merchant replaying our session id on their own account gets nothing.
      // The detail also says what became of the money; `not_ours` means nothing was refunded,
      // because a delivery on the wrong account is no proof that the payment is ours.
      const wrongAccount = await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session, { account: 'acct_attacker' }))
      expect(wrongAccount.outcome).toBe('rejected')
      expect(wrongAccount.detail).toMatch(/^ACCOUNT_MISMATCH/)
      // Neither does a platform-scoped delivery for a direct-charge session.
      const platformScoped = await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session))
      expect(platformScoped.detail).toMatch(/^ACCOUNT_MISMATCH/)
      // Nor an unknown session, however well signed.
      const unknown = await webhook.handleStripeEvent(stripeEvent('checkout.session.completed',
        paidSession({ sessionId: 'cs_not_ours', amountTotal: 2500, paymentIntentId: 'pi_not_ours' }), { account: merchantAccount }))
      expect(unknown.detail).toMatch(/^NO_REFERENCE/)
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('pending')

      // The real delivery settles, and a replay of it changes nothing.
      expect(await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session, { account: merchantAccount })))
        .toMatchObject({ outcome: 'settled', detail: 'confirmed' })
      const settledAt = (await references.findCheckoutReference(checkout.sessionId, sql))!.settled_at
      expect(settledAt).not.toBeNull()
      expect(await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session, { account: merchantAccount })))
        .toMatchObject({ outcome: 'settled', detail: 'already_confirmed' })
      expect((await references.findCheckoutReference(checkout.sessionId, sql))!.settled_at).toEqual(settledAt)

      const [confirmed] = await sql`select status, amount_paid_cents, platform_fee_cents from tickets where id = ${checkout.ticketId}`
      expect(confirmed).toMatchObject({ status: 'confirmed', amount_paid_cents: 2500, platform_fee_cents: 25 })
      expect(await sql`select 1 from event_members where event_id = ${event.id} and user_id = ${account.id}`).toHaveLength(1)

      // Out of order: an expiry that arrives after the payment must not take the seat back.
      expect(await webhook.handleStripeEvent(stripeEvent('checkout.session.expired', { id: checkout.sessionId, object: 'checkout.session' }, { account: merchantAccount })))
        .toMatchObject({ outcome: 'released' })
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('confirmed')

      // A refund delivered on somebody else's account revokes nothing.
      const charge = { id: 'ch_test', object: 'charge', payment_intent: paymentIntentId, refunded: true }
      expect(await webhook.handleStripeEvent(stripeEvent('charge.refunded', charge, { account: 'acct_attacker' })))
        .toMatchObject({ outcome: 'rejected', detail: 'ACCOUNT_MISMATCH' })
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('confirmed')

      // On the merchant's own account it does: admission goes, and the reference records it.
      expect(await webhook.handleStripeEvent(stripeEvent('charge.refunded', charge, { account: merchantAccount })))
        .toMatchObject({ outcome: 'refunded' })
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('cancelled')
      const refunded = (await references.findCheckoutReference(checkout.sessionId, sql))!
      expect(refunded.refunded_at).not.toBeNull()
      // The contribution collected is not reversed by the refund; it is still reported.
      expect(refunded.application_fee_amount).toBe(25)

      // And the completion cannot come back to life afterwards.
      expect(await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session, { account: merchantAccount })))
        .toMatchObject({ outcome: 'ignored' })
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('cancelled')
    } finally {
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(paymentIntentId).digest('hex')}`
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('a gathering that reconnects a different account cannot settle the open checkout', async () => {
    const sql = db()
    const account = await createTestAccount('acct-swap', { sql })
    const event = await createTestGathering(sql, { tag: 'acct-swap', ticketingEnabled: true })
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      await sql`update events set stripe_account_id = 'acct_test_replacement' where id = ${event.id}`
      const session = paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId: 'pi_swap' })
      // No refund gateway here, so the money is left for the organizer and only recorded.
      const refused = await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session, { account: merchantAccount }))
      expect(refused.outcome).toBe('rejected')
      expect(refused.detail).toMatch(/^EVENT_ACCOUNT_CHANGED/)
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('pending')
    } finally {
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('a pre-existing destination-model reference still settles, platform-scoped', async () => {
    const sql = db()
    const account = await createTestAccount('legacy-dest', { sql })
    const event = await createTestGathering(sql, { tag: 'legacy-dest', ticketingEnabled: true })
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const legacyAccount = 'acct_test_legacy_destination'
      await sql`update events set stripe_account_id = ${legacyAccount} where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const hold = await tickets.reserveTicketHold({ eventId: event.id, tierId: tier.id, accountId: account.id })
      if (!hold.ok) throw new Error(hold.error)
      const sessionId = `cs_legacy_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update tickets set checkout_session_id = ${sessionId}, quoted_price_cents = 2500, paid_currency = 'usd' where id = ${hold.ticketId}`
      // The row an older release would have written: a destination charge on the platform.
      await sql`
        insert into checkout_references
          (session_id, connected_account_id, event_id, tier_id, ticket_id, holder_account_id,
           unit_amount, currency, contribution_percent, application_fee_amount, model)
        values (${sessionId}, ${legacyAccount}, ${event.id}, ${tier.id}, ${hold.ticketId}, ${account.id},
                2500, 'usd', 1, 25, 'destination')
      `

      const session = paidSession({ sessionId, amountTotal: 2500, paymentIntentId: `pi_legacy_${sessionId}` })
      // A destination charge lives on the platform: delivered *without* a connected account.
      const onMerchant = await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session, { account: legacyAccount }))
      expect(onMerchant.outcome).toBe('rejected')
      expect(onMerchant.detail).toMatch(/^ACCOUNT_MISMATCH/)
      expect(await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session)))
        .toMatchObject({ outcome: 'settled', detail: 'confirmed' })
      expect((await sql`select status from tickets where id = ${hold.ticketId}`)[0].status).toBe('confirmed')
    } finally {
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update('pi_legacy').digest('hex')}`
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('a payment whose hold was already swept still settles from the reference', async () => {
    const sql = db()
    const account = await createTestAccount('swept-hold', { sql })
    const event = await createTestGathering(sql, { tag: 'swept-hold', ticketingEnabled: true })
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const references = await load<References>('../src/lib/payments/references')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      // The expired-hold sweep runs before the delayed payment arrives.
      await sql`update tickets set hold_expires_at = now() - interval '1 second' where id = ${checkout.ticketId}`
      await sql`delete from tickets where status = 'pending' and hold_expires_at < now()`
      expect((await references.findCheckoutReference(checkout.sessionId, sql))!.ticket_id).toBeNull()

      const session = paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId: `pi_swept_${checkout.ticketId}` })
      expect(await webhook.handleStripeEvent(stripeEvent('checkout.session.completed', session, { account: merchantAccount })))
        .toMatchObject({ outcome: 'settled', detail: 'confirmed' })
      const [seat] = await sql`select status, amount_paid_cents from tickets where event_id = ${event.id} and user_id = ${account.id}`
      expect(seat).toMatchObject({ status: 'confirmed', amount_paid_cents: 2500 })
    } finally {
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('the retention sweep forgets the holder after 90 days and keeps the money facts', async () => {
    const sql = db()
    const account = await createTestAccount('ref-retention', { sql })
    const event = await createTestGathering(sql, { tag: 'ref-retention', ticketingEnabled: true })
    try {
      const retention = await load<typeof import('../src/lib/notifications/retention')>('../src/lib/notifications/retention')
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const fresh = `cs_fresh_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      const old = `cs_old_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      for (const [sessionId, settledAt] of [[fresh, '89 days'], [old, '91 days']] as const) {
        await sql`
          insert into checkout_references
            (session_id, connected_account_id, event_id, tier_id, holder_account_id,
             unit_amount, currency, contribution_percent, application_fee_amount, model, settled_at)
          values (${sessionId}, 'acct_test_retention', ${event.id}, ${tier.id}, ${account.id},
                  2500, 'usd', 1, 25, 'direct', now() - ${settledAt}::interval)
        `
      }

      const report = await retention.runRetention(sql)
      expect(report.checkout_references_holder_90d).toBeGreaterThanOrEqual(1)

      const rows = await sql<{ session_id: string; holder_account_id: string | null; unit_amount: number; application_fee_amount: number }[]>`
        select session_id, holder_account_id, unit_amount, application_fee_amount
        from checkout_references where session_id in (${fresh}, ${old})
      `
      const bySession = Object.fromEntries(rows.map((row) => [row.session_id, row]))
      expect(bySession[old].holder_account_id).toBeNull()
      expect(bySession[fresh].holder_account_id).toBe(account.id)
      // Money facts survive: nothing is deleted, only the person is forgotten.
      expect(bySession[old]).toMatchObject({ unit_amount: 2500, application_fee_amount: 25 })
    } finally {
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('a platform without Accounts v2 falls back to a v1 merchant account', async () => {
    const stripeLib = await load<StripeLib>('../src/lib/payments/stripe')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Stripe = require('stripe') as typeof import('stripe').default

    // Every v2 refusal the sandbox actually gave on 2026-09-25 — platform not enabled for v2,
    // v2 demanding a country the organizer never gave us, and a fresh v1 account not yet
    // addressable through v2. The v2 error envelope carries no `type`, so all three reach the
    // SDK as StripeUnknownError with only the `code` to tell them apart. Matching code by code
    // was whack-a-mole: each miss rethrew and left the organizer unable to connect at all.
    for (const code of [
      'non_connect_platform_accounts_v2_access_blocked',
      'identity_country_required',
      'account_not_yet_compatible_with_v2',
      'some_code_stripe_has_not_invented_yet',
    ]) {
      const err = Stripe.errors.StripeError.generate({ code, message: code } as never)
      expect(err.type).toBe('StripeUnknownError')
      expect(stripeLib.isV2Unavailable(err)).toBe(true)
    }

    // The documented v1-shaped invalid requests still count.
    for (const code of ['feature_not_enabled', 'parameter_unknown', 'url_invalid', 'resource_missing']) {
      const err = Stripe.errors.StripeError.generate({ type: 'invalid_request_error', code, message: code } as never)
      expect(stripeLib.isV2Unavailable(err)).toBe(true)
    }

    // A real failure is never mistaken for "use v1 instead": retrying against v1 would fail the
    // same way, so an outage, a bad key or a throttle has to reach the organizer.
    for (const type of ['rate_limit_error', 'api_error', 'authentication_error']) {
      const err = Stripe.errors.StripeError.generate({ type, message: type } as never)
      expect(stripeLib.isV2Unavailable(err), type).toBe(false)
    }
    // A dropped connection is built directly by the SDK, not from a raw error envelope.
    const dropped = new Stripe.errors.StripeConnectionError({ type: 'api_error', message: 'socket hang up' })
    expect(dropped.type).toBe('StripeConnectionError')
    expect(stripeLib.isV2Unavailable(dropped)).toBe(false)
    // A typed invalid request about the payload itself is a bug on our side, not v2 being off.
    const badParam = Stripe.errors.StripeError.generate({ type: 'invalid_request_error', code: 'account_invalid', message: 'nope' } as never)
    expect(stripeLib.isV2Unavailable(badParam)).toBe(false)
    expect(stripeLib.isV2Unavailable(new Error('network down'))).toBe(false)
  })

  test('the contribution is capped at half the ticket, however high the stored percentage is', async () => {
    const stripe = await load<StripeLib>('../src/lib/payments/stripe')
    const { calculatePlatformFee, maxPlatformFeeCents, MAX_CONTRIBUTION_PERCENT } = stripe

    // Stripe accepts an application fee equal to the charge, and even one larger than it, at
    // session-create time (verified against the sandbox on 2026-09-25: 2501 on a 2500 session).
    // Ours is the only ceiling there is, so it holds in the arithmetic, not just in the form.
    expect(MAX_CONTRIBUTION_PERCENT).toBe(50)
    expect(calculatePlatformFee(2500, 50)).toBe(1250)
    // A row written before the ceiling existed is charged as 50%, not as what it says.
    expect(calculatePlatformFee(2500, 75)).toBe(1250)
    expect(calculatePlatformFee(2500, 100)).toBe(1250)
    // Rounded down, so an odd number of cents cannot tip the share past half.
    expect(maxPlatformFeeCents(25)).toBe(12)
    expect(calculatePlatformFee(25, 50)).toBe(12)
    expect(calculatePlatformFee(1, 50)).toBe(0)

    // And the session builder clamps whatever it is handed: a fee larger than the charge is
    // exactly what Stripe would have taken without complaint.
    const params = stripe.buildCheckoutSessionParams({
      ticketId: randomUUID(),
      tierId: randomUUID(),
      holderId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
      tierName: 'Admission',
      priceCents: 2500,
      platformFeeCents: 2501,
      currency: 'usd',
      eventId: randomUUID(),
      eventName: 'Ceiling check',
      stripeAccountId: 'acct_merchant_ceiling',
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/no',
    })
    expect(params.payment_intent_data!.application_fee_amount).toBe(1250)
    // The metadata the organizer reads in their dashboard says the same number.
    expect(params.metadata!.platform_fee_cents).toBe('1250')
  })

  test('a failed merchant creation can be retried at once, with a fresh idempotency key', async () => {
    const sql = db()
    const event = await createTestGathering(sql, { tag: 'connect-retry' })
    try {
      const connect = await load<Connect>('../src/lib/payments/connect')
      // The first create fails the way the sandbox did on 2026-09-25 (Connect not enabled), and
      // the fake caches that error against its key exactly as Stripe does for 24 hours.
      const fake = fakeMerchantGateway({}, { failCreates: 1 })
      const gathering = { id: event.id, slug: event.slug, name: event.name, stripe_account_id: null }

      const failed = await connect.connectMerchantAccount(fake.gateway, gathering, 'organizer@example.test')
      expect(failed).toMatchObject({ status: 'create_failed', attempts: 1 })
      const attemptsAfterFailure = await sql`select stripe_account_id, stripe_connect_attempts from events where id = ${event.id}`
      expect(attemptsAfterFailure[0]).toMatchObject({ stripe_account_id: null, stripe_connect_attempts: 1 })

      // The old key is still poisoned — that is the 24-hour lockout this counter escapes.
      await expect(
        fake.gateway.createAccount({ eventId: event.id, eventSlug: event.slug, eventName: event.name, attempt: 0 }),
      ).rejects.toThrow('non_connect_platform_accounts_v2_access_blocked')

      // The organizer's next click is a new request, and it connects.
      const connected = await connect.connectMerchantAccount(fake.gateway, gathering, 'organizer@example.test')
      expect(connected).toMatchObject({ status: 'connected', created: true, api: 'v2' })
      const succeeded = fake.created()
      expect(succeeded).toHaveLength(1)
      expect(succeeded[0]).toMatchObject({ attempt: 1, idempotencyKey: `unconference-merchant-v2-${event.id}-1` })
      expect(fake.creates[0].idempotencyKey).not.toBe(succeeded[0].idempotencyKey)

      // A success counts nothing: the column counts failures, not accounts.
      const after = await sql`select stripe_account_id, stripe_connect_attempts from events where id = ${event.id}`
      expect(after[0]).toMatchObject({ stripe_account_id: succeeded[0].accountId, stripe_connect_attempts: 1 })

      // And a gathering that already has an account never creates a second one.
      const again = await connect.connectMerchantAccount(
        fake.gateway,
        { ...gathering, stripe_account_id: succeeded[0].accountId },
        'organizer@example.test',
      )
      expect(again).toMatchObject({ status: 'connected', created: false })
      expect(fake.created()).toHaveLength(1)
    } finally {
      await event.cleanup()
      await sql.end()
    }
  })

  test('two Connect clicks inside one attempt still collapse to a single merchant account', async () => {
    const sql = db()
    const event = await createTestGathering(sql, { tag: 'connect-double' })
    try {
      const connect = await load<Connect>('../src/lib/payments/connect')
      const fake = fakeMerchantGateway()
      const gathering = { id: event.id, slug: event.slug, name: event.name, stripe_account_id: null }

      const [first, second] = await Promise.all([
        connect.connectMerchantAccount(fake.gateway, gathering, 'organizer@example.test'),
        connect.connectMerchantAccount(fake.gateway, gathering, 'organizer@example.test'),
      ])

      // Both calls carried the same key, because neither attempt had failed: Stripe answered the
      // second from its cache, so there is one account and no orphan.
      expect(fake.creates).toHaveLength(2)
      expect(new Set(fake.creates.map((call) => call.idempotencyKey)).size).toBe(1)
      expect(fake.created()).toHaveLength(1)
      expect(fake.creates.every((call) => call.attempt === 0)).toBe(true)

      const accountId = fake.created()[0].accountId
      expect(first).toMatchObject({ status: 'connected', accountId })
      expect(second).toMatchObject({ status: 'connected', accountId })
      const [row] = await sql`select stripe_account_id, stripe_connect_attempts from events where id = ${event.id}`
      expect(row).toMatchObject({ stripe_account_id: accountId, stripe_connect_attempts: 0 })
    } finally {
      await event.cleanup()
      await sql.end()
    }
  })

  test('the readiness gate refuses paid sales until charges and payouts are both live', async () => {
    const merchant = await load<Merchant>('../src/lib/payments/merchant')
    const { paidSalesBlock } = merchant
    const fake = fakeMerchantGateway()
    const created = await fake.gateway.createAccount({ eventId: randomUUID(), eventSlug: 's', eventName: 'n', email: null })
    expect(created.api).toBe('v2')

    const gate = async (hasPaidTiers: boolean, accountId: string | null) => {
      const readiness = accountId
        ? await fake.gateway.readiness(accountId)
        : merchant.NOT_CONNECTED_STATUS
      return paidSalesBlock({ hasPaidTiers, stripeConfigured: true, readiness })
    }

    // Free-only ticketing never needs a merchant account.
    expect(await gate(false, null)).toBeNull()
    expect(await gate(true, null)).toMatchObject({ code: 'NO_MERCHANT_ACCOUNT' })
    expect(await gate(true, created.accountId)).toMatchObject({ code: 'ONBOARDING_INCOMPLETE' })
    fake.chargesOnly(created.accountId)
    expect(await gate(true, created.accountId)).toMatchObject({ code: 'PAYOUTS_DISABLED' })
    fake.complete(created.accountId)
    expect(await gate(true, created.accountId)).toBeNull()

    // Without keys nothing paid may be sold, and an unreadable account is never assumed well.
    expect(paidSalesBlock({ hasPaidTiers: true, stripeConfigured: false, readiness: null })).toMatchObject({ code: 'STRIPE_NOT_CONFIGURED' })
    expect(paidSalesBlock({ hasPaidTiers: true, stripeConfigured: true, readiness: null })).toMatchObject({ code: 'READINESS_UNKNOWN' })
    // The platform-charge fallback is the one way to sell with no merchant account.
    expect(paidSalesBlock({ hasPaidTiers: true, stripeConfigured: true, readiness: merchant.NOT_CONNECTED_STATUS, platformFallbackAllowed: true })).toBeNull()
  })

  test('the settings route refuses to switch paid sales on, and says why', async () => {
    const sql = db()
    const account = await createTestAccount('sales-gate', { sql })
    const event = await createTestGathering(sql, { tag: 'sales-gate' })
    try {
      await sql`insert into event_members (event_id, user_id, role) values (${event.id}, ${account.id}, 'owner')`
      const settings = (body?: Record<string, unknown>) =>
        fetch(`${TEST_BASE_URL}/api/v1/events/${event.slug}/admin/ticketing-settings`, {
          method: body ? 'POST' : 'GET',
          headers: { origin: TEST_BASE_URL, cookie: account.cookie, 'content-type': 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })

      // Free-only: sales may be switched on.
      await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Free pass', 0)`
      expect((await settings({ ticketing_enabled: true })).status).toBe(200)
      expect((await settings({ ticketing_enabled: false })).status).toBe(200)

      // Add a paid tier with no merchant account: refused, with the reason.
      await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Supporter', 2500)`
      const refused = await settings({ ticketing_enabled: true })
      expect(refused.status).toBe(409)
      const body = await refused.json()
      // This deployment holds no Stripe key, so that is the first thing in the way; with keys
      // present and no merchant connected it would be NO_MERCHANT_ACCOUNT. Either way the
      // refusal is the server's, and it names a reason (the unit test above walks the rest).
      expect(['STRIPE_NOT_CONFIGURED', 'NO_MERCHANT_ACCOUNT']).toContain(body.code)
      expect(typeof body.error).toBe('string')
      expect(body.error.length).toBeGreaterThan(20)
      expect((await sql`select ticketing_enabled from events where id = ${event.id}`)[0].ticketing_enabled).toBe(false)

      // The GET reports the same verdict, so the page can explain before anyone clicks.
      const state = await (await settings()).json()
      expect(state.payments_ready).toBe(false)
      expect(state.payments_blocked_code).toBe(body.code)
      expect(state.payments_blocked_reason).toBe(body.error)
    } finally {
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('the same delivery twice is a no-op, claimed by its Stripe event id', async () => {
    const sql = db()
    const account = await createTestAccount('dedupe', { sql })
    const event = await createTestGathering(sql, { tag: 'dedupe', ticketingEnabled: true })
    const paymentIntentId = `pi_dedupe_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    let deliveryId = ''
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      const delivery = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId }),
        { account: merchantAccount },
      )
      deliveryId = delivery.id
      expect(await webhook.handleStripeEvent(delivery)).toMatchObject({ outcome: 'settled' })
      // Stripe redelivering the very same event does nothing at all, not even convergently.
      expect(await webhook.handleStripeEvent(delivery)).toMatchObject({ outcome: 'duplicate' })
      const [ledger] = await sql<{ n: number }[]>`select count(*)::int as n from stripe_events where id = ${delivery.id}`
      expect(ledger.n).toBe(1)
    } finally {
      if (deliveryId) await sql`delete from stripe_events where id = ${deliveryId}`
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(paymentIntentId).digest('hex')}`
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('account.updated pauses paid sales, tells the organizers, and resumes', async () => {
    const sql = db()
    const owner = await createTestAccount('acct-updated', { sql })
    const event = await createTestGathering(sql, { tag: 'acct-updated', ticketingEnabled: true })
    const deliveries: string[] = []
    try {
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const status = await load<MerchantStatus>('../src/lib/payments/merchant-status')
      const merchant = await load<Merchant>('../src/lib/payments/merchant')
      const stripeLib = await load<StripeLib>('../src/lib/payments/stripe')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      await sql`insert into event_members (event_id, user_id, role) values (${event.id}, ${owner.id}, 'owner')`
      await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500)`

      const healthy = { id: merchantAccount, object: 'account', charges_enabled: true, payouts_enabled: true }
      const suspended = { ...healthy, charges_enabled: false }

      // A delivery about somebody else's account cannot touch this gathering.
      const foreign = stripeEvent('account.updated', suspended, { account: 'acct_someone_else' })
      deliveries.push(foreign.id)
      expect(await webhook.handleStripeEvent(foreign)).toMatchObject({ outcome: 'rejected', detail: 'ACCOUNT_MISMATCH' })

      const good = stripeEvent('account.updated', healthy, { account: merchantAccount })
      deliveries.push(good.id)
      expect(await webhook.handleStripeEvent(good)).toMatchObject({ outcome: 'capabilities', detail: 'events=1 paused=0 resumed=0' })
      expect(await status.cachedMerchantStatus(event.id)).toMatchObject({ chargesEnabled: true, payoutsEnabled: true, pausedReason: null })

      const bad = stripeEvent('account.updated', suspended, { account: merchantAccount })
      deliveries.push(bad.id)
      expect(await webhook.handleStripeEvent(bad)).toMatchObject({ outcome: 'capabilities', detail: 'events=1 paused=1 resumed=0' })
      const paused = (await status.cachedMerchantStatus(event.id))!
      expect(paused.chargesEnabled).toBe(false)
      expect(paused.pausedAt).not.toBeNull()

      // The organizers were told, once.
      const notices = await sql`select 1 from notifications where user_id = ${owner.id} and type = 'payments_paused'`
      expect(notices).toHaveLength(1)
      const again = stripeEvent('account.updated', suspended, { account: merchantAccount })
      deliveries.push(again.id)
      await webhook.handleStripeEvent(again)
      expect(await sql`select 1 from notifications where user_id = ${owner.id} and type = 'payments_paused'`).toHaveLength(1)

      // And paid sales are refused while the pause stands, even on a healthy-looking read.
      const readiness = await stripeLib.readMerchantReadiness(
        fakeMerchantGateway({ [merchantAccount]: { chargesEnabled: true, payoutsEnabled: true } }).gateway,
        merchantAccount,
      )
      expect(merchant.paidSalesBlock({ hasPaidTiers: true, stripeConfigured: true, readiness, pausedReason: paused.pausedReason }))
        .toMatchObject({ code: 'PAYMENTS_PAUSED' })

      const recovered = stripeEvent('account.updated', healthy, { account: merchantAccount })
      deliveries.push(recovered.id)
      expect(await webhook.handleStripeEvent(recovered)).toMatchObject({ outcome: 'capabilities', detail: 'events=1 paused=0 resumed=1' })
      expect((await status.cachedMerchantStatus(event.id))!.pausedAt).toBeNull()
    } finally {
      if (deliveries.length) await sql`delete from stripe_events where id in ${sql(deliveries)}`
      await event.cleanup()
      await owner.cleanup()
      await sql.end()
    }
  })

  test('an organizer refund: full revokes admission and returns the contribution, partial does not', async () => {
    const sql = db()
    const account = await createTestAccount('org-refund', { sql })
    const event = await createTestGathering(sql, { tag: 'org-refund', ticketingEnabled: true })
    const paymentIntentId = `pi_orgref_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    let deliveryId = ''
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const refunds = await load<Refunds>('../src/lib/payments/refunds')
      const references = await load<References>('../src/lib/payments/references')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount}, platform_fee_percent = 10 where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)
      const delivery = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId }),
        { account: merchantAccount },
      )
      deliveryId = delivery.id
      expect(await webhook.handleStripeEvent(delivery)).toMatchObject({ outcome: 'settled' })

      const gateway = fakeRefundGateway()
      // Partial: the holder paid less, they did not stop being admitted.
      const partial = await refunds.refundTicket({ eventId: event.id, ticketId: checkout.ticketId, amountCents: 500 }, gateway.gateway)
      expect(partial).toMatchObject({ ok: true, full: false, admissionRevoked: false, amountCents: 500 })
      expect(gateway.calls[0]).toMatchObject({ connectedAccountId: merchantAccount, amountCents: 500, refundApplicationFee: false })
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('confirmed')
      expect(await references.findCheckoutReference(checkout.sessionId, sql)).toMatchObject({ refunded_amount: 500, refunded_at: null })

      // Full: the rest goes back, the contribution with it, and admission ends.
      const full = await refunds.refundTicket({ eventId: event.id, ticketId: checkout.ticketId }, gateway.gateway)
      expect(full).toMatchObject({ ok: true, full: true, admissionRevoked: true, amountCents: 2000 })
      expect(gateway.calls[1]).toMatchObject({ connectedAccountId: merchantAccount, amountCents: 2000, refundApplicationFee: true })
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('cancelled')
      const reference = (await references.findCheckoutReference(checkout.sessionId, sql))!
      expect(reference.refunded_amount).toBe(2500)
      // Stripe reverses an application fee in proportion to the amount refunded, and the
      // partial refund above deliberately kept its share: 10% of the $20 returned, not of $25.
      expect(reference.application_fee_refunded_amount).toBe(200)
      expect(reference.refunded_at).not.toBeNull()
      expect(await sql`select 1 from notifications where user_id = ${account.id} and type = 'ticket_refunded'`).toHaveLength(1)

      // Nothing is left to refund, and a completion replay cannot resurrect the ticket.
      expect(await refunds.refundTicket({ eventId: event.id, ticketId: checkout.ticketId }, gateway.gateway))
        .toMatchObject({ ok: false, code: 'ALREADY_REFUNDED' })
      const replay = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId }),
        { account: merchantAccount },
      )
      await webhook.handleStripeEvent(replay)
      await sql`delete from stripe_events where id = ${replay.id}`
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('cancelled')
    } finally {
      if (deliveryId) await sql`delete from stripe_events where id = ${deliveryId}`
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(paymentIntentId).digest('hex')}`
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('a payment that arrives with no seat left is refunded automatically, in the merchant context', async () => {
    const sql = db()
    const buyer = await createTestAccount('seatless', { sql })
    const squatter = await createTestAccount('seat-taker', { sql })
    const event = await createTestGathering(sql, { tag: 'seatless', ticketingEnabled: true })
    const paymentIntentId = `pi_seatless_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    let deliveryId = ''
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const references = await load<References>('../src/lib/payments/references')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      const [tier] = await sql`
        insert into ticket_tiers (event_id, name, price_cents, quantity_total)
        values (${event.id}, 'Last seat', 2500, 1) returning id
      `
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: buyer.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      // The hold lapses and is swept; somebody else takes the only seat.
      await sql`update tickets set hold_expires_at = now() - interval '1 second' where id = ${checkout.ticketId}`
      await sql`delete from tickets where status = 'pending' and hold_expires_at < now()`
      await sql`insert into tickets (event_id, tier_id, user_id, status) values (${event.id}, ${tier.id}, ${squatter.id}, 'confirmed')`

      const gateway = fakeRefundGateway()
      const delivery = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId }),
        { account: merchantAccount },
      )
      deliveryId = delivery.id
      expect(await webhook.handleStripeEvent(delivery, { refunds: gateway.gateway }))
        .toMatchObject({ outcome: 'settled', detail: 'auto_refunded' })

      // Returned in the merchant's own account, in full, contribution included.
      expect(gateway.calls[0]).toMatchObject({ connectedAccountId: merchantAccount, amountCents: 2500, refundApplicationFee: true })
      const reference = (await references.findCheckoutReference(checkout.sessionId, sql))!
      expect(reference.refunded_amount).toBe(2500)
      expect(reference.refunded_at).not.toBeNull()
      // No admission was manufactured for the buyer, and they were told.
      const seats = await sql`select status from tickets where event_id = ${event.id} and user_id = ${buyer.id}`
      expect(seats.every((row) => row.status === 'cancelled')).toBe(true)
      expect(await sql`select 1 from notifications where user_id = ${buyer.id} and type = 'ticket_refunded'`).toHaveLength(1)
    } finally {
      if (deliveryId) await sql`delete from stripe_events where id = ${deliveryId}`
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(paymentIntentId).digest('hex')}`
      await event.cleanup()
      await buyer.cleanup()
      await squatter.cleanup()
      await sql.end()
    }
  })
  test('a payment settled after the sweep re-links its reference, so the sale is refundable', async () => {
    const sql = db()
    const account = await createTestAccount('relink', { sql })
    const event = await createTestGathering(sql, { tag: 'relink', ticketingEnabled: true })
    const paymentIntentId = `pi_relink_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    let deliveryId = ''
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const references = await load<References>('../src/lib/payments/references')
      const refunds = await load<Refunds>('../src/lib/payments/refunds')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount}, platform_fee_percent = 10 where id = ${event.id}`
      await sql`insert into event_members (event_id, user_id, role) values (${event.id}, ${account.id}, 'owner')`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      // The hold lapses and the sweep takes it; the payment turns up afterwards.
      await sql`update tickets set hold_expires_at = now() - interval '1 second' where id = ${checkout.ticketId}`
      await sql`delete from tickets where status = 'pending' and hold_expires_at < now()`
      expect((await references.findCheckoutReference(checkout.sessionId, sql))!.ticket_id).toBeNull()

      const delivery = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId }),
        { account: merchantAccount },
      )
      deliveryId = delivery.id
      expect(await webhook.handleStripeEvent(delivery)).toMatchObject({ outcome: 'settled', detail: 'confirmed' })

      // The reference points at the seat the payment actually bought…
      const [seat] = await sql<{ id: string }[]>`
        select id from tickets where event_id = ${event.id} and user_id = ${account.id} and status = 'confirmed'
      `
      const reference = (await references.findCheckoutReference(checkout.sessionId, sql))!
      expect(reference.ticket_id).toBe(seat.id)

      // …so the organizer can see it and refund it, rather than the money existing with no sale.
      const sales = await (await fetch(`${TEST_BASE_URL}/api/v1/events/${event.slug}/admin/ticketing-settings/sales`, {
        headers: { cookie: account.cookie },
      })).json()
      expect(sales.sales.map((row: { ticketId: string }) => row.ticketId)).toContain(seat.id)
      const gateway = fakeRefundGateway()
      expect(await refunds.refundTicket({ eventId: event.id, ticketId: seat.id }, gateway.gateway))
        .toMatchObject({ ok: true, full: true, amountCents: 2500 })

      // And it can never be pointed at somebody else's admission afterwards.
      await expect(
        sql`update checkout_references set ticket_id = ${checkout.ticketId} where session_id = ${checkout.sessionId}`,
      ).rejects.toMatchObject({ code: '42501' })
    } finally {
      if (deliveryId) await sql`delete from stripe_events where id = ${deliveryId}`
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(paymentIntentId).digest('hex')}`
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('a refused paid delivery is recorded for the organizer and given back when it is ours', async () => {
    const sql = db()
    const account = await createTestAccount('refused', { sql })
    const event = await createTestGathering(sql, { tag: 'refused', ticketingEnabled: true })
    const paymentIntentId = `pi_refused_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    const deliveries: string[] = []
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const references = await load<References>('../src/lib/payments/references')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      await sql`insert into event_members (event_id, user_id, role) values (${event.id}, ${account.id}, 'owner')`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      // The organizer reconnects a different account while the checkout is open.
      await sql`update events set stripe_account_id = 'acct_test_replacement' where id = ${event.id}`
      const gateway = fakeRefundGateway()
      const delivery = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId }),
        { account: merchantAccount },
      )
      deliveries.push(delivery.id)
      expect(await webhook.handleStripeEvent(delivery, { refunds: gateway.gateway }))
        .toMatchObject({ outcome: 'rejected', detail: 'EVENT_ACCOUNT_CHANGED (auto_refunded)' })

      // No admission was granted, the buyer's money went back on the account that took it…
      expect((await sql`select status from tickets where id = ${checkout.ticketId}`)[0].status).toBe('cancelled')
      expect(await sql`select 1 from event_members where event_id = ${event.id} and user_id = ${account.id} and role = 'attendee'`).toHaveLength(0)
      expect(gateway.calls[0]).toMatchObject({ connectedAccountId: merchantAccount, amountCents: 2500, refundApplicationFee: true })
      expect(gateway.calls[0].idempotencyKey).toBe(`refund-${checkout.sessionId}-2500`)
      expect((await references.findCheckoutReference(checkout.sessionId, sql))!.refunded_amount).toBe(2500)
      expect(await sql`select 1 from notifications where user_id = ${account.id} and type = 'ticket_refunded'`).toHaveLength(1)

      // …and the refusal is on the revenue page, not only in a log line.
      const revenue = await (await fetch(
        `${TEST_BASE_URL}/api/v1/events/${event.slug}/admin/ticketing-settings/revenue`,
        { headers: { cookie: account.cookie } },
      )).json()
      expect(revenue.unmatchedPayments).toHaveLength(1)
      expect(revenue.unmatchedPayments[0]).toMatchObject({ reason: 'EVENT_ACCOUNT_CHANGED', sessionId: checkout.sessionId })

      // A delivery naming a session we never opened is recorded but never refunded: it is not
      // provably ours, and the merchant may be selling other things on the same account.
      const foreign = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: 'cs_not_ours_at_all', amountTotal: 2500, paymentIntentId: 'pi_not_ours' }),
        { account: merchantAccount },
      )
      deliveries.push(foreign.id)
      expect(await webhook.handleStripeEvent(foreign, { refunds: gateway.gateway }))
        .toMatchObject({ outcome: 'rejected', detail: 'NO_REFERENCE (not_ours)' })
      expect(gateway.calls).toHaveLength(1)
    } finally {
      if (deliveries.length) await sql`delete from stripe_events where id in ${sql(deliveries)}`
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(paymentIntentId).digest('hex')}`
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })

  test('two simultaneous deliveries of one event id dispatch exactly once', async () => {
    const sql = db()
    const account = await createTestAccount('race', { sql })
    const event = await createTestGathering(sql, { tag: 'race', ticketingEnabled: true })
    const paymentIntentId = `pi_race_${randomUUID().replace(/-/g, '').slice(0, 12)}`
    let deliveryId = ''
    try {
      const tickets = await load<Tickets>('../src/lib/tickets')
      const webhook = await load<Webhook>('../src/lib/payments/webhook')
      const merchantAccount = `acct_test_${randomUUID().replace(/-/g, '').slice(0, 12)}`
      await sql`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      const [tier] = await sql`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const checkout = await tickets.startPaidCheckout(
        {
          event: { id: event.id, slug: event.slug, name: event.name, stripe_account_id: merchantAccount },
          tierId: tier.id,
          holder: { accountId: account.id, email: null },
          origin: TEST_BASE_URL,
        },
        fakeCheckoutGateway().gateway,
      )
      if (!checkout.ok) throw new Error(checkout.error)

      const delivery = stripeEvent(
        'checkout.session.completed',
        paidSession({ sessionId: checkout.sessionId, amountTotal: 2500, paymentIntentId }),
        { account: merchantAccount },
      )
      deliveryId = delivery.id
      // Stripe can open two connections at once. The claim is a row lock held across the whole
      // handler, so the second one waits and then finds the work already done.
      const both = await Promise.all([
        webhook.handleStripeEvent(delivery),
        webhook.handleStripeEvent(delivery),
      ])
      expect(both.filter((r) => r.outcome === 'settled')).toHaveLength(1)
      expect(both.filter((r) => r.outcome === 'duplicate')).toHaveLength(1)
      // Exactly one confirmation, one membership, one notification.
      expect(await sql`select 1 from tickets where event_id = ${event.id} and status = 'confirmed'`).toHaveLength(1)
      expect(await sql`select 1 from notifications where user_id = ${account.id} and type = 'ticket_confirmed'`).toHaveLength(1)
    } finally {
      if (deliveryId) await sql`delete from stripe_events where id = ${deliveryId}`
      await sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(paymentIntentId).digest('hex')}`
      await event.cleanup()
      await account.cleanup()
      await sql.end()
    }
  })
})
