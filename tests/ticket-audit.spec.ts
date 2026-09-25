import { createHash } from 'node:crypto'
import { test, expect } from '@playwright/test'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, withServerOnlyShim, TEST_BASE_URL } from './helpers/gathering'
import { fakeCheckoutGateway, paidSession, stripeEvent } from './helpers/payments'

for (const value of [process.env.DATABASE_MIGRATION_URL, process.env.PDS_INTERNAL_URL || process.env.PDS_URL, TEST_BASE_URL]) {
  if (!value || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname)) {
    throw new Error('Ticket audit requires the isolated local database, PDS and AppView')
  }
}

// Real local database, PDS identities and HTTP routes. Only the payment gateway is substituted:
// these cases exercise entitlement and webhook ordering without moving money.
test.describe('ticket admission audit', () => {
  test('platform contributions are percentage-only, never below 1% and never above half the ticket', async () => {
    const { calculatePlatformFee, validContributionPercent, MAX_CONTRIBUTION_PERCENT } = require('../src/lib/payments/format')
    expect(calculatePlatformFee(2500, 1)).toBe(25)
    expect(calculatePlatformFee(2500, 3.5)).toBe(88)
    expect(calculatePlatformFee(50, 1)).toBe(1)
    expect(calculatePlatformFee(0, 1)).toBe(0)
    expect(() => calculatePlatformFee(2500, 0.5)).toThrow()
    expect(() => calculatePlatformFee(2500, 101)).toThrow()

    // The ceiling: 50% is the most an organizer may choose, and the most that can ever be
    // charged. A row stored above it (the column still allows one) is charged as 50%.
    expect(MAX_CONTRIBUTION_PERCENT).toBe(50)
    expect(validContributionPercent(50)).toBe(true)
    expect(validContributionPercent(50.01)).toBe(false)
    expect(validContributionPercent(100)).toBe(false)
    expect(calculatePlatformFee(2500, 50)).toBe(1250)
    expect(calculatePlatformFee(2500, 60)).toBe(1250)
    expect(calculatePlatformFee(2500, 100)).toBe(1250)
  })

  test('a session proposal cannot bypass paid admission or a tier without proposal rights', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('gate', { sql: db })
    const event = await createTestGathering(db, { tag: 'gate', ticketingEnabled: true })
    try {
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents, allows_proposals)
        values (${event.id}, 'Attend only', 2500, false) returning id`
      const propose = () => fetch(`${TEST_BASE_URL}/api/v1/sessions`, {
        method: 'POST', headers: { origin: TEST_BASE_URL, cookie: account.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ event_slug: event.slug, title: 'Ticket gate check', description: 'An isolated admission test.', format: 'discussion', duration: 30 }),
      })
      expect((await propose()).status).toBe(403)
      expect(await db`select 1 from event_members where event_id = ${event.id} and user_id = ${account.id}`).toHaveLength(0)
      await db`insert into tickets (event_id, tier_id, user_id, status) values (${event.id}, ${tier.id}, ${account.id}, 'confirmed')`
      await db`insert into event_members (event_id, user_id, role) values (${event.id}, ${account.id}, 'attendee') on conflict do nothing`
      expect((await propose()).status).toBe(403)
      await db`update ticket_tiers set allows_proposals = true where id = ${tier.id}`
      expect((await propose()).status).toBe(201)
    } finally { await event.cleanup(); await account.cleanup(); await db.end() }
  })

  test('RSVP cannot create membership in a ticketed gathering without admission', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('rsvp-gate', { sql: db })
    const event = await createTestGathering(db, { tag: 'rsvp-gate', ticketingEnabled: true })
    try {
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      await db`insert into event_members (event_id, user_id, role) values (${event.id}, ${account.id}, 'owner')`
      const [session] = await db`insert into sessions (event_id, host_id, title, format, duration, status)
        values (${event.id}, ${account.id}, 'Scheduled discussion', 'discussion', 30, 'scheduled') returning id`
      await db`delete from event_members where event_id = ${event.id} and user_id = ${account.id}`
      const rsvp = () => fetch(`${TEST_BASE_URL}/api/v1/events/${event.slug}/rsvps/${session.id}`, {
        method: 'PUT', headers: { origin: TEST_BASE_URL, cookie: account.cookie, 'content-type': 'application/json' }, body: '{}',
      })
      expect((await rsvp()).status).toBe(403)
      expect(await db`select 1 from event_members where event_id = ${event.id} and user_id = ${account.id}`).toHaveLength(0)
      await db`insert into tickets (event_id, tier_id, user_id, status) values (${event.id}, ${tier.id}, ${account.id}, 'confirmed')`
      expect((await rsvp()).status).toBe(200)
    } finally { await event.cleanup(); await account.cleanup(); await db.end() }
  })

  test('a delayed completion webhook cannot reactivate a fully refunded ticket', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('refund', { sql: db })
    const event = await createTestGathering(db, { tag: 'refund', ticketingEnabled: true })
    try {
      const tickets = await withServerOnlyShim(() => require('../src/lib/tickets') as typeof import('../src/lib/tickets'))
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const hold = await tickets.reserveTicketHold({ eventId: event.id, tierId: tier.id, accountId: account.id })
      if (!hold.ok) throw new Error(hold.error)
      const payment = { ticketId: hold.ticketId, eventId: event.id, tierId: tier.id, holderId: account.id,
        sessionId: `cs_${event.id}`, paymentIntentId: `pi_${event.id}`, amountPaidCents: 2500 }
      expect(await tickets.settlePaidCheckout(payment)).toBe('confirmed')
      expect(await tickets.cancelRefundedTicket(payment.paymentIntentId)).toBe(1)
      const [rawReference] = await db`select count(*)::int as n from refunded_payments r where row_to_json(r)::text like ${`%${payment.paymentIntentId}%`}`
      expect(rawReference.n).toBe(0)
      await tickets.settlePaidCheckout(payment)
      const [row] = await db`select status from tickets where id = ${hold.ticketId}`
      expect(row.status).toBe('cancelled')
    } finally {
      await db`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(`pi_${event.id}`).digest('hex')}`
      await event.cleanup(); await account.cleanup(); await db.end()
    }
  })
  test('a refund delivered before completion still prevents admission', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('early-refund', { sql: db })
    const event = await createTestGathering(db, { tag: 'early-refund', ticketingEnabled: true })
    const pi = `pi_${event.id}`
    try {
      const tickets = await withServerOnlyShim(() => require('../src/lib/tickets') as typeof import('../src/lib/tickets'))
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const hold = await tickets.reserveTicketHold({ eventId: event.id, tierId: tier.id, accountId: account.id })
      if (!hold.ok) throw new Error(hold.error)
      await tickets.cancelRefundedTicket(pi)
      expect(await tickets.settlePaidCheckout({ ticketId: hold.ticketId, eventId: event.id, tierId: tier.id,
        holderId: account.id, sessionId: `cs_${event.id}`, paymentIntentId: pi, amountPaidCents: 2500 })).toBe('ignored')
      expect(await db`select 1 from event_members where event_id = ${event.id} and user_id = ${account.id}`).toHaveLength(0)
    } finally {
      // The payment ledger is private and deliberately independent of deleted event fixtures.
      if ((await db`select to_regclass('public.refunded_payments') as name`)[0].name) {
        await db`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(pi).digest('hex')}`
      }
      await event.cleanup(); await account.cleanup(); await db.end()
    }
  })

  test('concurrent checkout clicks open only one payable session for a holder', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('double-checkout', { sql: db })
    const event = await createTestGathering(db, { tag: 'double-checkout', ticketingEnabled: true })
    try {
      const tickets = await withServerOnlyShim(() => require('../src/lib/tickets') as typeof import('../src/lib/tickets'))
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      let entered!: () => void
      let release!: () => void
      const opened = new Promise<void>(resolve => { entered = resolve })
      const complete = new Promise<void>(resolve => { release = resolve })
      let calls = 0
      const gateway = {
        createSession: async () => { calls++; entered(); await complete; return { id: `cs_${calls}`, url: 'https://checkout.stripe.com/test' } },
        expireSession: async () => 'expired' as const,
      }
      const input = { event: { id: event.id, slug: event.slug, name: 'Audit', stripe_account_id: null },
        tierId: tier.id, holder: { accountId: account.id, email: null }, origin: TEST_BASE_URL }
      const first = tickets.startPaidCheckout(input, gateway)
      await opened
      const second = tickets.startPaidCheckout(input, gateway)
      // Release the first gateway after the concurrent request had time to reach the database.
      const timer = setTimeout(release, 300)
      const results = await Promise.all([first, second])
      clearTimeout(timer)
      expect(calls).toBe(1)
      expect(results.filter(result => result.ok)).toHaveLength(1)
      expect(results.find(result => !result.ok)).toMatchObject({ code: 'CHECKOUT_IN_PROGRESS' })
    } finally { await event.cleanup(); await account.cleanup(); await db.end() }
  })

  test('organizer contribution is validated and snapshotted for paid checkout', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('fee-snapshot', { sql: db })
    const event = await createTestGathering(db, { tag: 'fee-snapshot', ticketingEnabled: true })
    try {
      await db`insert into event_members (event_id, user_id, role) values (${event.id}, ${account.id}, 'owner')`
      const save = (body: Record<string, unknown>) => fetch(`${TEST_BASE_URL}/api/v1/events/${event.slug}/admin/ticketing-settings`, {
        method: 'POST', headers: { origin: TEST_BASE_URL, cookie: account.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect((await save({ platform_fee_percent: 0.9 })).status).toBe(400)
      expect((await save({ stripe_account_id: 'acct_someoneelse' })).status).toBe(400)
      // The ceiling is the route's, not the browser's: half the ticket is the most the platform
      // may be given, because Stripe itself would accept a fee as large as the charge.
      const tooMuch = await save({ platform_fee_percent: 51 })
      expect(tooMuch.status).toBe(400)
      expect((await tooMuch.json()).error).toBe('Choose a contribution from 1% to 50%, with up to two decimal places')
      expect((await save({ platform_fee_percent: 100 })).status).toBe(400)
      expect((await save({ platform_fee_percent: 50 })).status).toBe(200)
      expect((await save({ platform_fee_percent: 3.5 })).status).toBe(200)
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const tickets = await withServerOnlyShim(() => require('../src/lib/tickets') as typeof import('../src/lib/tickets'))
      let quote: { platformFeeCents: number; currency: string } | undefined
      const checkout = await tickets.startPaidCheckout({ event: { id: event.id, slug: event.slug, name: 'Audit', stripe_account_id: 'acct_test' },
        tierId: tier.id, holder: { accountId: account.id, email: null }, origin: TEST_BASE_URL }, {
        createSession: async input => { quote = input; return { id: `cs_${event.id}`, url: 'https://checkout.stripe.com/test' } },
        expireSession: async () => 'expired',
      })
      if (!checkout.ok) throw new Error(checkout.error)
      expect(quote).toMatchObject({ platformFeeCents: 88, currency: 'usd' })
      expect((await save({ platform_fee_percent: 10 })).status).toBe(200)
      expect(await tickets.settlePaidCheckout({ ticketId: checkout.ticketId, eventId: event.id, tierId: tier.id, holderId: account.id,
        sessionId: checkout.sessionId, paymentIntentId: `pi_${event.id}`, amountPaidCents: 2500, currency: 'usd' })).toBe('confirmed')
      const [sale] = await db`select platform_fee_cents from tickets where id = ${checkout.ticketId}`
      expect(sale.platform_fee_cents).toBe(88)
      await expect(db`update ticket_tiers set price_cents = 1000 where id = ${tier.id}`).rejects.toMatchObject({ code: '23514' })
      await expect(db`insert into ticket_tiers (event_id, name, price_cents, currency) values (${event.id}, 'Wrong currency', 1000, 'eur')`).rejects.toMatchObject({ code: '23514' })
    } finally { await event.cleanup(); await account.cleanup(); await db.end() }
  })

  test('a paid checkout is a direct charge: the contribution is the whole platform cut', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('direct-audit', { sql: db })
    const event = await createTestGathering(db, { tag: 'direct-audit', ticketingEnabled: true })
    try {
      const tickets = await withServerOnlyShim(() => require('../src/lib/tickets') as typeof import('../src/lib/tickets'))
      const stripe = await withServerOnlyShim(() => require('../src/lib/payments/stripe') as typeof import('../src/lib/payments/stripe'))
      const merchantAccount = 'acct_test_direct_audit'
      await db`update events set stripe_account_id = ${merchantAccount}, platform_fee_percent = 1 where id = ${event.id}`
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`

      const fake = fakeCheckoutGateway()
      const checkout = await tickets.startPaidCheckout({
        event: { id: event.id, slug: event.slug, name: 'Audit', stripe_account_id: merchantAccount },
        tierId: tier.id, holder: { accountId: account.id, email: null }, origin: TEST_BASE_URL,
      }, fake.gateway)
      if (!checkout.ok) throw new Error(checkout.error)

      // $25 at 1% → 25 cents to the platform, charged on the organizer's own account.
      expect(fake.created[0]).toMatchObject({ account: merchantAccount, priceCents: 2500, platformFeeCents: 25 })
      const params = stripe.buildCheckoutSessionParams({
        ticketId: checkout.ticketId, tierId: tier.id, holderId: account.id, expiresAt: new Date(Date.now() + 60_000),
        tierName: 'Admission', priceCents: 2500, platformFeeCents: 25, currency: 'usd', eventId: event.id,
        eventName: 'Audit', stripeAccountId: merchantAccount, successUrl: 'https://x.test/a', cancelUrl: 'https://x.test/b',
      })
      // No destination transfer: Stripe's processing fees are the organizer's, so a 1%
      // contribution cannot become a platform loss.
      expect(params.payment_intent_data).toMatchObject({ application_fee_amount: 25 })
      expect(JSON.stringify(params)).not.toContain('transfer_data')

      const [reference] = await db`select model, connected_account_id, application_fee_amount, unit_amount
        from checkout_references where session_id = ${checkout.sessionId}`
      expect(reference).toMatchObject({ model: 'direct', connected_account_id: merchantAccount, application_fee_amount: 25, unit_amount: 2500 })
    } finally { await event.cleanup(); await account.cleanup(); await db.end() }
  })

  test('admission is never granted from webhook metadata alone', async () => {
    const db = postgres(process.env.DATABASE_MIGRATION_URL!, { max: 2, onnotice: () => {} })
    const account = await createTestAccount('metadata-audit', { sql: db })
    const event = await createTestGathering(db, { tag: 'metadata-audit', ticketingEnabled: true })
    const deliveries: string[] = []
    try {
      const tickets = await withServerOnlyShim(() => require('../src/lib/tickets') as typeof import('../src/lib/tickets'))
      const webhook = await withServerOnlyShim(() => require('../src/lib/payments/webhook') as typeof import('../src/lib/payments/webhook'))
      const merchantAccount = 'acct_test_metadata_audit'
      await db`update events set stripe_account_id = ${merchantAccount} where id = ${event.id}`
      const [tier] = await db`insert into ticket_tiers (event_id, name, price_cents) values (${event.id}, 'Admission', 2500) returning id`
      const hold = await tickets.reserveTicketHold({ eventId: event.id, tierId: tier.id, accountId: account.id })
      if (!hold.ok) throw new Error(hold.error)

      // A connected merchant can put anything in metadata on their own account. Without a
      // reference of ours, a perfectly-formed delivery naming a real ticket does nothing.
      const forged = {
        ...paidSession({ sessionId: 'cs_forged_by_merchant', amountTotal: 2500, paymentIntentId: 'pi_forged' }),
        metadata: { ticket_id: hold.ticketId, event_id: event.id, tier_id: tier.id, holder_id: account.id },
      }
      const delivery = stripeEvent('checkout.session.completed', forged, { account: merchantAccount })
      deliveries.push(delivery.id)
      const refused = await webhook.handleStripeEvent(delivery)
      expect(refused.outcome).toBe('rejected')
      // `not_ours`: with no reference of ours the payment is not provably this application's,
      // so it is recorded for the organizer and never refunded from here.
      expect(refused.detail).toBe('NO_REFERENCE (not_ours)')
      expect((await db`select status from tickets where id = ${hold.ticketId}`)[0].status).toBe('pending')
      expect(await db`select 1 from event_members where event_id = ${event.id} and user_id = ${account.id}`).toHaveLength(0)
    } finally {
      if (deliveries.length) await db`delete from stripe_events where id in ${db(deliveries)}`
      await event.cleanup(); await account.cleanup(); await db.end()
    }
  })

})
