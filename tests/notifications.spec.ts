import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import postgres from 'postgres'
import { signInWithEmail } from './helpers/gathering'

/**
 * Work package E: notification outbox, feed API, retention, tickets bound to a DID.
 *
 * Runs against the local stack (Postgres :55432, dev PDS) and the dev server on :3001 with
 * mail disabled. Library-level checks run inside transactions that are rolled back; the HTTP
 * checks create two accounts through the real custodial door and a throwaway gathering, and
 * delete all of it (database and PDS) afterwards.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.NOTIFICATIONS_TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

// `server-only` is a bundler marker; resolve it to Next's empty stub so the real modules load.
type Resolver = (request: string, ...rest: unknown[]) => string
const M = Module as unknown as { _resolveFilename: Resolver }
const originalResolve = M._resolveFilename
const SERVER_ONLY_STUB = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
M._resolveFilename = function (request: string, ...rest: unknown[]) {
  return request === 'server-only' ? SERVER_ONLY_STUB : originalResolve.call(this, request, ...rest)
}
/* eslint-disable @typescript-eslint/no-require-imports */
const db = require('../src/lib/db') as typeof import('../src/lib/db')
const notifications = require('../src/lib/notifications') as typeof import('../src/lib/notifications')
const categories = require('../src/lib/notifications/categories') as typeof import('../src/lib/notifications/categories')
const retention = require('../src/lib/notifications/retention') as typeof import('../src/lib/notifications/retention')
const cron = require('../src/lib/notifications/cron') as typeof import('../src/lib/notifications/cron')
const mail = require('../src/lib/auth/mail') as typeof import('../src/lib/auth/mail')
const tickets = require('../src/lib/tickets') as typeof import('../src/lib/tickets')
const qr = require('../src/lib/tickets/qr') as typeof import('../src/lib/tickets/qr')
/* eslint-enable @typescript-eslint/no-require-imports */

class Rollback extends Error {}

