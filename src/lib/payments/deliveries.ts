import 'server-only'
import type postgres from 'postgres'
import { sql, tx, type Sql } from '@/lib/db'

/**
 * Idempotency by Stripe event id (db/migrations/0029, `stripe_events`).
 *
 * Every handler downstream converges on redelivery, but converging is not the same as not
 * running: a refund issued twice, or a notification sent twice, is a real effect that a
 * "harmless" retry would still cause. So a delivery is claimed by its own event id first.
 *
 * The claim is a **row lock held for as long as the work takes**, not a read followed by a
 * hopeful write. Stripe can and does deliver the same event down two connections at once; with
 * an unlocked `insert … on conflict do nothing` + `select`, both would see `processed_at IS
 * NULL` and both would dispatch. `withDelivery` instead inserts the row, takes `FOR UPDATE` on
 * it, and only releases when the handler has finished and `processed_at` is written — so the
 * second delivery blocks, then sees the finished row and does nothing.
 *
 * The handler's own writes run in their own transactions on other connections, which is fine:
 * nothing else contends for this row.
 *
 *   already_done   the event was processed before → drop it, answer 2xx
 *   (otherwise)    the handler runs; a throw rolls the claim back so Stripe's retry can take it
 */

export interface DeliveryRecord {
  /** Set by the handler when a paid delivery could not be matched to a checkout we opened. */
  rejection?: string | null
  sessionId?: string | null
  eventId?: string | null
}

export type DeliveryOutcome<T> = { done: false; result: T } | { done: true }

/**
 * Run `handler` under an exclusive claim on this Stripe event id. Returns `{ done: true }`
 * without running it when the event was already processed.
 */
export async function withDelivery<T>(
  input: { id: string; type: string; account: string | null },
  handler: (record: DeliveryRecord) => Promise<T>,
): Promise<DeliveryOutcome<T>> {
  return tx(async (t) => {
    await t`
      insert into stripe_events (id, type, account)
      values (${input.id}, ${input.type}, ${input.account})
      on conflict (id) do nothing
    `
    // Held until this transaction commits, i.e. until the handler has finished and the row is
    // stamped. A concurrent delivery of the same event waits here.
    const [claimed] = await t<{ processed_at: string | null }[]>`
      select processed_at from stripe_events where id = ${input.id} for update
    `
    if (claimed?.processed_at) return { done: true as const }

    const record: DeliveryRecord = {}
    const result = await handler(record)

    await t`
      update stripe_events
      set processed_at = now(),
          rejection = ${record.rejection ?? null},
          session_id = ${record.sessionId ?? null},
          event_id = ${record.eventId ?? null}
      where id = ${input.id}
    `
    return { done: false as const, result }
  })
}

export interface RejectedDelivery {
  id: string
  type: string
  rejection: string
  session_id: string | null
  received_at: string
}

/**
 * Paid deliveries this application refused, for one gathering. A refusal means a card was
 * charged and no admission was granted, so the organizer is shown it rather than it living
 * only in a log line.
 */
export async function rejectedDeliveriesForEvent(
  eventId: string,
  db: Sql = sql,
): Promise<RejectedDelivery[]> {
  return db<RejectedDelivery[]>`
    select id, type, rejection, session_id, received_at
    from stripe_events
    where event_id = ${eventId} and rejection is not null
    order by received_at desc
    limit 50
  `
}

/** Count only, for the revenue summary. */
export async function rejectedDeliveryCount(eventId: string, db: Sql = sql): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from stripe_events where event_id = ${eventId} and rejection is not null
  `
  return row.n
}

/** Used by tests and the retention sweep; never by a route. */
export type DeliveriesSql = postgres.Sql | postgres.TransactionSql
