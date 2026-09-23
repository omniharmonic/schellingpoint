import 'server-only'
import { createHash } from 'node:crypto'
import type postgres from 'postgres'
import { sql, tx } from '@/lib/db'
import { getViewer, eventRole, type Viewer } from '@/lib/auth/viewer'
import { notify } from '@/lib/notifications'
import { canRolePerform } from '@/lib/permissions'
import type { EventRoleName } from '@/types/event'
import { readTicketToken } from './qr'
import { calculatePlatformFee } from '@/lib/payments/format'
import {
  findReferenceForTicket,
  markReferencesRefundedForSessions,
  writeCheckoutReference,
  type ChargeModel,
} from '@/lib/payments/references'

/**
 * Tickets are app-side entitlements bound to an account, and so to its DID (spec §5.5). They
 * are never records. Confirmation — free claim or paid webhook — is one transaction that sets
 * the ticket confirmed, adds the holder as an attendee if they are not a member yet, and emits
 * `ticket_confirmed` (this replaces the `trigger_add_ticket_holder_as_member` trigger).
 * Seats are reserved under a tier row lock; paid checkouts hold a seat until their Stripe
 * session expires.
 */

type Tx = postgres.TransactionSql

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error, ...extra }, { status, headers: NO_STORE })
}

// -----------------------------------------------------------------------------
// Event access
// -----------------------------------------------------------------------------

export interface TicketEvent {
  id: string
  slug: string
  name: string
  status: string
  visibility: string
  ticketing_enabled: boolean
  stripe_account_id: string | null
}

/**
 * The event by slug with the (optional) viewer and their role. Draft and private events
 * answer 404 to anyone who is not a member, exactly like `requireEventRole`.
 */
export async function loadTicketEvent(
  request: Request,
  slug: string,
): Promise<{ event: TicketEvent; viewer: Viewer | null; role: EventRoleName | null } | Response> {
  const [viewer, rows] = await Promise.all([
    getViewer(request),
    sql<TicketEvent[]>`
      select id, slug, name, status, visibility, ticketing_enabled, stripe_account_id
      from events where slug = ${slug}
    `,
  ])
  const event = rows[0]
  if (!event) return jsonError(404, 'Event not found')
  const role = viewer ? await eventRole(event.id, viewer.accountId) : null
  if ((event.visibility === 'private' || event.status === 'draft') && !role) return jsonError(404, 'Event not found')
  return { event, viewer, role }
}

export const CHECKIN_ROLES: readonly EventRoleName[] = (
  ['owner', 'admin', 'moderator', 'track_lead', 'volunteer', 'attendee'] as const
).filter((role) => canRolePerform(role, 'checkInAttendees'))

export const TICKET_ADMIN_ROLES: readonly EventRoleName[] = ['owner', 'admin']

// -----------------------------------------------------------------------------
// Tiers
// -----------------------------------------------------------------------------

export interface TierRow {
  id: string
  event_id: string
  name: string
  description: string | null
  price_cents: number
  currency: string
  quantity_total: number | null
  quantity_sold: number
  sale_starts_at: string | null
  sale_ends_at: string | null
  is_active: boolean
  display_order: number
  allows_proposals: boolean
  allows_voting: boolean
  vote_credits_override: number | null
}

export type TierAvailability = 'available' | 'inactive' | 'upcoming' | 'ended' | 'soldout'

export function tierAvailability(tier: TierRow, now: Date = new Date()): TierAvailability {
  if (!tier.is_active) return 'inactive'
  if (tier.sale_starts_at && new Date(tier.sale_starts_at) > now) return 'upcoming'
  if (tier.sale_ends_at && new Date(tier.sale_ends_at) < now) return 'ended'
  if (tier.quantity_total !== null && tier.quantity_sold >= tier.quantity_total) return 'soldout'
  return 'available'
}

const AVAILABILITY_ERROR: Record<Exclude<TierAvailability, 'available'>, string> = {
  inactive: 'This ticket tier is not available',
  upcoming: 'Ticket sales have not started yet',
  ended: 'Ticket sales have ended',
  soldout: 'This ticket tier is sold out',
}

