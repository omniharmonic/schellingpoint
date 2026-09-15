/**
 * Ticket tiers on sale, and the signed-in viewer's own tickets for this event.
 *
 *   GET /api/v1/events/[slug]/tickets
 *   → { ticketingEnabled, tiers: Tier[], tickets: { id, tier_id, status, created_at }[] }
 *   Tier.quantity_reserved = confirmed tickets + unexpired checkout holds (what capacity checks use).
 *
 * Draft and private events answer 404 to non-members.
 */
import { sql } from '@/lib/db'
import { loadTicketEvent } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const loaded = await loadTicketEvent(request, slug)
  if (loaded instanceof Response) return loaded
  const { event, viewer } = loaded

  const tiers = await sql`
    select tt.id, tt.name, tt.description, tt.price_cents, tt.currency, tt.quantity_total, tt.quantity_sold,
           (select count(*)::int from tickets tk
             where tk.tier_id = tt.id
               and (tk.status in ('confirmed', 'checked_in') or (tk.status = 'pending' and tk.hold_expires_at > now()))
           ) as quantity_reserved,
           tt.sale_starts_at, tt.sale_ends_at, tt.is_active, tt.allows_proposals, tt.allows_voting, tt.display_order
    from ticket_tiers tt
    where tt.event_id = ${event.id} and tt.is_active
    order by tt.display_order, tt.created_at
  `
  const tickets = viewer
    ? await sql`
        select id, tier_id, status, created_at
        from tickets
        where event_id = ${event.id} and user_id = ${viewer.accountId}
          and (status in ('confirmed', 'checked_in', 'refund_needed') or (status = 'pending' and hold_expires_at > now()))
        order by created_at
      `
    : []

  return Response.json(
    { ticketingEnabled: event.ticketing_enabled, tiers, tickets },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
