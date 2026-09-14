/**
 * Stripe Connect (Express) onboarding for an event.
 *
 * GET    → connection status for the event's connected account
 *          { connected, accountId, chargesEnabled, payoutsEnabled,
 *            detailsSubmitted, requirementsDue, platformFallbackAllowed }
 * POST   → create the Express account if missing, then return an onboarding
 *          link { url }. With `?action=dashboard`, return an Express Dashboard
 *          login link instead.
 * DELETE → disconnect (owner only): clears events.stripe_account_id and turns
 *          ticketing off unless platform-account charging is explicitly allowed.
 *          The Stripe account itself is never deleted.
 *
 * Return/refresh from Stripe-hosted onboarding land on
 *   /e/[slug]/admin/tickets?stripe=return|refresh
 * There is no server-side callback: the tickets page re-fetches GET here,
 * which is the only trustworthy source of onboarding state.
 *
 * Authorization: owner or admin (DELETE: owner). Every handler answers
 * 503 { error: 'Payments are not configured' } when STRIPE_SECRET_KEY is unset.
 */

import { NextRequest, NextResponse } from 'next/server'
import Stripe from 'stripe'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import {
  NOT_CONNECTED_STATUS,
  createConnectAccount,
  createDashboardLoginLink,
  createOnboardingLink,
  getConnectAccountStatus,
  isPlatformChargeFallbackAllowed,
  isStripeConfigured,
} from '@/lib/payments/stripe'

export const runtime = 'nodejs'

const ADMIN_ROLES = ['owner', 'admin']

function notConfigured() {
  return NextResponse.json({ error: 'Payments are not configured' }, { status: 503 })
}

function stripeErrorResponse(err: unknown, fallback: string) {
  if (err instanceof Stripe.errors.StripeError) {
    console.error('Stripe Connect error:', err.type, err.code, err.message)
    return NextResponse.json({ error: err.message, code: err.code ?? null }, { status: 502 })
  }
  console.error('Stripe Connect error:', err)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

async function authorize(request: NextRequest, slug: string, allowedRoles: string[]) {
  const user = await getUserFromRequest(request)
  if (!user) {
    return { ok: false as const, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const supabase = await createAdminClient()
  const { data: event } = await supabase
    .from('events')
    .select('id, slug, name, ticketing_enabled, stripe_account_id')
    .eq('slug', slug)
    .maybeSingle()

  if (!event) {
    return { ok: false as const, response: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  }

  const { data: membership } = await supabase
    .from('event_members')
    .select('role')
    .eq('event_id', event.id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || !allowedRoles.includes(membership.role)) {
    return { ok: false as const, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  return {
    ok: true as const,
    user,
    event: event as {
      id: string
      slug: string
      name: string
      ticketing_enabled: boolean
      stripe_account_id: string | null
    },
    supabase,
  }
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
  if (!isStripeConfigured()) {
    return NextResponse.json({ ...NOT_CONNECTED_STATUS, platformFallbackAllowed: false, unavailable: true })
  }

  const platformFallbackAllowed = isPlatformChargeFallbackAllowed()
  const accountId = auth.event.stripe_account_id

  if (!accountId) {
    return NextResponse.json({ ...NOT_CONNECTED_STATUS, platformFallbackAllowed })
  }

  try {
    const status = await getConnectAccountStatus(accountId)
    return NextResponse.json({ ...status, platformFallbackAllowed })
  } catch (err) {
    // The account id is stored but Stripe can't return it (deleted, wrong mode
    // key, etc). Report it as connected-but-unhealthy so the owner can disconnect.
    const message = err instanceof Error ? err.message : 'Unable to retrieve Stripe account'
    console.error('Stripe accounts.retrieve failed for', accountId, message)
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

  if (!isStripeConfigured()) return notConfigured()

  const action = request.nextUrl.searchParams.get('action')
  const { event, supabase, user } = auth

  // --- Express Dashboard login link -------------------------------------
  if (action === 'dashboard') {
    if (!event.stripe_account_id) {
      return NextResponse.json({ error: 'No Stripe account is connected to this event' }, { status: 400 })
    }
    try {
      const url = await createDashboardLoginLink(event.stripe_account_id)
      return NextResponse.json({ url })
    } catch (err) {
      return stripeErrorResponse(err, 'Failed to create dashboard link')
    }
  }

  if (action && action !== 'onboard') {
    return NextResponse.json({ error: `Unknown action '${action}'` }, { status: 400 })
  }

  // --- Create account if needed, then onboarding link -------------------
  let accountId = event.stripe_account_id

  if (!accountId) {
    try {
      const account = await createConnectAccount({
        eventId: event.id,
        eventSlug: event.slug,
        eventName: event.name,
        email: user.email,
      })
      accountId = account.id
    } catch (err) {
      return stripeErrorResponse(err, 'Failed to create Stripe account')
    }

    const { error: updateError } = await supabase
      .from('events')
      .update({ stripe_account_id: accountId })
      .eq('id', event.id)

    if (updateError) {
      // The Stripe account now exists but we failed to persist its id; surface
      // it so an operator can attach it manually via ticketing-settings.
      console.error('Failed to persist stripe_account_id', accountId, updateError)
      return NextResponse.json(
        { error: 'Stripe account created but could not be saved', accountId },
        { status: 500 },
      )
    }
  }

  const origin = appOrigin(request)
  const base = `${origin}/e/${encodeURIComponent(event.slug)}/admin/tickets`

  try {
    const url = await createOnboardingLink({
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

  const { event, supabase } = auth
  if (!event.stripe_account_id) {
    return NextResponse.json({ error: 'No Stripe account is connected to this event' }, { status: 400 })
  }

  const updates: Record<string, unknown> = { stripe_account_id: null }
  // Without a connected account, paid checkout can only proceed on the
  // platform account; unless that fallback is explicitly enabled, turn
  // ticketing off so nobody hits a broken checkout.
  if (!isPlatformChargeFallbackAllowed()) {
    updates.ticketing_enabled = false
  }

  const { data: updated, error } = await supabase
    .from('events')
    .update(updates)
    .eq('id', event.id)
    .select('ticketing_enabled, stripe_account_id')
    .single()

  if (error || !updated) {
    return NextResponse.json({ error: error?.message || 'Failed to disconnect' }, { status: 500 })
  }

  return NextResponse.json({
    ...NOT_CONNECTED_STATUS,
    platformFallbackAllowed: isPlatformChargeFallbackAllowed(),
    ticketing_enabled: updated.ticketing_enabled,
    disconnected_account_id: event.stripe_account_id,
  })
}