// -----------------------------------------------------------------------------
// Capacity, claiming, holds, settlement
// -----------------------------------------------------------------------------
//
// Capacity of a tier = confirmed/checked-in tickets + unexpired `pending` holds. Every path
// that can take a seat (free claim, paid hold, webhook settlement) first locks the tier row
// (`SELECT … FOR UPDATE`), so concurrent claims on the last seat serialize and exactly one
// wins. `refund_needed` rows and expired holds occupy nothing.

/**
 * Seconds a paid checkout holds its seat; the Stripe session's `expires_at` is set to the same
 * instant. Stripe accepts 30 minutes to 24 hours after session creation, so the hold is 30
 * minutes plus one minute of slack for the round trip to Stripe.
 */
export const CHECKOUT_HOLD_SECONDS = 30 * 60 + 60

export type ClaimFailure = { ok: false; status: number; error: string; code: string }

export type FreeClaimResult = { ok: true; ticketId: string; status: 'confirmed' } | ClaimFailure

async function lockTier(t: Tx, eventId: string, tierId: string): Promise<TierRow | null> {
  const rows = await t<TierRow[]>`
    select id, event_id, name, description, price_cents, currency, quantity_total, quantity_sold,
           sale_starts_at, sale_ends_at, is_active, display_order, allows_proposals, allows_voting,
           vote_credits_override
    from ticket_tiers
    where id = ${tierId} and event_id = ${eventId}
    for update
  `
  return rows[0] ?? null
}

/** Seats taken in a tier (call with the tier locked). `excludeTicketId` leaves one row out. */
async function seatsTaken(t: Tx, tierId: string, excludeTicketId: string | null = null): Promise<number> {
  const [row] = await t<{ n: number }[]>`
    select count(*)::int as n
    from tickets
    where tier_id = ${tierId}
      and (status in ('confirmed', 'checked_in') or (status = 'pending' and hold_expires_at > now()))
      ${excludeTicketId ? t`and id <> ${excludeTicketId}` : t``}
  `
  return row.n
}

function hasRoom(tier: TierRow, taken: number): boolean {
  return tier.quantity_total === null || taken < tier.quantity_total
}

const SOLD_OUT: ClaimFailure = { ok: false, status: 409, error: AVAILABILITY_ERROR.soldout, code: 'SOLDOUT' }

/** Sale window and activity only; capacity is checked separately under the lock. */
function windowFailure(tier: TierRow): ClaimFailure | null {
  const availability = tierAvailability({ ...tier, quantity_total: null })
  return availability === 'available'
    ? null
    : { ok: false, status: 409, error: AVAILABILITY_ERROR[availability], code: availability.toUpperCase() }
}

interface LiveTicket {
  id: string
  status: 'pending' | 'confirmed' | 'checked_in'
  hold_expires_at: string | null
  checkout_session_id: string | null
}

async function liveTicketFor(t: Tx, tierId: string, accountId: string): Promise<LiveTicket | null> {
  const rows = await t<LiveTicket[]>`
    select id, status, hold_expires_at, checkout_session_id from tickets
    where tier_id = ${tierId} and user_id = ${accountId} and status in ('pending', 'confirmed', 'checked_in')
    for update
  `
  return rows[0] ?? null
}

/**
 * After a ticket became confirmed inside `t`: attendee membership if missing (vote credits
 * from the tier override or the event default, as the old trigger did) and the notification.
 */
async function afterConfirmed(t: Tx, ticketId: string): Promise<void> {
  const [row] = await t<{
    event_id: string; user_id: string; slug: string; event_name: string; tier_name: string; credits: number | null
  }[]>`
    select tk.event_id, tk.user_id, e.slug, e.name as event_name, tt.name as tier_name,
           coalesce(tt.vote_credits_override, e.vote_credits_per_user) as credits
    from tickets tk
    join ticket_tiers tt on tt.id = tk.tier_id
    join events e on e.id = tk.event_id
    where tk.id = ${ticketId}
  `
  if (!row) return
  await t`
    insert into event_members (event_id, user_id, role, vote_credits)
    values (${row.event_id}, ${row.user_id}, 'attendee', ${row.credits})
    on conflict (event_id, user_id) do nothing
  `
  await notify(t, {
    eventId: row.event_id,
    userIds: [row.user_id],
    type: 'ticket_confirmed',
    title: 'Your ticket is confirmed',
    body: `${row.tier_name} for ${row.event_name}. Show the QR code on your ticket page at check-in.`,
    actionUrl: `/e/${row.slug}/tickets/${ticketId}`,
    data: { ticket_id: ticketId },
  })
}

