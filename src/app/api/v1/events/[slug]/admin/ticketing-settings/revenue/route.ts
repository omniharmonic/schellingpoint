/**
 * Revenue summary for organizers (owner or admin). Aggregates only — no per-ticket rows,
 * no holder identities.
 *
 *   GET → { currency, totalRevenue, platformFees, netRevenue, processingFeesKnown,
 *           contributionSource, totalTickets, confirmedTickets, pendingTickets, checkedIn,
 *           refundNeeded: { count, amountCents }, tierBreakdown[],
 *           dailySales[] (last 30 days, UTC) }
 *
 * Under direct charges the organizer is the merchant of record: the card money lands on their
 * Stripe account, Stripe takes its processing fees from that account, and the platform's only
 * revenue is the application fee it collected per sale. So:
 *
 *   totalRevenue   gross ticket sales, as charged.
 *   platformFees   the contribution actually collected — the sum of
 *                  `checkout_references.application_fee_amount` for settled, unrefunded
 *                  checkouts. Net of nothing else. (`contributionSource: 'tickets'` marks a
 *                  gathering old enough to have no references, where the per-ticket snapshot
 *                  is used instead.)
 *   netRevenue     totalRevenue − platformFees. `processingFeesKnown` is false because Stripe
 *                  reports its processing fees on the organizer's own account, which this
 *                  application does not read: the figure is *before* Stripe processing fees
 *                  and the page must say so.
 *
 * `unmatchedPayments` are deliveries Stripe confirmed as paid that this application refused to
 * act on — the gathering changed its Stripe account mid-checkout, the amount did not match the
 * quote, or the session was not one we opened. Somebody was charged and got no ticket, so it is
 * shown here rather than left in a log. Where the payment was provably ours it was already
 * refunded automatically; the rest need the organizer to look.
 *
 * `pendingTickets` counts unexpired checkout holds only. `refundNeeded` counts payments that
 * arrived without a seat (the hold lapsed and the tier filled); the organizer refunds them in
 * Stripe — in their own account's context — after which the webhook cancels them. A refund
 * does not return the contribution already collected.
 */
import { requireEventRole } from '@/lib/auth/viewer'
import { rejectedDeliveriesForEvent } from '@/lib/payments/deliveries'
import { sql } from '@/lib/db'
import { TICKET_ADMIN_ROLES } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth
  const eventId = auth.event.id

  const [totals] = await sql<{ total: number; confirmed: number; pending: number; checked_in: number; refund_count: number; refund_cents: number }[]>`
    select count(*) filter (where status <> 'pending' or hold_expires_at > now())::int as total,
           count(*) filter (where status in ('confirmed', 'checked_in'))::int as confirmed,
           count(*) filter (where status = 'pending' and hold_expires_at > now())::int as pending,
           count(*) filter (where status = 'checked_in')::int as checked_in,
           count(*) filter (where status = 'refund_needed')::int as refund_count,
           coalesce(sum(amount_paid_cents) filter (where status = 'refund_needed'), 0)::int as refund_cents
    from tickets where event_id = ${eventId}
  `

  // Snapshot amounts preserve the contribution charged when each checkout opened.
  const [money] = await sql<{ revenue: number; fees: number }[]>`
    select coalesce(sum(amount_paid_cents), 0)::int as revenue,
      coalesce(sum(platform_fee_cents), 0)::int as fees
    from tickets where event_id = ${eventId} and status in ('confirmed', 'checked_in')
  `
  // Platform revenue is the application fee actually collected, read from the immutable
  // checkout references rather than from a per-ticket snapshot that a later edit could drift
  // away from. A refunded sale drops out; its fee was not returned, but the sale was.
  const [collected] = await sql<{ references: number; fees: number }[]>`
    select count(*)::int as references,
           coalesce(sum(application_fee_amount) filter (where settled_at is not null and refunded_at is null), 0)::int as fees
    from checkout_references where event_id = ${eventId}
  `
  const totalRevenue = money.revenue
  const contributionSource: 'references' | 'tickets' = collected.references > 0 ? 'references' : 'tickets'
  const platformFees = contributionSource === 'references' ? collected.fees : money.fees

  const tierBreakdown = await sql<{ tierId: string; tierName: string; sold: number; revenue: number; capacity: number | null; currency: string }[]>`
    select tt.id as "tierId", tt.name as "tierName", tt.quantity_total as capacity, tt.currency,
           count(tk.id) filter (where tk.status in ('confirmed', 'checked_in'))::int as sold,
           coalesce(sum(tk.amount_paid_cents) filter (where tk.status in ('confirmed', 'checked_in')), 0)::int as revenue
    from ticket_tiers tt
    left join tickets tk on tk.tier_id = tt.id
    where tt.event_id = ${eventId}
    group by tt.id
    order by tt.display_order, tt.created_at
  `

  const unmatched = await rejectedDeliveriesForEvent(eventId)

  const dailySales = await sql<{ date: string; tickets: number; revenue: number }[]>`
    select to_char(d.day, 'YYYY-MM-DD') as date,
           count(tk.id)::int as tickets,
           coalesce(sum(tk.amount_paid_cents), 0)::int as revenue
    from generate_series((now() at time zone 'utc')::date - 30, (now() at time zone 'utc')::date, interval '1 day') as d(day)
    left join tickets tk
      on tk.event_id = ${eventId}
     and tk.status in ('confirmed', 'checked_in')
     and (coalesce(tk.payment_confirmed_at, tk.created_at) at time zone 'utc')::date = d.day::date
    group by d.day
    order by d.day
  `

  return Response.json(
    {
      currency: tierBreakdown[0]?.currency ?? 'usd',
      totalRevenue,
      platformFees,
      netRevenue: totalRevenue - platformFees,
      // Stripe's processing fees are charged to the organizer's own account and are not
      // readable from here, so the net figure is explicitly "before Stripe processing fees".
      processingFeesKnown: false,
      contributionSource,
      totalTickets: totals.total,
      confirmedTickets: totals.confirmed,
      pendingTickets: totals.pending,
      checkedIn: totals.checked_in,
      refundNeeded: { count: totals.refund_count, amountCents: totals.refund_cents },
      unmatchedPayments: unmatched.map((row) => ({
        id: row.id,
        reason: row.rejection,
        sessionId: row.session_id,
        receivedAt: row.received_at,
      })),
      tierBreakdown: tierBreakdown.map(({ currency: _c, ...t }) => t),
      dailySales,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
