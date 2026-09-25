import 'server-only'
import { sql, type Sql } from '@/lib/db'
import type { CreateMerchantResult, MerchantApi, MerchantGateway } from './merchant'

/**
 * Creating the gathering's merchant account, retryably.
 *
 * Two rules pull in opposite directions and both matter:
 *
 *   * Two "Connect" clicks must not orphan two Stripe accounts. That is what the create call's
 *     idempotency key is for.
 *   * A create that failed for an environmental reason must be retryable *now*. Stripe caches the
 *     answer against an idempotency key for 24 hours and replays it verbatim, failures included —
 *     so a key derived from the event id alone locked the organizer out for a day when the first
 *     attempt hit a platform that had not enabled Connect yet.
 *
 * `events.stripe_connect_attempts` (migration 0040) settles it. It counts *failures* and nothing
 * else, and it is the last component of the key. A retry after a failure is therefore a fresh
 * request to Stripe, while two clicks inside one attempt still send the same key and still get one
 * account back.
 *
 * This lives apart from the route so it can be exercised against the real database with a fake
 * gateway — the route itself is unreachable in a deployment with no Stripe key.
 */

export interface ConnectMerchantEvent {
  id: string
  slug: string
  name: string
  stripe_account_id: string | null
}

export type ConnectMerchantResult =
  /** An account is connected: either it already was, or this call created and saved one. */
  | { status: 'connected'; accountId: string; created: boolean; api: MerchantApi | null }
  /** Stripe refused the create. `attempts` is the counter *after* the failure was recorded. */
  | { status: 'create_failed'; error: unknown; attempts: number }
  /** Stripe created the account but we could not record its id — an operator has to look. */
  | { status: 'save_failed'; accountId: string }

/**
 * Return the gathering's merchant account, creating one through the gateway if it has none.
 *
 * Never creates a second account for a gathering that already has one, and only ever fills an
 * empty `events.stripe_account_id` — the same care the route took before this moved here.
 */
export async function connectMerchantAccount(
  gateway: MerchantGateway,
  event: ConnectMerchantEvent,
  email: string | null | undefined,
  db: Sql = sql,
): Promise<ConnectMerchantResult> {
  if (event.stripe_account_id) {
    return { status: 'connected', accountId: event.stripe_account_id, created: false, api: null }
  }

  const [row] = await db<{ stripe_account_id: string | null; stripe_connect_attempts: number }[]>`
    select stripe_account_id, stripe_connect_attempts from events where id = ${event.id}
  `
  if (row?.stripe_account_id) {
    return { status: 'connected', accountId: row.stripe_account_id, created: false, api: null }
  }
  const attempt = Number(row?.stripe_connect_attempts ?? 0)

  let created: CreateMerchantResult
  try {
    created = await gateway.createAccount({
      eventId: event.id,
      eventSlug: event.slug,
      eventName: event.name,
      email,
      attempt,
    })
  } catch (error) {
    // Record the failure so the organizer's next click uses a fresh idempotency key instead of
    // being handed Stripe's cached copy of this error for the next 24 hours. The bump is best
    // effort: if it fails the organizer is no worse off than before, and the original error is
    // what they need to see, so it is never replaced by a database error.
    let attempts = attempt + 1
    try {
      const [bumped] = await db<{ stripe_connect_attempts: number }[]>`
        update events set stripe_connect_attempts = stripe_connect_attempts + 1, updated_at = now()
        where id = ${event.id}
        returning stripe_connect_attempts
      `
      attempts = Number(bumped?.stripe_connect_attempts ?? attempts)
    } catch {
      console.error('[stripe-connect] failed to record a failed merchant-create attempt')
    }
    return { status: 'create_failed', error, attempts }
  }

  // A success leaves the counter alone: it counts failures, not accounts.
  try {
    const saved = await db<{ stripe_account_id: string }[]>`
      update events set stripe_account_id = ${created.accountId}, updated_at = now()
      where id = ${event.id} and stripe_account_id is null
      returning stripe_account_id
    `
    if (saved.length > 0) {
      return { status: 'connected', accountId: created.accountId, created: true, api: created.api }
    }
    // Somebody else's click won the race and filled the slot: their account is the one to use,
    // and with one attempt counter the idempotency key means it is the same account anyway.
    const [current] = await db<{ stripe_account_id: string | null }[]>`
      select stripe_account_id from events where id = ${event.id}
    `
    return {
      status: 'connected',
      accountId: current?.stripe_account_id ?? created.accountId,
      created: false,
      api: created.api,
    }
  } catch {
    return { status: 'save_failed', accountId: created.accountId }
  }
}
