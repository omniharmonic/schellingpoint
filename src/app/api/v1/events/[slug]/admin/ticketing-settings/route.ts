/**
 * Admin ticketing settings (owner or admin).
 *
 *   GET  → { ticketing_enabled, platform_fee_percent, stripe_account_id,
 *            platform_stripe_configured, webhook_configured,
 *            payments_ready, payments_blocked_code, payments_blocked_reason }
 *   POST { ticketing_enabled?: boolean, platform_fee_percent?: number } → same shape
 *
 * Turning ticket sales *on* while the gathering has a paid tier is refused (409) until the
 * organizer's merchant account can actually take the charge and receive the payout. The
 * refusal names the reason, so the page can say why rather than just greying a button: the
 * browser-side check is a courtesy, this is the rule.
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { validPlatformFeePercent } from '@/lib/payments/format'
import { paidSalesBlock, type PaidSalesBlock } from '@/lib/payments/merchant'
import { cachedMerchantStatus } from '@/lib/payments/merchant-status'
import { isPaymentsActivated, isPlatformChargeFallbackAllowed, readMerchantReadiness, stripeMerchantGateway } from '@/lib/payments/stripe'
import { jsonError, TICKET_ADMIN_ROLES } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

interface SettingsRow {
  ticketing_enabled: boolean
  stripe_account_id: string | null
  platform_fee_percent: number
}

/** Does this gathering sell anything that costs money? Free-only ticketing never needs Stripe. */
async function hasPaidTiers(eventId: string): Promise<boolean> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from ticket_tiers where event_id = ${eventId} and price_cents > 0 and is_active
  `
  return row.n > 0
}

async function paymentsBlock(row: SettingsRow, eventId: string): Promise<PaidSalesBlock | null> {
  const cached = await cachedMerchantStatus(eventId)
  const readiness = await readMerchantReadiness(stripeMerchantGateway(), row.stripe_account_id, cached)
  return paidSalesBlock({
    hasPaidTiers: await hasPaidTiers(eventId),
    stripeConfigured: isPaymentsActivated(),
    readiness,
    platformFallbackAllowed: isPlatformChargeFallbackAllowed(),
    pausedReason: cached?.pausedReason ?? null,
  })
}

function settingsBody(row: SettingsRow, blocked: PaidSalesBlock | null) {
  return {
    ticketing_enabled: row.ticketing_enabled,
    platform_fee_percent: row.platform_fee_percent,
    stripe_account_id: row.stripe_account_id,
    platform_stripe_configured: Boolean(process.env.STRIPE_SECRET_KEY),
    webhook_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    payments_ready: blocked === null,
    payments_blocked_code: blocked?.code ?? null,
    payments_blocked_reason: blocked?.reason ?? null,
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth
  const [row] = await sql<SettingsRow[]>`
    select ticketing_enabled, stripe_account_id, platform_fee_percent from events where id = ${auth.event.id}
  `
  return Response.json(settingsBody(row, await paymentsBlock(row, auth.event.id)), { headers: NO_STORE })
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

  const [before] = await sql<SettingsRow[]>`
    select ticketing_enabled, stripe_account_id, platform_fee_percent from events where id = ${auth.event.id}
  `
  // Readiness gates switching sales on, never switching them off: an organizer whose account
  // has been restricted must still be able to stop selling.
  const blockedBefore = await paymentsBlock(before, auth.event.id)
  if (enabled === true && !before.ticketing_enabled && blockedBefore) {
    return jsonError(409, blockedBefore.reason, { code: blockedBefore.code, field: 'ticketing_enabled' })
  }

  const [row] = await sql<SettingsRow[]>`
    update events
    set ticketing_enabled = ${setEnabled ? sql`${enabled}` : sql`ticketing_enabled`},
        platform_fee_percent = ${setFee ? sql`${fee}` : sql`platform_fee_percent`},
        updated_at = now()
    where id = ${auth.event.id}
    returning ticketing_enabled, stripe_account_id, platform_fee_percent
  `
  return Response.json(settingsBody(row, blockedBefore), { headers: NO_STORE })
}
