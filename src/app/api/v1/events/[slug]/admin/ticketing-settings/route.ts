/**
 * Admin ticketing settings (owner or admin).
 *
 *   GET  → { ticketing_enabled, stripe_account_id, platform_stripe_configured, webhook_configured }
 *   POST { ticketing_enabled?: boolean, platform_fee_percent?: number } → same shape
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { validPlatformFeePercent } from '@/lib/payments/format'
import { jsonError, TICKET_ADMIN_ROLES } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function settingsBody(row: { ticketing_enabled: boolean; stripe_account_id: string | null; platform_fee_percent: number }) {
  return {
    ticketing_enabled: row.ticketing_enabled,
    platform_fee_percent: row.platform_fee_percent,
    stripe_account_id: row.stripe_account_id,
    platform_stripe_configured: Boolean(process.env.STRIPE_SECRET_KEY),
    webhook_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth
  const [row] = await sql<{ ticketing_enabled: boolean; stripe_account_id: string | null; platform_fee_percent: number }[]>`
    select ticketing_enabled, stripe_account_id, platform_fee_percent from events where id = ${auth.event.id}
  `
  return Response.json(settingsBody(row), { headers: NO_STORE })
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth

  let body: { ticketing_enabled?: unknown; stripe_account_id?: unknown; platform_fee_percent?: unknown }
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError(400, 'Expected a settings object')
  const setEnabled = typeof body.ticketing_enabled === 'boolean'
  // Account association is managed by the audited Connect flow, never a pasted account ID.
  if (body.stripe_account_id !== undefined) return jsonError(400, 'Use Stripe Connect to manage the payout account')
  const setFee = body.platform_fee_percent !== undefined
  if (setFee && !validPlatformFeePercent(body.platform_fee_percent)) return jsonError(400, 'Choose a contribution from 1% to 100%, with up to two decimal places', { field: 'platform_fee_percent' })
  if (!setEnabled && !setFee) return jsonError(400, 'No updates provided')
  const enabled = setEnabled ? (body.ticketing_enabled as boolean) : null
  const fee = setFee ? body.platform_fee_percent as number : null
  const [row] = await sql<{ ticketing_enabled: boolean; stripe_account_id: string | null; platform_fee_percent: number }[]>`
    update events
    set ticketing_enabled = ${setEnabled ? sql`${enabled}` : sql`ticketing_enabled`},
        platform_fee_percent = ${setFee ? sql`${fee}` : sql`platform_fee_percent`},
        updated_at = now()
    where id = ${auth.event.id}
    returning ticketing_enabled, stripe_account_id, platform_fee_percent
  `
  return Response.json(settingsBody(row), { headers: NO_STORE })
}
