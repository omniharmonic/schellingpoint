/**
 * One ticket tier (owner or admin).
 *
 *   PATCH  { any tier field } → { tier }
 *   DELETE → { deleted: true } · 409 when tickets exist for the tier (deactivate it instead)
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { pgErrorCode, sql } from '@/lib/db'
import { jsonError, TICKET_ADMIN_ROLES } from '@/lib/tickets'
import { validateTier, type TierInput } from '@/lib/tickets/tiers'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const COLUMNS: ReadonlyArray<keyof TierInput> = [
  'name', 'description', 'price_cents', 'currency', 'quantity_total', 'sale_starts_at', 'sale_ends_at',
  'is_active', 'allows_proposals', 'allows_voting', 'vote_credits_override', 'display_order',
]

type Params = { params: Promise<{ slug: string; tierId: string }> }

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug, tierId } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth
  if (!UUID.test(tierId)) return jsonError(404, 'Ticket tier not found')

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  const v = validateTier(raw, true)
  if (!v.ok) return jsonError(400, v.error, { field: v.field })
  const changes = Object.fromEntries(COLUMNS.filter((c) => v.value[c] !== undefined).map((c) => [c, v.value[c]]))
  if (Object.keys(changes).length === 0) return jsonError(400, 'No updates provided')

  const [current] = await sql<{ quantity_sold: number; sale_starts_at: string | null; sale_ends_at: string | null }[]>`
    select quantity_sold, sale_starts_at, sale_ends_at from ticket_tiers where id = ${tierId} and event_id = ${auth.event.id}
  `
  if (!current) return jsonError(404, 'Ticket tier not found')
  if (typeof changes.quantity_total === 'number' && changes.quantity_total < current.quantity_sold) {
    return jsonError(400, `Quantity cannot be below the ${current.quantity_sold} tickets already sold`, { field: 'quantity_total' })
  }
  const starts = (changes.sale_starts_at as string | null | undefined) ?? (changes.sale_starts_at === null ? null : current.sale_starts_at)
  const ends = (changes.sale_ends_at as string | null | undefined) ?? (changes.sale_ends_at === null ? null : current.sale_ends_at)
  if (starts && ends && new Date(ends) <= new Date(starts)) {
    return jsonError(400, 'Sales must end after they start', { field: 'sale_ends_at' })
  }

  const [tier] = await sql`
    update ticket_tiers set ${sql(changes, ...Object.keys(changes))}, updated_at = now()
    where id = ${tierId} and event_id = ${auth.event.id}
    returning id, name, description, price_cents, currency, quantity_total, quantity_sold, sale_starts_at, sale_ends_at,
              is_active, display_order, allows_proposals, allows_voting, vote_credits_override
  `
  if (!tier) return jsonError(404, 'Ticket tier not found')
  return Response.json({ tier }, { headers: NO_STORE })
}

export async function DELETE(request: Request, { params }: Params): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug, tierId } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth
  if (!UUID.test(tierId)) return jsonError(404, 'Ticket tier not found')

  try {
    const result = await sql`delete from ticket_tiers where id = ${tierId} and event_id = ${auth.event.id}`
    if (result.count === 0) return jsonError(404, 'Ticket tier not found')
  } catch (err) {
    if (pgErrorCode(err) === '23503') {
      return jsonError(409, 'Tickets exist for this tier. Deactivate it instead.', { code: 'TIER_HAS_TICKETS' })
    }
    throw err
  }
  return Response.json({ deleted: true }, { headers: NO_STORE })
}