/** Free tier: a confirmed ticket for the account, created server-side only. */
export async function claimFreeTicket(input: { eventId: string; tierId: string; accountId: string }): Promise<FreeClaimResult> {
  return tx(async (t) => {
    const tier = await lockTier(t, input.eventId, input.tierId)
    if (!tier) return { ok: false, status: 404, error: 'Ticket tier not found', code: 'TIER_NOT_FOUND' }
    if (tier.price_cents !== 0) return { ok: false, status: 400, error: 'This tier requires payment', code: 'PAID_TIER' }
    const closed = windowFailure(tier)
    if (closed) return closed

    const existing = await liveTicketFor(t, tier.id, input.accountId)
    if (existing && existing.status !== 'pending') {
      return { ok: false, status: 409, error: 'You already have a ticket for this tier', code: 'ALREADY_HAS_TICKET' }
    }
    if (!hasRoom(tier, await seatsTaken(t, tier.id, existing?.id ?? null))) return SOLD_OUT

    let ticketId: string
    if (existing) {
      // A hold left from when the tier was paid: confirm it.
      await t`
        update tickets
        set status = 'confirmed', amount_paid_cents = 0, payment_confirmed_at = now(), hold_expires_at = null, updated_at = now()
        where id = ${existing.id}
      `
      ticketId = existing.id
    } else {
      const [ticket] = await t<{ id: string }[]>`
        insert into tickets (event_id, tier_id, user_id, status, amount_paid_cents, payment_confirmed_at)
        values (${input.eventId}, ${tier.id}, ${input.accountId}, 'confirmed', 0, now())
        returning id
      `
      ticketId = ticket.id
    }
    await afterConfirmed(t, ticketId)
    return { ok: true, ticketId, status: 'confirmed' }
  })
}

export type HoldResult =
  | { ok: true; ticketId: string; reused: boolean; previousSessionId: string | null; holdExpiresAt: Date }
  | ClaimFailure

/**
 * Reserves a seat in a paid tier for `CHECKOUT_HOLD_SECONDS`. A holder restarting checkout
 * reuses their hold (its expiry is renewed and the previous session id returned so it can be
 * closed).
 */
export async function reserveTicketHold(
  input: { eventId: string; tierId: string; accountId: string },
  now: Date = new Date(),
  transaction?: Tx,
): Promise<HoldResult> {
  const holdExpiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + CHECKOUT_HOLD_SECONDS * 1000)
  const reserve = async (t: Tx): Promise<HoldResult> => {
    const tier = await lockTier(t, input.eventId, input.tierId)
    if (!tier) return { ok: false, status: 404, error: 'Ticket tier not found', code: 'TIER_NOT_FOUND' }
    if (tier.price_cents === 0) return { ok: false, status: 400, error: 'This tier is free', code: 'FREE_TIER' }
    const closed = windowFailure(tier)
    if (closed) return closed

    const existing = await liveTicketFor(t, tier.id, input.accountId)
    if (existing && existing.status !== 'pending') {
      return { ok: false, status: 409, error: 'You already have a ticket for this tier', code: 'ALREADY_HAS_TICKET' }
    }
    if (!hasRoom(tier, await seatsTaken(t, tier.id, existing?.id ?? null))) return SOLD_OUT

    if (existing) {
      await t`update tickets set hold_expires_at = ${holdExpiresAt}, updated_at = now() where id = ${existing.id}`
      return { ok: true, ticketId: existing.id, reused: true, previousSessionId: existing.checkout_session_id, holdExpiresAt }
    }
    const [ticket] = await t<{ id: string }[]>`
      insert into tickets (event_id, tier_id, user_id, status, hold_expires_at)
      values (${input.eventId}, ${tier.id}, ${input.accountId}, 'pending', ${holdExpiresAt})
      returning id
    `
    return { ok: true, ticketId: ticket.id, reused: false, previousSessionId: null, holdExpiresAt }
  }
  return transaction ? reserve(transaction) : tx(reserve)
}

