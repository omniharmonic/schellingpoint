/**
 * Revenue summary for organizers (owner or admin). Aggregates only — no per-ticket rows,
 * no holder identities.
 *
 *   GET → { currency, totalRevenue, platformFees, netRevenue, totalTickets, confirmedTickets,
 *           pendingTickets, checkedIn, refundNeeded: { count, amountCents }, tierBreakdown[],
 *           dailySales[] (last 30 days, UTC) }
 *
 * `pendingTickets` counts unexpired checkout holds only. `refundNeeded` counts payments that
 * arrived without a seat (the hold lapsed and the tier filled); the organizer refunds them in
 * Stripe, after which the webhook cancels them.
 */
import { requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { calculatePlatformFee } from '@/lib/payments/format'
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

  // Fees are per ticket (5% + 50c), so they are summed per distinct paid amount.
  const amounts = await sql<{ amount: number; n: number }[]>`
    select coalesce(amount_paid_cents, 0) as amount, count(*)::int as n
    from tickets
    where event_id = ${eventId} and status in ('confirmed', 'checked_in')
    group by 1
  `
  const totalRevenue = amounts.reduce((sum, a) => sum + a.amount * a.n, 0)
  const platformFees = amounts.reduce((sum, a) => sum + calculatePlatformFee(a.amount) * a.n, 0)

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
      totalTickets: totals.total,
      confirmedTickets: totals.confirmed,
      pendingTickets: totals.pending,
      checkedIn: totals.checked_in,
      refundNeeded: { count: totals.refund_count, amountCents: totals.refund_cents },
      tierBreakdown: tierBreakdown.map(({ currency: _c, ...t }) => t),
      dailySales,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
