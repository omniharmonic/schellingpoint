import 'server-only'
import { sql, tx } from '@/lib/db'
import { notify } from '@/lib/notifications'
import type { MerchantReadiness } from './merchant'

/**
 * What Stripe last told us about a gathering's merchant account, and what happens when it
 * stops being usable.
 *
 * Until `account.updated` is handled, a platform only discovers a suspended merchant when
 * somebody tries to buy a ticket. Stripe sends the change; we record it on the gathering
 * (`events.stripe_charges_enabled` / `stripe_payouts_enabled`) and, when a capability is
 * lost, set `paid_sales_paused_at` and tell the owners and admins once.
 *
 * What a pause does *not* do: it never flips `ticketing_enabled` (free tickets are not
 * Stripe's business) and it never revokes admission somebody already paid for. It refuses
 * *new* paid checkouts, which is the only thing that would otherwise fail at the card form.
 */

export interface MerchantCapabilities {
  accountId: string
  chargesEnabled: boolean
  payoutsEnabled: boolean
}

export interface CachedMerchantStatus {
  chargesEnabled: boolean | null
  payoutsEnabled: boolean | null
  pausedAt: string | null
  pausedReason: string | null
}

/** The cached capability status for one gathering, as `readMerchantReadiness` falls back to. */
export async function cachedMerchantStatus(eventId: string): Promise<CachedMerchantStatus | null> {
  const [row] = await sql<{
    stripe_charges_enabled: boolean | null
    stripe_payouts_enabled: boolean | null
    paid_sales_paused_at: string | null
    paid_sales_paused_reason: string | null
  }[]>`
    select stripe_charges_enabled, stripe_payouts_enabled, paid_sales_paused_at, paid_sales_paused_reason
    from events where id = ${eventId}
  `
  if (!row) return null
  return {
    chargesEnabled: row.stripe_charges_enabled,
    payoutsEnabled: row.stripe_payouts_enabled,
    pausedAt: row.paid_sales_paused_at,
    pausedReason: row.paid_sales_paused_reason,
  }
}

export interface AccountUpdateResult {
  /** Gatherings connected to this merchant account. */
  events: number
  paused: number
  resumed: number
}

function pauseReason(capabilities: MerchantCapabilities): string | null {
  if (!capabilities.chargesEnabled) return 'Stripe has suspended card payments on this account.'
  if (!capabilities.payoutsEnabled) return 'Stripe has suspended payouts on this account.'
  return null
}

/**
 * Apply an `account.updated` delivery. Idempotent: re-applying the same capabilities pauses
 * or resumes nothing a second time, and notifies nobody a second time.
 */
export async function applyMerchantCapabilities(capabilities: MerchantCapabilities): Promise<AccountUpdateResult> {
  const reason = pauseReason(capabilities)
  return tx(async (t) => {
    const rows = await t<{ id: string; slug: string; name: string; paid_sales_paused_at: string | null }[]>`
      select id, slug, name, paid_sales_paused_at from events
      where stripe_account_id = ${capabilities.accountId}
      for update
    `
    if (rows.length === 0) return { events: 0, paused: 0, resumed: 0 }

    await t`
      update events
      set stripe_charges_enabled = ${capabilities.chargesEnabled},
          stripe_payouts_enabled = ${capabilities.payoutsEnabled},
          stripe_status_updated_at = now(),
          paid_sales_paused_at = ${reason ? t`coalesce(paid_sales_paused_at, now())` : t`null`},
          paid_sales_paused_reason = ${reason},
          updated_at = now()
      where stripe_account_id = ${capabilities.accountId}
    `

    let paused = 0
    let resumed = 0
    for (const row of rows) {
      if (reason && !row.paid_sales_paused_at) {
        paused += 1
        const organizers = await t<{ user_id: string }[]>`
          select user_id from event_members where event_id = ${row.id} and role in ('owner', 'admin')
        `
        await notify(t, {
          eventId: row.id,
          userIds: organizers.map((o) => o.user_id),
          type: 'payments_paused',
          title: 'Paid ticket sales are paused',
          body: `${reason} New paid tickets for ${row.name} cannot be sold until it is resolved in your Stripe dashboard. Free tickets and tickets already sold are unaffected.`,
          actionUrl: `/e/${row.slug}/admin/tickets`,
        })
      } else if (!reason && row.paid_sales_paused_at) {
        resumed += 1
      }
    }
    return { events: rows.length, paused, resumed }
  })
}

/** Record a live readiness read on the gathering, so the cache does not go stale in normal use. */
export async function cacheReadiness(eventId: string, readiness: MerchantReadiness): Promise<void> {
  if (!readiness.connected) return
  await sql`
    update events
    set stripe_charges_enabled = ${readiness.chargesEnabled},
        stripe_payouts_enabled = ${readiness.payoutsEnabled},
        stripe_status_updated_at = now()
    where id = ${eventId}
  `
}