/** Stripe calls used by `startPaidCheckout`, injectable so tests can stand in for Stripe. */
export interface CheckoutGateway {
  createSession(input: {
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
    customerEmail: string | null
    stripeAccountId: string | null
    successUrl: string
    cancelUrl: string
  }): Promise<{ id: string; url: string | null }>
  /**
   * A session lives in the account it was created in: a direct-charge session is invisible to
   * a platform-scoped call, so the account recorded in `checkout_references` is passed back.
   */
  expireSession(sessionId: string, connectedAccountId: string | null): Promise<'expired' | 'complete' | 'open'>
}

export type CheckoutResult = { ok: true; ticketId: string; sessionId: string; url: string | null } | ClaimFailure

/**
 * Paid checkout: take a hold under the tier lock, then open a Stripe session that expires with
 * the hold, then record the immutable quote for that session before the URL leaves this
 * function. If Stripe fails — or the reference cannot be written — the seat is released
 * immediately and the buyer never sees a payment page we could not vouch for.
 *
 * With a connected account the session is opened in *that* account's context and the platform
 * takes `application_fee_amount` (model `direct`). Without one, only the opt-in platform
 * fallback remains, which takes no fee at all (model `platform`).
 */
export async function startPaidCheckout(
  input: {
    event: { id: string; slug: string; name: string; stripe_account_id: string | null }
    tierId: string
    holder: { accountId: string; email: string | null }
    origin: string
  },
  gateway: CheckoutGateway,
): Promise<CheckoutResult> {
  return tx(async (t): Promise<CheckoutResult> => {
    const key = `checkout:${input.event.id}:${input.tierId}:${input.holder.accountId}`
    const [lock] = await t`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as acquired`
    if (!lock.acquired) return { ok: false, status: 409, code: 'CHECKOUT_IN_PROGRESS', error: 'Checkout is already opening. Please wait a moment.' }
    const hold = await reserveTicketHold({ eventId: input.event.id, tierId: input.tierId, accountId: input.holder.accountId }, new Date(), t)
    if (!hold.ok) return hold

    const release = async () => {
      if (hold.reused) {
        await t`update tickets set hold_expires_at = now(), updated_at = now() where id = ${hold.ticketId} and status = 'pending'`
      } else {
        await t`delete from tickets where id = ${hold.ticketId} and status = 'pending'`
      }
    }

    let opened: { id: string; account: string | null } | null = null
    try {
      if (hold.previousSessionId) {
        // Never leave two payable sessions for one seat. The old session is closed in the
        // account it was opened in, which the reference (not today's event row) records.
        const previousReference = await findReferenceForTicket(hold.ticketId, t)
        const previous = await gateway.expireSession(
          hold.previousSessionId,
          previousReference?.session_id === hold.previousSessionId ? previousReference.connected_account_id : null,
        )
        if (previous !== 'expired') {
          return {
            ok: false, status: 409, code: 'PAYMENT_IN_PROGRESS',
            error: previous === 'complete' ? 'Your previous checkout was paid; your ticket will appear shortly' : 'Your previous checkout is still open. Please finish it before starting another.',
          }
        }
      }

      const [tier] = await t<{ name: string; price_cents: number; currency: string }[]>`
        select name, price_cents, currency from ticket_tiers where id = ${input.tierId}
      `
      const [contribution] = await t<{ platform_fee_percent: number }[]>`select platform_fee_percent from events where id = ${input.event.id}`
      const connectedAccountId = input.event.stripe_account_id
      const model: ChargeModel = connectedAccountId ? 'direct' : 'platform'
      const appliedPercent = connectedAccountId ? Number(contribution.platform_fee_percent) : 0
      const platformFeeCents = connectedAccountId ? calculatePlatformFee(tier.price_cents, appliedPercent) : 0
      await t`update tickets set quoted_price_cents = ${tier.price_cents}, paid_currency = ${tier.currency},
        platform_fee_cents = ${platformFeeCents} where id = ${hold.ticketId}`
      const base = `${input.origin}/e/${encodeURIComponent(input.event.slug)}/tickets`
      const session = await gateway.createSession({
        ticketId: hold.ticketId,
        tierId: input.tierId,
        holderId: input.holder.accountId,
        expiresAt: hold.holdExpiresAt,
        tierName: tier.name,
        priceCents: tier.price_cents,
        platformFeeCents,
        currency: tier.currency,
        eventId: input.event.id,
        eventName: input.event.name,
        customerEmail: input.holder.email,
        stripeAccountId: connectedAccountId,
        successUrl: `${base}/success?ticket=${hold.ticketId}`,
        cancelUrl: `${base}?cancelled=true`,
      })
      opened = { id: session.id, account: connectedAccountId }
      await t`update tickets set checkout_session_id = ${session.id}, updated_at = now() where id = ${hold.ticketId}`
      // The immutable quote. Nothing may be settled for this session without it.
      await writeCheckoutReference(t, {
        sessionId: session.id,
        connectedAccountId,
        eventId: input.event.id,
        tierId: input.tierId,
        ticketId: hold.ticketId,
        holderAccountId: input.holder.accountId,
        unitAmount: tier.price_cents,
        currency: tier.currency,
        contributionPercent: appliedPercent,
        applicationFeeAmount: platformFeeCents,
        model,
      })
      return { ok: true, ticketId: hold.ticketId, sessionId: session.id, url: session.url }
    } catch (err) {
      console.error('[checkout] payment session could not be opened:', err instanceof Error ? err.name : 'error')
      // A session that exists without its reference could never be settled; close it rather
      // than leave a payable page behind.
      if (opened) {
        await gateway
          .expireSession(opened.id, opened.account)
          .catch(() => console.error('[checkout] the unusable session could not be expired'))
      }
      await release()
      return { ok: false, status: 502, error: 'Failed to create checkout session', code: 'CHECKOUT_FAILED' }
    }
  })
}

