/**
 * Ticket tiers for organizers (owner or admin): every tier, active or not.
 *
 *   GET  → { tiers: Tier[] }
 *   POST { name, description?, price_cents, currency?, quantity_total?, sale_starts_at?, sale_ends_at?,
 *          is_active?, allows_proposals?, allows_voting?, vote_credits_override?, display_order? }
 *        → 201 { tier }
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { sql, dbErrorResponse } from '@/lib/db'
import { jsonError, TICKET_ADMIN_ROLES } from '@/lib/tickets'
import { validateTier } from '@/lib/tickets/tiers'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth
  const tiers = await sql`
    select id, name, description, price_cents, currency, quantity_total, quantity_sold, sale_starts_at, sale_ends_at,
           is_active, display_order, allows_proposals, allows_voting, vote_credits_override
    from ticket_tiers where event_id = ${auth.event.id}
    order by display_order, created_at
  `
  return Response.json({ tiers }, { headers: NO_STORE })
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  const v = validateTier(raw, false)
  if (!v.ok) return jsonError(400, v.error, { field: v.field })
  const t = v.value

  try {
    const [tier] = await sql`
      insert into ticket_tiers (
        event_id, name, description, price_cents, currency, quantity_total, sale_starts_at, sale_ends_at,
        is_active, allows_proposals, allows_voting, vote_credits_override, display_order
      ) values (
        ${auth.event.id}, ${t.name!}, ${t.description ?? null}, ${t.price_cents ?? 0}, ${t.currency ?? 'usd'},
        ${t.quantity_total ?? null}, ${t.sale_starts_at ?? null}, ${t.sale_ends_at ?? null},
        ${t.is_active ?? true}, ${t.allows_proposals ?? true}, ${t.allows_voting ?? true},
        ${t.vote_credits_override ?? null},
        ${t.display_order ?? sql`(select coalesce(max(display_order) + 1, 0) from ticket_tiers where event_id = ${auth.event.id})`}
      )
      returning id, name, description, price_cents, currency, quantity_total, quantity_sold, sale_starts_at, sale_ends_at,
                is_active, display_order, allows_proposals, allows_voting, vote_credits_override
    `
    return Response.json({ tier }, { status: 201, headers: NO_STORE })
  } catch (error) {
    const response = dbErrorResponse(error)
    if (response) return response
    throw error
  }
}