/** Runs fn in a transaction on the app's own `sql` and always rolls it back. */
async function rolledBack(fn: (t: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await db.sql
    .begin(async (t) => {
      await fn(t)
      throw new Rollback()
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e
    })
}

async function insertAccount(t: postgres.TransactionSql, opts: { verified?: boolean; email?: string | null } = {}) {
  const suffix = randomUUID().slice(0, 8)
  const email = opts.email === undefined ? `pkge-lib-${suffix}@example.test` : opts.email
  const [account] = await t<{ id: string; did: string; email: string | null }[]>`
    insert into accounts (did, handle, email, kind, email_verified_at)
    values (${`did:plc:pkge${suffix}`}, ${`pkge-${suffix}.test`}, ${email}, 'custodial',
            ${opts.verified === false ? null : new Date()})
    returning id, did, email
  `
  return account
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('notifications and tickets (package E)', () => {
  test.skip(!isLocal, 'DATABASE_URL is not a local Postgres (see docs/ATPROTO_APPVIEW_PLAN.md §7.3)')

  test.afterAll(async () => {
    M._resolveFilename = originalResolve
    await db.sql.end({ timeout: 5 })
  })

  // ---------------------------------------------------------------------------
  // Library
  // ---------------------------------------------------------------------------

  test('TypeScript categories match public.get_notification_category', async () => {
    const rows = await db.sql<{ type: string; category: string }[]>`
      select t as type, public.get_notification_category(t) as category
      from unnest(${categories.NOTIFICATION_TYPES as unknown as string[]}::text[]) as t
    `
    expect(Object.fromEntries(rows.map((r) => [r.type, r.category]))).toEqual(categories.NOTIFICATION_CATEGORY)
  })

  test('notify inside a rolled-back transaction leaves nothing behind', async () => {
    const title = `pkge rollback ${randomUUID()}`
    let accountId = ''
    await rolledBack(async (t) => {
      const account = await insertAccount(t)
      accountId = account.id
      const written = await notifications.notify(t, {
        eventId: null,
        userIds: [account.id, account.id, null],
        type: 'admin_announcement',
        title,
      })
      expect(written).toBe(1)
      const [inside] = await t<{ n: number }[]>`select count(*)::int as n from notifications where title = ${title}`
      expect(inside.n).toBe(1)

      // Also from a person's transaction (role authenticated, RLS on): the definer function inserts.
      await t`set local role authenticated`
      await t`select set_config('request.jwt.claims', ${JSON.stringify({ sub: account.id, role: 'authenticated' })}, true)`
      expect(await notifications.notify(t, { eventId: null, userIds: [account.id], type: 'session_submitted', title })).toBe(1)
      // …while a direct insert is still refused.
      await t`savepoint direct_insert`
      await expect(t`insert into notifications (user_id, type, title) values (${account.id}, 'session_submitted', ${title})`).rejects.toMatchObject({ code: '42501' })
      await t`rollback to savepoint direct_insert`
    })
    const [after] = await db.sql<{ n: number }[]>`select count(*)::int as n from notifications where title = ${title} or user_id = ${accountId}`
    expect(after.n).toBe(0)
  })

  test('dispatch skips opted-out categories, emails receipts anyway, and marks every row', async () => {
    const savedKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY // mail disabled locally → sendMail reports delivered: false
    try {
      await rolledBack(async (t) => {
        const a = await insertAccount(t)
        const unverified = await insertAccount(t, { verified: false })
        await t`
          insert into notification_preferences (user_id, event_id, category, email_enabled)
          values (${a.id}, null, 'session_updates', false), (${a.id}, null, 'event_announcements', false)
        `
        const emit = async (userId: string, type: import('../src/lib/notifications').NotificationType, title: string) => {
          await notifications.notify(t, { eventId: null, userIds: [userId], type, title, actionUrl: '/e/some-gathering' })
          const [row] = await t<{ id: string }[]>`select id from notifications where user_id = ${userId} and title = ${title}`
          return row.id
        }
        const optedOut = await emit(a.id, 'session_approved', 'Approved')
        const receipt = await emit(a.id, 'ticket_confirmed', 'Your ticket is confirmed')
        const wanted = await emit(a.id, 'cohost_accepted', 'Co-host <b>accepted</b>')
        const noEmail = await emit(unverified.id, 'new_proposal', 'New proposal')

        const sends: Array<{ to: string; subject: string; delivered: boolean }> = []
        const result = await notifications.dispatchPending({
          db: t,
          limit: 500,
          perHour: 100,
          send: async (message) => {
            const r = await mail.sendMail(message)
            sends.push({ to: message.to, subject: message.subject, delivered: r.delivered })
            expect(message.html).not.toContain('<b>')
            return r
          },
        })
        expect(result.claimed).toBeGreaterThanOrEqual(4)

        const rows = await t<{ id: string; email_outcome: string | null; email_sent_at: string | null; email_claimed_at: string | null }[]>`
          select id, email_outcome, email_sent_at, email_claimed_at from notifications
          where id in ${t([optedOut, receipt, wanted, noEmail])}
        `
        const outcome = Object.fromEntries(rows.map((r) => [r.id, r]))
        expect(outcome[optedOut].email_outcome).toBe('opted_out')
        expect(outcome[receipt].email_outcome).toBe('dev_logged')
        expect(outcome[wanted].email_outcome).toBe('dev_logged')
        expect(outcome[noEmail].email_outcome).toBe('no_email')
        for (const r of rows) {
          expect(r.email_sent_at).not.toBeNull()
          expect(r.email_claimed_at).toBeNull()
        }
        const mine = sends.filter((s) => s.to === a.email)
        expect(mine).toHaveLength(2)
        expect(mine.every((s) => s.delivered === false)).toBe(true)
        expect(sends.some((s) => s.to === unverified.email)).toBe(false)
      })
    } finally {
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey
    }
  })

  test('dispatch holds mail over the per-recipient hourly limit', async () => {
    const savedKey = process.env.RESEND_API_KEY
    delete process.env.RESEND_API_KEY
    try {
      await rolledBack(async (t) => {
        const a = await insertAccount(t)
        for (const title of ['one', 'two', 'three']) {
          await notifications.notify(t, { eventId: null, userIds: [a.id], type: 'cohost_accepted', title })
        }
        await notifications.dispatchPending({ db: t, limit: 500, perHour: 1, send: mail.sendMail })
        const rows = await t<{ email_outcome: string | null }[]>`
          select email_outcome from notifications where user_id = ${a.id} order by created_at, id
        `
        expect(rows.map((r) => r.email_outcome)).toEqual(['dev_logged', null, null])
      })
    } finally {
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey
    }
  })

  test('retention deletes 91-day-old notifications and nulls 31-day-old inviters, forgets closed-case reporters and sweeps revoked calendar tokens', async () => {
    await rolledBack(async (t) => {
      const a = await insertAccount(t)
      // A gathering of this transaction's own (rolled back with it), never a seeded one.
      const [event] = await t<{ id: string }[]>`
        insert into events (slug, name, start_date, end_date) values (${`pkge-retention-${randomUUID().slice(0, 8)}`}, 'Retention test', current_date, current_date)
        returning id
      `
      await t`
        insert into notifications (user_id, type, title, created_at) values
          (${a.id}, 'admin_announcement', 'old', now() - interval '91 days'),
          (${a.id}, 'admin_announcement', 'recent', now() - interval '89 days')
      `
      const [oldInvite] = await t<{ id: string }[]>`
        insert into event_invitations (event_id, created_by, accepted_at, created_at)
        values (${event.id}, ${a.id}, now() - interval '31 days', now() - interval '40 days') returning id
      `
      const [freshInvite] = await t<{ id: string }[]>`
        insert into event_invitations (event_id, created_by, accepted_at)
        values (${event.id}, ${a.id}, now() - interval '29 days') returning id
      `
      // A case closed 91 days ago forgets its reporter; one closed 89 days ago, and one still
      // open, keep theirs.
      const reports = await t<{ id: string; status: string }[]>`
        insert into moderation_reports (event_id, reporter_account_id, subject_kind, subject_account_id, reason, status, resolved_at)
        values (${event.id}, ${a.id}, 'profile', ${a.id}, 'spam', 'actioned', now() - interval '91 days'),
               (${event.id}, ${a.id}, 'profile', ${a.id}, 'hate', 'dismissed', now() - interval '89 days'),
               (${event.id}, ${a.id}, 'profile', ${a.id}, 'other', 'open', null)
        returning id, status
      `
      const [oldCase, freshCase, openCase] = reports

      // A subscription credential revoked 31 days ago is swept; one revoked yesterday and a live
      // one are kept.
      const tokens = await t<{ id: string }[]>`
        insert into calendar_feed_tokens (account_id, token_hash, revoked_at)
        values (${a.id}, ${`retention-old-${randomUUID()}`}, now() - interval '31 days'),
               (${a.id}, ${`retention-fresh-${randomUUID()}`}, now() - interval '1 day'),
               (${a.id}, ${`retention-live-${randomUUID()}`}, null)
        returning id
      `
      const [oldToken, freshToken, liveToken] = tokens

      const report = await retention.runRetention(t)
      expect(report.notifications_90d).toBeGreaterThanOrEqual(1)
      expect(report.event_invitations_inviter_30d).toBeGreaterThanOrEqual(1)
      expect(report.moderation_reports_reporter_90d).toBeGreaterThanOrEqual(1)
      expect(report.calendar_feed_tokens_revoked_30d).toBeGreaterThanOrEqual(1)

      // The case file survives the person: reason, status and action stay, the reporter goes.
      const cases = await t<{ id: string; reporter_account_id: string | null; reason: string; status: string }[]>`
        select id, reporter_account_id, reason, status from moderation_reports
        where id in ${t([oldCase.id, freshCase.id, openCase.id])}
      `
      const byCase = Object.fromEntries(cases.map((r) => [r.id, r]))
      expect(byCase[oldCase.id]).toMatchObject({ reporter_account_id: null, reason: 'spam', status: 'actioned' })
      expect(byCase[freshCase.id].reporter_account_id).toBe(a.id)
      expect(byCase[openCase.id].reporter_account_id).toBe(a.id)

      const tokensLeft = await t<{ id: string }[]>`
        select id from calendar_feed_tokens where id in ${t([oldToken.id, freshToken.id, liveToken.id])}
      `
      expect(new Set(tokensLeft.map((r) => r.id))).toEqual(new Set([freshToken.id, liveToken.id]))

      const left = await t<{ title: string }[]>`select title from notifications where user_id = ${a.id}`
      expect(left.map((r) => r.title)).toEqual(['recent'])
      const invites = await t<{ id: string; created_by: string | null }[]>`
        select id, created_by from event_invitations where id in ${t([oldInvite.id, freshInvite.id])}
      `
      const byId = Object.fromEntries(invites.map((r) => [r.id, r.created_by]))
      expect(byId[oldInvite.id]).toBeNull()
      expect(byId[freshInvite.id]).toBe(a.id)
    })
  })

  test('cron authorization: 401 wrong bearer, 503 unset in production, open in development', async () => {
    const request = (auth?: string) => new Request('http://localhost/api/jobs/retention', { headers: auth ? { authorization: auth } : {} })
    const secret = 'test-cron-secret-0123456789abcdef'
    expect(cron.authorizeCron(request('Bearer wrong'), { secret, nodeEnv: 'production' })?.status).toBe(401)
    expect(cron.authorizeCron(request(), { secret, nodeEnv: 'development' })?.status).toBe(401)
    expect(cron.authorizeCron(request(`Bearer ${secret}`), { secret, nodeEnv: 'production' })).toBeNull()
    expect(cron.authorizeCron(request(), { secret: undefined, nodeEnv: 'production' })?.status).toBe(503)
    expect(cron.authorizeCron(request(), { secret: undefined, nodeEnv: 'development' })).toBeNull()

    // The dev server runs without CRON_SECRET: the route is reachable and reports counts only.
    const res = await fetch(`${base}/api/jobs/retention`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body.report).sort()).toEqual([
      'at_oauth_state_1h', 'at_sessions_expired', 'auth_email_tokens_expired', 'calendar_feed_tokens_revoked_30d',
      'checkout_references_holder_90d', 'cohost_invites_inviter_30d', 'event_invitations_inviter_30d',
      'moderation_reports_reporter_90d', 'notifications_90d', 'stripe_events_30d',
      'ticket_checkins_to_counts_90d', 'ticket_holds_expired', 'ticket_payment_ids_archived',
    ])
    expect(Object.values(body.report).every((v) => typeof v === 'number')).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Capacity: tier row lock, checkout holds, webhook settlement
  // ---------------------------------------------------------------------------

  test.describe('ticket capacity', () => {
    const run = randomUUID().slice(0, 8)
    const slug = `pkge-capacity-${run}`
    let eventId = ''
    const accounts: string[] = []

    async function account(): Promise<string> {
      const suffix = randomUUID().slice(0, 8)
      const [row] = await db.sql<{ id: string }[]>`
        insert into accounts (did, handle, email, kind, email_verified_at)
        values (${`did:plc:pkgecap${suffix}`}, ${`pkgecap-${suffix}.test`}, ${`pkge-cap-${run}-${suffix}@example.test`}, 'custodial', now())
        returning id
      `
      accounts.push(row.id)
      return row.id
    }

    async function tier(priceCents: number, seats: number | null = 1): Promise<string> {
      const [row] = await db.sql<{ id: string }[]>`
        insert into ticket_tiers (event_id, name, price_cents, quantity_total)
        values (${eventId}, ${`Tier ${randomUUID().slice(0, 4)}`}, ${priceCents}, ${seats}) returning id
      `
      return row.id
    }

    /** Stands in for Stripe at the CheckoutGateway boundary. */
    function fakeGateway(opts: { fail?: boolean; delayMs?: number } = {}) {
      const created: Array<{ ticketId: string; expiresAt: Date; id: string }> = []
      const expired: string[] = []
      const gateway: import('../src/lib/tickets').CheckoutGateway = {
        createSession: async (input) => {
          await new Promise((r) => setTimeout(r, opts.delayMs ?? 5))
          if (opts.fail) throw new Error('stripe down')
          const id = `cs_test_${randomUUID().replace(/-/g, '')}`
          created.push({ ticketId: input.ticketId, expiresAt: input.expiresAt, id })
          return { id, url: `https://checkout.stripe.test/${id}` }
        },
        expireSession: async (id) => {
          expired.push(id)
          return 'expired'
        },
      }
      return { gateway, created, expired }
    }

    const event = () => ({ id: eventId, slug, name: 'Capacity test', stripe_account_id: null })
    const checkout = (tierId: string, accountId: string, gateway: import('../src/lib/tickets').CheckoutGateway) =>
      tickets.startPaidCheckout({ event: event(), tierId, holder: { accountId, email: null }, origin: base }, gateway)

    async function statusOf(ticketId: string) {
      const [row] = await db.sql<{ status: string; hold_expires_at: string | null }[]>`
        select status, hold_expires_at from tickets where id = ${ticketId}
      `
      return row ?? null
    }

    test.beforeAll(async () => {
      ;[{ id: eventId }] = await db.sql<{ id: string }[]>`
        insert into events (slug, name, start_date, end_date, status, visibility, ticketing_enabled)
        values (${slug}, 'Capacity test', current_date + 30, current_date + 31, 'published', 'public', true)
        returning id
      `
    })

    test.afterAll(async () => {
      await db.sql`delete from refunded_payments where payment_fingerprint = ${createHash('sha256').update(`pi_a_${run}`).digest('hex')}`
      if (eventId) await db.sql`delete from events where id = ${eventId}`
      if (accounts.length) await db.sql`delete from accounts where id in ${db.sql(accounts)}`
    })

    test('two concurrent free claims for a 1-seat tier: exactly one succeeds', async () => {
      for (let round = 0; round < 5; round++) {
        const tierId = await tier(0, 1)
        const [a, b] = [await account(), await account()]
        const results = await Promise.all([
          tickets.claimFreeTicket({ eventId, tierId, accountId: a }),
          tickets.claimFreeTicket({ eventId, tierId, accountId: b }),
        ])
        expect(results.filter((r) => r.ok)).toHaveLength(1)
        expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, status: 409, code: 'SOLDOUT' })
        const [n] = await db.sql<{ n: number }[]>`select count(*)::int as n from tickets where tier_id = ${tierId} and status = 'confirmed'`
        expect(n.n).toBe(1)
      }
    })

    test('two concurrent paid checkouts for a 1-seat tier: exactly one holds the seat', async () => {
      for (let round = 0; round < 5; round++) {
        const tierId = await tier(2500, 1)
        const [a, b] = [await account(), await account()]
        const { gateway, created } = fakeGateway({ delayMs: 20 })
        const before = Date.now()
        const results = await Promise.all([checkout(tierId, a, gateway), checkout(tierId, b, gateway)])
        const winners = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok)
        expect(winners).toHaveLength(1)
        expect(results.find((r) => !r.ok)).toMatchObject({ status: 409, code: 'SOLDOUT' })
        expect(created).toHaveLength(1)

        // The session expires exactly when the hold does, 30+ minutes out.
        const hold = await statusOf(winners[0].ticketId)
        expect(hold?.status).toBe('pending')
        expect(new Date(hold!.hold_expires_at!).getTime()).toBe(created[0].expiresAt.getTime())
        expect(created[0].expiresAt.getTime() - before).toBeGreaterThanOrEqual(30 * 60 * 1000)
        const [session] = await db.sql<{ checkout_session_id: string }[]>`select checkout_session_id from tickets where id = ${winners[0].ticketId}`
        expect(session.checkout_session_id).toBe(created[0].id)
      }
    })

    test('an expired hold frees the seat; a restarted checkout closes its previous session', async () => {
      const tierId = await tier(2500, 1)
      const [a, b] = [await account(), await account()]
      const { gateway, expired } = fakeGateway()
      const first = await checkout(tierId, a, gateway)
      expect(first.ok).toBe(true)
      expect(await checkout(tierId, b, gateway)).toMatchObject({ ok: false, code: 'SOLDOUT' })

      // A restarting keeps the same seat and the old session is expired first.
      const again = await checkout(tierId, a, gateway)
      expect(again).toMatchObject({ ok: true, ticketId: (first as { ticketId: string }).ticketId })
      expect(expired).toEqual([(first as { sessionId: string }).sessionId])

      await db.sql`update tickets set hold_expires_at = now() - interval '1 second' where id = ${(first as { ticketId: string }).ticketId}`
      expect(await checkout(tierId, b, gateway)).toMatchObject({ ok: true })

      // Retention sweeps the lapsed hold (rolled back here).
      await rolledBack(async (t) => {
        const report = await retention.runRetention(t)
        expect(report.ticket_holds_expired).toBeGreaterThanOrEqual(1)
        const [gone] = await t<{ n: number }[]>`select count(*)::int as n from tickets where id = ${(first as { ticketId: string }).ticketId}`
        expect(gone.n).toBe(0)
      })
    })

    test('a failed Stripe call releases the hold immediately', async () => {
      const tierId = await tier(2500, 1)
      const a = await account()
      expect(await checkout(tierId, a, fakeGateway({ fail: true }).gateway)).toMatchObject({ ok: false, status: 502 })
      const [n] = await db.sql<{ n: number }[]>`select count(*)::int as n from tickets where tier_id = ${tierId}`
      expect(n.n).toBe(0)
      expect(await checkout(tierId, await account(), fakeGateway().gateway)).toMatchObject({ ok: true })
    })

    test('settlement: valid hold confirms once; lapsed hold confirms only with room, else refund_needed', async () => {
      const tierId = await tier(2500, 1)
      const [a, b] = [await account(), await account()]
      const { gateway, created } = fakeGateway()

      // A's hold lapses before payment is reported; B takes the seat and pays in time.
      const holdA = (await checkout(tierId, a, gateway)) as { ticketId: string; sessionId: string }
      await db.sql`update tickets set hold_expires_at = now() - interval '1 second' where id = ${holdA.ticketId}`
      const holdB = (await checkout(tierId, b, gateway)) as { ticketId: string; sessionId: string }
      expect(created).toHaveLength(2)

      const settle = (hold: { ticketId: string; sessionId: string }, holderId: string, pi: string) =>
        tickets.settlePaidCheckout({
          ticketId: hold.ticketId, eventId, tierId, holderId, sessionId: hold.sessionId, paymentIntentId: pi, amountPaidCents: 2500,
        })

      expect(await settle(holdB, b, `pi_b_${run}`)).toBe('confirmed')
      expect(await settle(holdB, b, `pi_b_${run}`)).toBe('already_confirmed')
      const [member] = await db.sql<{ role: string }[]>`select role from event_members where event_id = ${eventId} and user_id = ${b}`
      expect(member?.role).toBe('attendee')
      const [note] = await db.sql<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${b} and type = 'ticket_confirmed'`
      expect(note.n).toBe(1)

      expect(await settle(holdA, a, `pi_a_${run}`)).toBe('refund_needed')
      expect((await statusOf(holdA.ticketId))?.status).toBe('refund_needed')
      const [seats] = await db.sql<{ n: number }[]>`select count(*)::int as n from tickets where tier_id = ${tierId} and status = 'confirmed'`
      expect(seats.n).toBe(1)

      // A refund in Stripe clears it.
      expect(await tickets.cancelRefundedTicket(`pi_a_${run}`)).toBe(1)
      expect((await statusOf(holdA.ticketId))?.status).toBe('cancelled')
    })

    test('settlement: a swept hold is recreated from the checkout reference when a seat is free', async () => {
      const tierId = await tier(2500, 2)
      const a = await account()
      const hold = (await checkout(tierId, a, fakeGateway().gateway)) as { ticketId: string; sessionId: string }
      await db.sql`delete from tickets where id = ${hold.ticketId}`
      const outcome = await tickets.settlePaidCheckout({
        ticketId: hold.ticketId, eventId, tierId, holderId: a, sessionId: hold.sessionId, paymentIntentId: `pi_swept_${run}`, amountPaidCents: 2500,
      })
      expect(outcome).toBe('confirmed')
      const rows = await db.sql<{ status: string }[]>`select status from tickets where tier_id = ${tierId} and user_id = ${a}`
      expect(rows).toEqual([{ status: 'confirmed' }])
    })

    test('two lapsed holds settling at once for the last seat: one confirmed, one refund_needed', async () => {
      const tierId = await tier(2500, 1)
      const [a, b] = [await account(), await account()]
      const { gateway } = fakeGateway()
      const holdA = (await checkout(tierId, a, gateway)) as { ticketId: string; sessionId: string }
      await db.sql`update tickets set hold_expires_at = now() - interval '1 second' where id = ${holdA.ticketId}`
      const holdB = (await checkout(tierId, b, gateway)) as { ticketId: string; sessionId: string }
      await db.sql`update tickets set hold_expires_at = now() - interval '1 second' where id = ${holdB.ticketId}`

      const outcomes = await Promise.all([
        tickets.settlePaidCheckout({ ticketId: holdA.ticketId, eventId, tierId, holderId: a, sessionId: holdA.sessionId, paymentIntentId: `pi_ra_${run}`, amountPaidCents: 2500 }),
        tickets.settlePaidCheckout({ ticketId: holdB.ticketId, eventId, tierId, holderId: b, sessionId: holdB.sessionId, paymentIntentId: `pi_rb_${run}`, amountPaidCents: 2500 }),
      ])
      expect(outcomes.sort()).toEqual(['confirmed', 'refund_needed'])
    })

    test('an expired-session webhook releases only that session’s hold', async () => {
      const tierId = await tier(2500, 1)
      const a = await account()
      const { gateway } = fakeGateway()
      const first = (await checkout(tierId, a, gateway)) as { ticketId: string; sessionId: string }
      const second = (await checkout(tierId, a, gateway)) as { ticketId: string; sessionId: string }
      expect(second.ticketId).toBe(first.ticketId)
      expect(await tickets.releaseCheckoutHold({ ticketId: first.ticketId, eventId, sessionId: first.sessionId })).toBe(false)
      expect((await statusOf(first.ticketId))?.status).toBe('pending')
      expect(await tickets.releaseCheckoutHold({ ticketId: first.ticketId, eventId, sessionId: second.sessionId })).toBe(true)
      expect(await statusOf(first.ticketId)).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // HTTP, with real accounts
  // ---------------------------------------------------------------------------

  test.describe('over HTTP', () => {
    test.skip(!pdsUrl || !pdsAdminPassword, 'PDS_URL / PDS_ADMIN_PASSWORD are not set')

    const run = randomUUID().slice(0, 8)
    const emailA = `pkge-http-${run}-a@example.test`
    const emailB = `pkge-http-${run}-b@example.test`
    const slug = `pkge-tickets-${run}`
    let cookieA = ''
    let cookieB = ''
    let accountA = { id: '', did: '' }
    let accountB = { id: '', did: '' }
    let eventId = ''
    let freeTierId = ''
    let ticketId = ''

    async function signIn(email: string): Promise<string> {
      return signInWithEmail(email, base)
    }

    test.beforeAll(async () => {
      cookieA = await signIn(emailA)
      cookieB = await signIn(emailB)
      ;[accountA] = await db.sql<{ id: string; did: string }[]>`select id, did from accounts where email = ${emailA}`
      ;[accountB] = await db.sql<{ id: string; did: string }[]>`select id, did from accounts where email = ${emailB}`
      ;[{ id: eventId }] = await db.sql<{ id: string }[]>`
        insert into events (slug, name, start_date, end_date, status, visibility, ticketing_enabled)
        values (${slug}, 'Package E ticket test', current_date + 30, current_date + 31, 'published', 'public', true)
        returning id
      `
      ;[{ id: freeTierId }] = await db.sql<{ id: string }[]>`
        insert into ticket_tiers (event_id, name, price_cents) values (${eventId}, 'Community', 0) returning id
      `
    })

    test.afterAll(async () => {
      if (eventId) await db.sql`delete from events where id = ${eventId}`
      const dids = await db.sql<{ did: string }[]>`select did from accounts where email in ${db.sql([emailA, emailB])}`
      for (const { did } of dids) {
        await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`,
          },
          body: JSON.stringify({ did }),
        })
      }
      await db.sql`delete from accounts where email in ${db.sql([emailA, emailB])}`
      await db.sql`delete from auth_email_tokens where email in ${db.sql([emailA, emailB])}`
    })

    test('GET /api/me/notifications returns only the viewer’s rows', async () => {
      await db.tx(async (t) => {
        await notifications.notify(t, { eventId, userIds: [accountA.id], type: 'admin_announcement', title: `for A ${run}` })
        await notifications.notify(t, { eventId, userIds: [accountB.id], type: 'admin_announcement', title: `for B ${run}` })
        await notifications.notify(t, { eventId: null, userIds: [accountA.id], type: 'admin_announcement', title: `global A ${run}` })
      })

      expect((await fetch(`${base}/api/me/notifications`)).status).toBe(401)

      const resA = await fetch(`${base}/api/me/notifications?limit=50`, { headers: { cookie: cookieA } })
      expect(resA.status).toBe(200)
      const feedA = await resA.json()
      const titlesA = feedA.notifications.map((n: { title: string }) => n.title)
      expect(titlesA).toEqual(expect.arrayContaining([`for A ${run}`, `global A ${run}`]))
      expect(titlesA).not.toContain(`for B ${run}`)
      expect(feedA.unreadCount).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(feedA)).not.toContain(accountB.id)

      const scoped = await (await fetch(`${base}/api/me/notifications?event=${slug}`, { headers: { cookie: cookieA } })).json()
      expect(scoped.notifications.map((n: { title: string }) => n.title)).toEqual([`for A ${run}`])

      const feedB = await (await fetch(`${base}/api/me/notifications`, { headers: { cookie: cookieB } })).json()
      expect(feedB.notifications.map((n: { title: string }) => n.title)).toEqual([`for B ${run}`])

      // A cannot mark B's notification read.
      const bId = feedB.notifications[0].id
      const markOther = await fetch(`${base}/api/me/notifications/read`, {
        method: 'POST',
        headers: { cookie: cookieA, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [bId] }),
      })
      expect(await markOther.json()).toEqual({ updated: 0 })
    })

    test('POST /api/me/notifications/read refuses cross-origin requests and marks own rows', async () => {
      const crossOrigin = await fetch(`${base}/api/me/notifications/read`, {
        method: 'POST',
        headers: { cookie: cookieA, origin: 'https://evil.example', 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      expect(crossOrigin.status).toBe(403)

      const ok = await fetch(`${base}/api/me/notifications/read`, {
        method: 'POST',
        headers: { cookie: cookieA, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ all: true, event: slug }),
      })
      expect(ok.status).toBe(200)
      expect((await ok.json()).updated).toBe(1)
      const [unread] = await db.sql<{ n: number }[]>`
        select count(*)::int as n from notifications where user_id = ${accountA.id} and read_at is null and event_id = ${eventId}
      `
      expect(unread.n).toBe(0)
    })

    test('notification preferences round-trip per event', async () => {
      const put = await fetch(`${base}/api/me/notification-preferences?event=${slug}`, {
        method: 'PUT',
        headers: { cookie: cookieA, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ preferences: [{ category: 'collaboration', email_enabled: false }] }),
      })
      expect(put.status).toBe(200)
      const body = await put.json()
      const collab = body.preferences.find((p: { category: string }) => p.category === 'collaboration')
      expect(collab).toMatchObject({ email_enabled: false, in_app_enabled: true, source: 'event' })

      const global = await (await fetch(`${base}/api/me/notification-preferences`, { headers: { cookie: cookieA } })).json()
      expect(global.preferences.find((p: { category: string }) => p.category === 'collaboration').source).toBe('default')

      const missing = await fetch(`${base}/api/me/notification-preferences?event=no-such-${run}`, { headers: { cookie: cookieA } })
      expect(missing.status).toBe(404)
    })

    test('a free ticket claim creates membership and a ticket_confirmed notification', async () => {
      const claim = await fetch(`${base}/api/v1/events/${slug}/checkout`, {
        method: 'POST',
        headers: { cookie: cookieA, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ tierId: freeTierId }),
      })
      const body = await claim.json()
      expect(claim.status, JSON.stringify(body)).toBe(200)
      expect(body.status).toBe('confirmed')
      ticketId = body.ticketId

      const [ticket] = await db.sql<{ status: string; user_id: string }[]>`select status, user_id from tickets where id = ${ticketId}`
      expect(ticket).toEqual({ status: 'confirmed', user_id: accountA.id })
      const [member] = await db.sql<{ role: string }[]>`
        select role from event_members where event_id = ${eventId} and user_id = ${accountA.id}
      `
      expect(member?.role).toBe('attendee')
      const confirmed = await db.sql<{ action_url: string }[]>`
        select action_url from notifications where user_id = ${accountA.id} and event_id = ${eventId} and type = 'ticket_confirmed'
      `
      expect(confirmed).toEqual([{ action_url: `/e/${slug}/tickets/${ticketId}` }])

      const again = await fetch(`${base}/api/v1/events/${slug}/checkout`, {
        method: 'POST',
        headers: { cookie: cookieA, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ tierId: freeTierId }),
      })
      expect(again.status).toBe(409)

      // Paid tiers need Stripe: without it (local), 503 before anything is reserved.
      const [{ id: paidTierId }] = await db.sql<{ id: string }[]>`
        insert into ticket_tiers (event_id, name, price_cents) values (${eventId}, 'Supporter', 2500) returning id
      `
      const paid = await fetch(`${base}/api/v1/events/${slug}/checkout`, {
        method: 'POST',
        headers: { cookie: cookieA, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ tierId: paidTierId }),
      })
      expect(paid.status).toBe(503)
      const [pending] = await db.sql<{ n: number }[]>`select count(*)::int as n from tickets where tier_id = ${paidTierId}`
      expect(pending.n).toBe(0)
      const webhook = await fetch(`${base}/api/webhooks/stripe`, { method: 'POST', body: '{}' })
      expect(webhook.status).toBe(503)

      // The QR route serves the holder only.
      const own = await fetch(`${base}/api/v1/events/${slug}/tickets/${ticketId}/qr`, { headers: { cookie: cookieA } })
      expect(own.status).toBe(200)
      expect((await own.json()).qrDataUrl).toMatch(/^data:image\/png;base64,/)
      const other = await fetch(`${base}/api/v1/events/${slug}/tickets/${ticketId}/qr`, { headers: { cookie: cookieB } })
      expect(other.status).toBe(404)
    })

    test('QR verification rejects a token for a different DID and checks in the holder once', async () => {
      expect(ticketId).toBeTruthy()
      const forB = await qr.mintTicketToken({ event_id: eventId, ticket_id: ticketId, did: accountB.did })
      const wrong = await tickets.verifyTicketForCheckin(db.sql, { token: forB.token, eventId })
      expect(wrong).toMatchObject({ ok: false, code: 'WRONG_HOLDER' })

      const forA = await qr.mintTicketToken({ event_id: eventId, ticket_id: ticketId, did: accountA.did })
      expect(await tickets.verifyTicketForCheckin(db.sql, { token: forA.token, eventId: randomUUID() })).toMatchObject({ ok: false, code: 'WRONG_EVENT' })
      const expired = await qr.mintTicketToken({ event_id: eventId, ticket_id: ticketId, did: accountA.did }, new Date(Date.now() - 60 * 60 * 1000))
      expect(await tickets.verifyTicketForCheckin(db.sql, { token: expired.token, eventId })).toMatchObject({ ok: false, code: 'INVALID_TOKEN' })
      expect(await tickets.verifyTicketForCheckin(db.sql, { token: forA.token, eventId })).toMatchObject({ ok: true, ticketId })

      // B at the door: attendees cannot check in; volunteers can, once.
      const asAttendee = await fetch(`${base}/api/v1/events/${slug}/checkin`, {
        method: 'POST',
        headers: { cookie: cookieB, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ qrToken: forA.token }),
      })
      expect(asAttendee.status).toBe(403)

      await db.sql`insert into event_members (event_id, user_id, role) values (${eventId}, ${accountB.id}, 'volunteer')`
      const wrongHolder = await fetch(`${base}/api/v1/events/${slug}/checkin`, {
        method: 'POST',
        headers: { cookie: cookieB, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ qrToken: forB.token }),
      })
      expect(wrongHolder.status).toBe(400)
      expect((await wrongHolder.json()).code).toBe('WRONG_HOLDER')

      const checkin = await fetch(`${base}/api/v1/events/${slug}/checkin`, {
        method: 'POST',
        headers: { cookie: cookieB, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ qrToken: forA.token }),
      })
      const checkinBody = await checkin.json()
      expect(checkin.status, JSON.stringify(checkinBody)).toBe(200)
      expect(checkinBody.attendee.ticketId).toBe(ticketId)
      expect(JSON.stringify(checkinBody)).not.toContain('@example.test')

      const twice = await fetch(`${base}/api/v1/events/${slug}/checkin`, {
        method: 'POST',
        headers: { cookie: cookieB, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ qrToken: forA.token }),
      })
      expect(twice.status).toBe(409)
      expect((await twice.json()).code).toBe('ALREADY_CHECKED_IN')
    })
  })
})