export type SettlementOutcome = 'confirmed' | 'already_confirmed' | 'refund_needed' | 'ignored'

/**
 * A paid Checkout session (webhook). Under the tier lock:
 *   hold still valid                          → confirm it
 *   hold expired, swept, or cancelled + room  → confirm (or create) the ticket
 *   no room, or the holder already has a seat → `refund_needed` (logged, shown to organizers)
 *   the same payment again                    → no-op
 * Membership and `ticket_confirmed` are written in the same transaction as the confirmation.
 */
export async function settlePaidCheckout(input: {
  /** The hold this checkout was opened for, or null once the expired-hold sweep removed it. */
  ticketId: string | null
  eventId: string
  tierId: string | null
  holderId: string | null
  sessionId: string
  paymentIntentId: string | null
  amountPaidCents: number | null
  currency?: string | null
  platformFeeCents?: number | null
}): Promise<SettlementOutcome> {
  const outcome = await tx(async (t): Promise<SettlementOutcome> => {
    if (input.paymentIntentId) {
      await t`select pg_advisory_xact_lock(hashtextextended(${`payment:${input.paymentIntentId}`}, 0))`
      const refunded = await t`select 1 from refunded_payments where payment_fingerprint = ${createHash('sha256').update(input.paymentIntentId).digest('hex')}`
      if (refunded.length) {
        await t`update tickets set status = 'cancelled', hold_expires_at = null, updated_at = now()
          where id = ${input.ticketId} and event_id = ${input.eventId} and status = 'pending' and (checkout_session_id is null or checkout_session_id = ${input.sessionId})`
        return 'ignored'
      }
    }
    const [ticket] = await t<{ id: string; tier_id: string; user_id: string; status: string; hold_expires_at: string | null; payment_intent_id: string | null; checkout_session_id: string | null }[]>`
      select id, tier_id, user_id, status, hold_expires_at, payment_intent_id, checkout_session_id
      from tickets where id = ${input.ticketId} and event_id = ${input.eventId}
    `
    const tierId = ticket?.tier_id ?? input.tierId
    const holderId = ticket?.user_id ?? input.holderId
    if (!tierId || !holderId) return 'ignored'
    const tier = await lockTier(t, input.eventId, tierId)
    if (!tier) return 'ignored'

    const [current] = ticket
      ? await t<{ status: string; hold_expires_at: string | null; payment_intent_id: string | null; checkout_session_id: string | null; quoted_price_cents: number | null; paid_currency: string | null }[]>`
          select status, hold_expires_at, payment_intent_id, checkout_session_id, quoted_price_cents, paid_currency from tickets where id = ${ticket.id} for update
        `
      : []

    const samePayment = (row: { payment_intent_id: string | null; checkout_session_id: string | null }) =>
      row.checkout_session_id === input.sessionId ||
      (input.paymentIntentId !== null && row.payment_intent_id === input.paymentIntentId)

    /**
     * Point the checkout reference back at whichever ticket this payment ended up owning.
     * The expired-hold sweep clears `ticket_id`, and settlement may then rebuild the seat or
     * take over a newer hold; without this the sale would exist with no ticket attached, which
     * hides it from the organizer's sales list and from the refund path while the revenue page
     * still counts the money. It only ever fills an empty link (see migration 0029).
     */
    const relinkReference = async (ticketId: string) => {
      await t`
        update checkout_references set ticket_id = ${ticketId}
        where session_id = ${input.sessionId} and ticket_id is null
      `
    }

    const confirm = async (id: string) => {
      await t`
        update tickets
        set status = 'confirmed', payment_intent_id = coalesce(${input.paymentIntentId}, payment_intent_id),
            amount_paid_cents = ${input.amountPaidCents},
            platform_fee_cents = coalesce(${input.platformFeeCents ?? null}, platform_fee_cents, 0),
            paid_currency = coalesce(${input.currency ?? null}, paid_currency, ${tier.currency}), payment_confirmed_at = now(), hold_expires_at = null,
            checkout_session_id = ${input.sessionId}, updated_at = now()
        where id = ${id}
      `
      await relinkReference(id)
      await afterConfirmed(t, id)
      return 'confirmed' as const
    }
    const refundNeeded = async (id: string | null) => {
      if (id) {
        await t`
          update tickets
          set status = 'refund_needed', payment_intent_id = ${input.paymentIntentId}, amount_paid_cents = ${input.amountPaidCents},
              payment_confirmed_at = now(), hold_expires_at = null, checkout_session_id = ${input.sessionId}, updated_at = now()
          where id = ${id}
        `
        await relinkReference(id)
      } else {
        const [created] = await t<{ id: string }[]>`
          insert into tickets (event_id, tier_id, user_id, status, payment_intent_id, amount_paid_cents, payment_confirmed_at, checkout_session_id)
          values (${input.eventId}, ${tierId}, ${holderId}, 'refund_needed', ${input.paymentIntentId}, ${input.amountPaidCents}, now(), ${input.sessionId})
          returning id
        `
        await relinkReference(created.id)
      }
      return 'refund_needed' as const
    }

    if (current) {
      // Stripe does not guarantee delivery order. A completed event replayed
      // after a full refund must never restore the cancelled entitlement.
      if (current.status === 'cancelled' && current.payment_intent_id && samePayment(current)) return 'ignored'
      if (current.status === 'confirmed' || current.status === 'checked_in') {
        return samePayment(current) ? 'already_confirmed' : refundNeeded(null)
      }
      if (current.status === 'refund_needed') return samePayment(current) ? 'refund_needed' : refundNeeded(null)
      if (current.quoted_price_cents !== null && (input.amountPaidCents !== current.quoted_price_cents || (input.currency && current.paid_currency !== input.currency))) return refundNeeded(ticket.id)
      if (current.status === 'pending' && current.hold_expires_at && new Date(current.hold_expires_at) > new Date()) {
        return confirm(ticket.id)
      }
    }

    // The hold lapsed, was swept, or was cancelled: the seat must still be free.
    const other = await liveTicketFor(t, tierId, holderId)
    if (other && other.id !== ticket?.id) {
      if (other.status !== 'pending') return refundNeeded(current ? ticket.id : null)
      // The holder has a newer hold for the same tier: this payment takes that seat.
      const otherValid = other.hold_expires_at !== null && new Date(other.hold_expires_at) > new Date()
      if (otherValid || hasRoom(tier, await seatsTaken(t, tierId, other.id))) {
        if (current) await t`update tickets set status = 'cancelled', hold_expires_at = null, updated_at = now() where id = ${ticket.id}`
        return confirm(other.id)
      }
      return refundNeeded(current ? ticket.id : null)
    }
    if (!hasRoom(tier, await seatsTaken(t, tierId, current ? ticket.id : null))) return refundNeeded(current ? ticket.id : null)
    if (current) return confirm(ticket.id)
    const [created] = await t<{ id: string }[]>`
      insert into tickets (event_id, tier_id, user_id, status)
      values (${input.eventId}, ${tierId}, ${holderId}, 'confirmed')
      returning id
    `
    return confirm(created.id)
  })
  if (outcome === 'refund_needed') {
    console.warn('[tickets] refund needed: a paid checkout has no seat (see the event revenue page)')
  }
  return outcome
}

