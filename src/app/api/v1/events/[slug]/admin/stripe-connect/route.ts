/**
 * Merchant-account onboarding for a gathering (Stripe Connect).
 *
 * GET    → readiness for the event's merchant account
 *          { connected, accountId, chargesEnabled, payoutsEnabled, detailsSubmitted,
 *            requirementsDue, api, platformFallbackAllowed }
 * POST   → create the merchant account if missing, then return a Stripe-hosted onboarding
 *          link { url }. With `?action=dashboard`, return a dashboard login link instead.
 * DELETE → disconnect (owner only): clears events.stripe_account_id and stops paid sales.
 *          The Stripe account itself is never deleted.
 *
 * Accounts are created through `stripeMerchantGateway()`: Accounts v2 with a merchant
 * configuration, a full Stripe dashboard and `fees_collector`/`losses_collector` of `stripe`
 * (falling back to the v1 `controller` equivalent when v2 is not enabled for the platform).
 * Stripe-hosted onboarding collects country, legal identity and payout details directly from
 * the organizer; this application never invents or attests to a business detail.
 *
 * Return/refresh from onboarding land on
 *   /e/[slug]/admin/tickets?stripe=return|refresh
 * There is no server-side callback: the tickets page re-fetches GET here,
 * which is the only trustworthy source of onboarding state.
 *
 * Authorization: owner or admin (DELETE: owner). Every handler answers
 * 503 { error: 'Payments are not configured' } when STRIPE_SECRET_KEY is unset.
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import type { EventRoleName } from '@/types/event'
import { NOT_CONNECTED_STATUS } from '@/lib/payments/merchant'
import { isPlatformChargeFallbackAllowed, isStripeConfigured, stripeMerchantGateway } from '@/lib/payments/stripe'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ADMIN_ROLES: readonly EventRoleName[] = ['owner', 'admin']

function notConfigured() {
  return NextResponse.json({ error: 'Payments are not configured' }, { status: 503 })
}

function stripeErrorResponse(err: unknown, fallback: string) {
  if (err instanceof Stripe.errors.StripeError) {
    console.error('[stripe-connect] Stripe error:', err.type, err.code ?? '')
    return NextResponse.json({ error: err.message, code: err.code ?? null }, { status: 502 })
  }
  console.error('[stripe-connect] error:', err instanceof Error ? err.name : 'error')
  return NextResponse.json({ error: fallback }, { status: 500 })
}

interface ConnectEvent {
  id: string
  slug: string
  name: string
  ticketing_enabled: boolean
  stripe_account_id: string | null
}

async function authorize(request: NextRequest, slug: string, allowedRoles: readonly EventRoleName[]) {
  if (request.method !== 'GET') {
    const crossOrigin = assertSameOrigin(request)
    if (crossOrigin) return { ok: false as const, response: crossOrigin }
  }
  const auth = await requireEventRole(request, slug, allowedRoles)
  if (auth instanceof Response) return { ok: false as const, response: auth }
  const [event] = await sql<ConnectEvent[]>`
    select id, slug, name, ticketing_enabled, stripe_account_id from events where id = ${auth.event.id}
  `
  return { ok: true as const, viewer: auth.viewer, event }
}

function appOrigin(request: NextRequest): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
  if (configured) return configured
  return new URL(request.url).origin
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await authorize(request, slug, ADMIN_ROLES)
  if (!auth.ok) return auth.response

  // A status read is not a failure: answer 200 so the admin page can render the
  // "not configured" state without a console error on every load.
  const gateway = stripeMerchantGateway()
  if (!gateway) {
    return NextResponse.json({ ...NOT_CONNECTED_STATUS, platformFallbackAllowed: false, unavailable: true })
  }

  const platformFallbackAllowed = isPlatformChargeFallbackAllowed()
  const accountId = auth.event.stripe_account_id

  if (!accountId) {
    return NextResponse.json({ ...NOT_CONNECTED_STATUS, platformFallbackAllowed })
  }

  try {
    const status = await gateway.readiness(accountId)
    return NextResponse.json({ ...status, platformFallbackAllowed })
  } catch (err) {
    // The account id is stored but Stripe can't return it (deleted, wrong mode
    // key, etc). Report it as connected-but-unhealthy so the owner can disconnect.
    const message = err instanceof Error ? err.message : 'Unable to retrieve Stripe account'
    console.error('[stripe-connect] merchant readiness could not be read')
    return NextResponse.json({
      ...NOT_CONNECTED_STATUS,
      connected: true,
      accountId,
      platformFallbackAllowed,
      error: message,
    })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await authorize(request, slug, ADMIN_ROLES)
  if (!auth.ok) return auth.response

  const gateway = stripeMerchantGateway()
  if (!gateway || !isStripeConfigured()) return notConfigured()

  const action = request.nextUrl.searchParams.get('action')
  const { event, viewer } = auth

  // --- Stripe-hosted dashboard login link -------------------------------
  if (action === 'dashboard') {
    if (!event.stripe_account_id) {
      return NextResponse.json({ error: 'No Stripe account is connected to this event' }, { status: 400 })
    }
    try {
      const url = await gateway.dashboardLink(event.stripe_account_id)
      return NextResponse.json({ url })
    } catch (err) {
      return stripeErrorResponse(err, 'Failed to create dashboard link')
    }
  }

  if (action && action !== 'onboard') {
    return NextResponse.json({ error: `Unknown action '${action}'` }, { status: 400 })
  }

  // --- Create the merchant account if needed, then an onboarding link ----
  let accountId = event.stripe_account_id

  if (!accountId) {
    try {
      const created = await gateway.createAccount({
        eventId: event.id,
        eventSlug: event.slug,
        eventName: event.name,
        email: viewer.email,
      })
      accountId = created.accountId
      console.info(`[stripe-connect] created a merchant account via Accounts ${created.api}`)
    } catch (err) {
      return stripeErrorResponse(err, 'Failed to create Stripe account')
    }

    try {
      // Only fill an empty slot: two concurrent "Connect" clicks must not orphan an account.
      const saved = await sql<{ stripe_account_id: string }[]>`
        update events set stripe_account_id = ${accountId}, updated_at = now()
        where id = ${event.id} and stripe_account_id is null
        returning stripe_account_id
      `
      if (saved.length === 0) {
        const [current] = await sql<{ stripe_account_id: string | null }[]>`select stripe_account_id from events where id = ${event.id}`
        accountId = current?.stripe_account_id ?? accountId
      }
    } catch {
      // The Stripe account now exists but we failed to persist its id; surface
      // it so an operator can investigate; retrying uses the same idempotency key.
      console.error('[stripe-connect] failed to persist the connected account id')
      return NextResponse.json(
        { error: 'Stripe account created but could not be saved', accountId },
        { status: 500 },
      )
    }
  }

  const origin = appOrigin(request)
  const base = `${origin}/e/${encodeURIComponent(event.slug)}/admin/tickets`

  try {
    const url = await gateway.onboardingLink({
      accountId,
      refreshUrl: `${base}?stripe=refresh`,
      returnUrl: `${base}?stripe=return`,
    })
    return NextResponse.json({ url, accountId })
  } catch (err) {
    return stripeErrorResponse(err, 'Failed to create onboarding link')
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await authorize(request, slug, ['owner'])
  if (!auth.ok) return auth.response

  // Disconnecting only touches our database, so it works even without keys;
  // but we still gate it so the UI behaves consistently when Stripe is off.
  if (!isStripeConfigured()) return notConfigured()

  const { event } = auth
  if (!event.stripe_account_id) {
    return NextResponse.json({ error: 'No Stripe account is connected to this event' }, { status: 400 })
  }

  // Admission rules survive a payout disconnection. Paid checkout fails closed: an open
  // checkout whose reference names this account can no longer be settled, because the
  // reference and the event row no longer agree.
  const [updated] = await sql<{ ticketing_enabled: boolean; stripe_account_id: string | null }[]>`
    update events
    set stripe_account_id = null,
        updated_at = now()
    where id = ${event.id}
    returning ticketing_enabled, stripe_account_id
  `
  if (!updated) {
    return NextResponse.json({ error: 'Failed to disconnect' }, { status: 500 })
  }

  return NextResponse.json({
    ...NOT_CONNECTED_STATUS,
    platformFallbackAllowed: isPlatformChargeFallbackAllowed(),
    ticketing_enabled: updated.ticketing_enabled,
    disconnected_account_id: event.stripe_account_id,
  })
}
