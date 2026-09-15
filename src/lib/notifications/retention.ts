import 'server-only'
import { sql as defaultSql, type Sql } from '@/lib/db'

/**
 * Retention jobs (spec §9) for the app-side tables that exist in this instance. Each rule is
 * one statement, independent of the others, and reports a count only — never identifiers.
 *
 * Owned elsewhere: credit ledgers are deleted at round close (package C).
 */

export type RetentionRule =
  | 'notifications_90d'
  | 'event_invitations_inviter_30d'
  | 'cohost_invites_inviter_30d'
  | 'ticket_checkins_to_counts_90d'
  | 'ticket_payment_ids_archived'
  | 'ticket_holds_expired'
  | 'auth_email_tokens_expired'
  | 'at_sessions_expired'
  | 'at_oauth_state_1h'

export type RetentionReport = Record<RetentionRule, number>

const RULES: ReadonlyArray<[RetentionRule, (db: Sql) => Promise<{ count: number }>]> = [
  // A notification feed is an activity log.
  ['notifications_90d', (db) => db`delete from notifications where created_at < now() - interval '90 days'`],
  // The invite graph is the organising graph: forget who invited whom a month after it was used.
  [
    'event_invitations_inviter_30d',
    (db) => db`
      update event_invitations set created_by = null
      where created_by is not null
        -- Link invitations have no accepted_at; their last use is last_redeemed_at.
        and coalesce(last_redeemed_at, accepted_at) < now() - interval '30 days'`,
  ],
  [
    'cohost_invites_inviter_30d',
    (db) => db`
      update cohost_invites set created_by = null
      where created_by is not null and accepted_at < now() - interval '30 days'`,
  ],
  // Check-in times and who scanned become counts: the status stays `checked_in`.
  [
    'ticket_checkins_to_counts_90d',
    (db) => db`
      update tickets t set checked_in_at = null, checked_in_by = null
      from events e
      where e.id = t.event_id
        and e.status in ('completed', 'archived')
        and e.end_date < current_date - 90
        and (t.checked_in_at is not null or t.checked_in_by is not null)`,
  ],
  // Payment identifiers are reduced at archival (amounts stay for the revenue totals).
  [
    'ticket_payment_ids_archived',
    (db) => db`
      update tickets t set payment_intent_id = null
      from events e
      where e.id = t.event_id and e.status = 'archived' and t.payment_intent_id is not null`,
  ],
  // Lapsed checkout holds occupy no capacity; a late payment is settled from Stripe metadata.
  ['ticket_holds_expired', (db) => db`delete from tickets where status = 'pending' and hold_expires_at < now()`],
  ['auth_email_tokens_expired', (db) => db`delete from auth_email_tokens where expires_at < now()`],
  ['at_sessions_expired', (db) => db`delete from at_sessions where expires_at < now()`],
  ['at_oauth_state_1h', (db) => db`delete from at_oauth_state where created_at < now() - interval '1 hour'`],
]

export async function runRetention(db: Sql = defaultSql): Promise<RetentionReport> {
  const report = {} as RetentionReport
  for (const [rule, run] of RULES) {
    const { count } = await run(db)
    report[rule] = count
    console.info(`[retention] rule=${rule} count=${count}`)
  }
  return report
}