/** Releases a hold whose Checkout session expired or failed (only if it is still that session's hold). */
export async function releaseCheckoutHold(input: { ticketId: string; eventId: string; sessionId: string }): Promise<boolean> {
  const result = await sql`
    delete from tickets
    where id = ${input.ticketId} and event_id = ${input.eventId} and status = 'pending'
      and checkout_session_id = ${input.sessionId}
  `
  return result.count > 0
}

/**
 * Cancels whatever a fully refunded payment intent paid for (including refund-needed rows),
 * and records the refund on that checkout's reference.
 *
 * `deliveredAccount` is the account the `charge.refunded` delivery arrived on. A direct-charge
 * refund is delivered on the merchant's own account, so it must match the account recorded in
 * the reference: a connected merchant refunding one of *their own* payments cannot revoke
 * admission at another gathering. When a refund arrives before the completion that created the
 * ticket, there is nothing to match yet — the fingerprint is still written, so the completion
 * replay is refused when it turns up (this is the out-of-order case, unchanged).
 *
 * The application fee is not reversed by a refund: `application_fee_amount` on the reference
 * stays as the contribution that was collected, and `refunded_at` records that the sale went
 * back. Reversing the fee is a deliberate, separate act in Stripe.
 */
export async function cancelRefundedTicket(
  paymentIntentId: string,
  deliveredAccount: string | null = null,
): Promise<number | 'account_mismatch'> {
  return tx(async (t) => {
    await t`select pg_advisory_xact_lock(hashtextextended(${`payment:${paymentIntentId}`}, 0))`

    // Only the reference that was actually paid counts: a reused hold can carry several, and
    // the superseded ones were never settled.
    const candidates = await t<{ id: string; session_id: string | null; reference_account: string | null; has_reference: boolean }[]>`
      select tk.id, cr.session_id, cr.connected_account_id as reference_account, (cr.id is not null) as has_reference
      from tickets tk
      left join checkout_references cr
        on cr.session_id = tk.checkout_session_id and cr.settled_at is not null
      where tk.payment_intent_id = ${paymentIntentId}
        and tk.status in ('pending', 'confirmed', 'checked_in', 'refund_needed')
    `
    // Every reference we can see must agree with the account the delivery arrived on.
    const mismatch = candidates.some(
      (row) => row.has_reference && (row.reference_account ?? null) !== (deliveredAccount ?? null),
    )
    if (mismatch) {
      console.warn('[tickets] a refund delivery did not match the checkout reference account; ignored')
      return 'account_mismatch' as const
    }

    await t`insert into refunded_payments (payment_fingerprint) values (${createHash('sha256').update(paymentIntentId).digest('hex')}) on conflict do nothing`
    const result = await t`
      update tickets set status = 'cancelled', hold_expires_at = null, updated_at = now()
      where payment_intent_id = ${paymentIntentId} and status in ('pending', 'confirmed', 'checked_in', 'refund_needed')
    `
    await markReferencesRefundedForSessions(t, candidates.map((row) => row.session_id).filter((id): id is string => Boolean(id)))
    return result.count
  })
}

