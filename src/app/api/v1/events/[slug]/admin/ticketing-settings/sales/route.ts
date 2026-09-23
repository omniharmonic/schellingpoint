/**
 * Paid sales for this gathering, for the organizers who may refund them (owner or admin).
 *
 *   GET → { currency, sales: Sale[] }
 *
 * One row per settled paid checkout, newest first, with what the organizer needs to decide on
 * a refund: what was charged, what the contribution was, what has already gone back and
 * whether the holder still has admission. The attendee's display name is included because
 * organizers already see it at the door; their email, DID and handle are not.
 */
import { requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { TICKET_ADMIN_ROLES } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

interface SaleRow {
  ticketId: string
  status: string
  attendee: string | null
  handle: string | null
  tierName: string | null
  amountCents: number
  currency: string
  contributionCents: number
  refundedCents: number
  contributionRefundedCents: number
  settledAt: string | null
  refundable: boolean
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth

  const sales = await sql<SaleRow[]>`
    select tk.id as "ticketId", tk.status,
           p.display_name as attendee, a.handle,
           tt.name as "tierName",
           cr.unit_amount as "amountCents", cr.currency,
           cr.application_fee_amount as "contributionCents",
           cr.refunded_amount as "refundedCents",
           cr.application_fee_refunded_amount as "contributionRefundedCents",
           cr.settled_at as "settledAt",
           (cr.settled_at is not null and cr.refunded_amount < cr.unit_amount and tk.payment_intent_id is not null) as refundable
    from checkout_references cr
    join tickets tk on tk.id = cr.ticket_id
    join accounts a on a.id = tk.user_id
    left join profiles p on p.id = tk.user_id
    left join ticket_tiers tt on tt.id = tk.tier_id
    where cr.event_id = ${auth.event.id} and cr.settled_at is not null
    order by cr.settled_at desc
    limit 500
  `

  return Response.json(
    { currency: sales[0]?.currency ?? 'usd', sales },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