// -----------------------------------------------------------------------------
// Check-in
// -----------------------------------------------------------------------------

export interface CheckinAttendee {
  name: string
  avatarUrl: string | null
  tierName: string | null
  ticketId: string
}

export type CheckinVerification =
  | { ok: true; ticketId: string; attendee: CheckinAttendee }
  | { ok: false; status: number; code: string; error: string; attendee?: CheckinAttendee; checkedInAt?: string | null }

/**
 * Verifies a scanned token for this event: valid signature and TTL, the right event, an
 * existing ticket at this event, and — the binding — the token's DID is the ticket holder's
 * DID. Status problems (pending, cancelled, already checked in) are reported with the
 * attendee's display name so the door can resolve them; never their email.
 */
export async function verifyTicketForCheckin(db: postgres.Sql | Tx, input: { token: string; eventId: string }): Promise<CheckinVerification> {
  const claims = await readTicketToken(input.token)
  if (!claims) return { ok: false, status: 400, code: 'INVALID_TOKEN', error: 'Invalid or expired QR code' }
  if (claims.event_id !== input.eventId) {
    return { ok: false, status: 400, code: 'WRONG_EVENT', error: 'This ticket is for a different event' }
  }

  const rows = await db<{
    id: string; status: string; checked_in_at: string | null; holder_did: string
    display_name: string | null; avatar_url: string | null; handle: string | null; tier_name: string | null
  }[]>`
    select tk.id, tk.status, tk.checked_in_at, a.did as holder_did,
           p.display_name, p.avatar_url, a.handle, tt.name as tier_name
    from tickets tk
    join accounts a on a.id = tk.user_id
    left join profiles p on p.id = tk.user_id
    left join ticket_tiers tt on tt.id = tk.tier_id
    where tk.id = ${claims.ticket_id} and tk.event_id = ${input.eventId}
  `
  const ticket = rows[0]
  if (!ticket) return { ok: false, status: 404, code: 'TICKET_NOT_FOUND', error: 'Ticket not found' }
  if (ticket.holder_did !== claims.did) {
    return { ok: false, status: 400, code: 'WRONG_HOLDER', error: 'This QR code does not belong to the ticket holder' }
  }

  const attendee: CheckinAttendee = {
    name: ticket.display_name?.trim() || ticket.handle || 'Attendee',
    avatarUrl: ticket.avatar_url,
    tierName: ticket.tier_name,
    ticketId: ticket.id,
  }
  if (ticket.status === 'refund_needed') {
    return { ok: false, status: 409, code: 'TICKET_REFUND_NEEDED', error: 'This payment is awaiting a refund; it holds no seat', attendee }
  }
  if (ticket.status === 'cancelled') {
    return { ok: false, status: 409, code: 'TICKET_CANCELLED', error: 'This ticket has been cancelled', attendee }
  }
  if (ticket.status === 'pending') {
    return { ok: false, status: 409, code: 'TICKET_PENDING', error: 'This ticket payment is still pending', attendee }
  }
  if (ticket.status === 'checked_in') {
    return {
      ok: false, status: 409, code: 'ALREADY_CHECKED_IN', error: 'This ticket has already been checked in',
      attendee, checkedInAt: ticket.checked_in_at,
    }
  }
  return { ok: true, ticketId: ticket.id, attendee }
}

/** Marks a confirmed ticket checked in; false if someone else checked it in first. */
export async function checkInTicket(ticketId: string, eventId: string, byAccountId: string): Promise<boolean> {
  const result = await sql`
    update tickets set status = 'checked_in', checked_in_at = now(), checked_in_by = ${byAccountId}, updated_at = now()
    where id = ${ticketId} and event_id = ${eventId} and status = 'confirmed'
  `
  return result.count > 0
}
