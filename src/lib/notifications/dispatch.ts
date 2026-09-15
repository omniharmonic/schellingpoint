import 'server-only'
import { sql as defaultSql, type Sql } from '@/lib/db'
import { MailNotConfiguredError, sendMail } from '@/lib/auth/mail'
import { renderNotificationEmail, type EventInfo } from '@/lib/email/notification-emails'
import { TRANSACTIONAL_TYPES, type NotificationType } from './categories'

/**
 * The email side of the notifications outbox (spec §6: notifications "ride the outbox").
 *
 * One run:
 *   1. rows that have been over their recipient's hourly limit for 24 hours are closed as
 *      `rate_limited` (a day-old flood is not worth delivering);
 *   2. up to `limit` pending rows within each recipient's remaining hourly allowance are
 *      claimed (`email_claimed_at`, fenced against concurrent runs);
 *   3. each claimed row is resolved: no verified email → `no_email`; category email off →
 *      `opted_out` (receipts in TRANSACTIONAL_TYPES excepted); otherwise rendered and sent →
 *      `sent`, or `dev_logged` when mail is not configured in development.
 *   A send that throws releases the claim for a later run; after MAX_ATTEMPTS it is `failed`.
 *
 * Only the recipient's own address and display name are read. Logs carry counts only.
 */

export interface DispatchOptions {
  /** Rows claimed per run (default 50, max 500). */
  limit?: number
  /** Emails per recipient per rolling hour (default NOTIFICATION_EMAILS_PER_HOUR or 12). */
  perHour?: number
  /** Database handle (a transaction in tests). */
  db?: Sql
  /** Transport (tests wrap the real `sendMail`). */
  send?: typeof sendMail
}

export interface DispatchResult {
  claimed: number
  sent: number
  devLogged: number
  optedOut: number
  noEmail: number
  rateLimited: number
  failed: number
  /** Sends that threw and were released for a later run. */
  retry: number
  /** Set when the run stopped early because mail is not configured in production. */
  error?: 'mail_not_configured'
}

const MAX_ATTEMPTS = 3
const CLAIM_TIMEOUT = '10 minutes'

type Outcome = 'sent' | 'dev_logged' | 'opted_out' | 'no_email' | 'rate_limited' | 'failed'

interface ClaimedRow {
  id: string
  type: NotificationType
  title: string
  body: string | null
  action_url: string | null
  email_attempts: number
  email_wanted: boolean
  recipient_email: string | null
  recipient_verified: boolean
  recipient_name: string | null
  event_slug: string | null
  event_name: string | null
  event_logo_url: string | null
  event_start_date: string | null
  event_end_date: string | null
  event_location_name: string | null
}

function perHourDefault(): number {
  const n = Number.parseInt(process.env.NOTIFICATION_EMAILS_PER_HOUR ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 12
}

export function formatEventDateRange(startDate: string | null, endDate: string | null): string | undefined {
  if (!startDate || !endDate) return undefined
  const start = new Date(`${startDate.slice(0, 10)}T00:00:00Z`)
  const end = new Date(`${endDate.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
  const year = end.getUTCFullYear()
  if (start.getTime() === end.getTime()) return `${month(start)} ${start.getUTCDate()}, ${year}`
  if (month(start) === month(end) && start.getUTCFullYear() === year) {
    return `${month(start)} ${start.getUTCDate()}–${end.getUTCDate()}, ${year}`
  }
  return `${month(start)} ${start.getUTCDate()} – ${month(end)} ${end.getUTCDate()}, ${year}`
}

async function resolve(db: Sql, id: string, outcome: Outcome): Promise<void> {
  await db`
    update notifications
    set email_sent_at = now(), email_outcome = ${outcome}, email_claimed_at = null
    where id = ${id}
  `
}

export async function dispatchPending(options: DispatchOptions = {}): Promise<DispatchResult> {
  const db = options.db ?? defaultSql
  const send = options.send ?? sendMail
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 500)
  const perHour = Math.max(Math.trunc(options.perHour ?? perHourDefault()), 1)
  const result: DispatchResult = { claimed: 0, sent: 0, devLogged: 0, optedOut: 0, noEmail: 0, rateLimited: 0, failed: 0, retry: 0 }

  // Pending rows ranked per recipient, with each recipient's sends in the last hour.
  const ranked = db`
    select p.id, p.created_at,
           (p.rn + coalesce(r.recent, 0)) > ${perHour} as over_limit
    from (
      select n.id, n.user_id, n.created_at,
             row_number() over (partition by n.user_id order by n.created_at, n.id) as rn
      from notifications n
      where n.email_sent_at is null
        and (n.email_claimed_at is null or n.email_claimed_at < now() - ${CLAIM_TIMEOUT}::interval)
    ) p
    left join (
      select user_id, count(*)::int as recent
      from notifications
      where email_outcome in ('sent', 'dev_logged') and email_sent_at > now() - interval '1 hour'
      group by user_id
    ) r on r.user_id = p.user_id
  `

  // 1. Close rows that have sat over the limit for a day.
  const expired = await db`
    update notifications n
    set email_sent_at = now(), email_outcome = 'rate_limited', email_claimed_at = null
    from (${ranked}) x
    where n.id = x.id and x.over_limit and x.created_at < now() - interval '24 hours'
      and n.email_sent_at is null
  `
  result.rateLimited = expired.count

  // 2. Claim. The outer WHERE is re-checked against the locked row, so two concurrent runs
  //    cannot both claim the same notification.
  const claimedIds = await db<{ id: string }[]>`
    update notifications n
    set email_claimed_at = now(), email_attempts = n.email_attempts + 1
    where n.id in (
      select x.id from (${ranked}) x where not x.over_limit order by x.created_at, x.id limit ${limit}
    )
      and n.email_sent_at is null
      and (n.email_claimed_at is null or n.email_claimed_at < now() - ${CLAIM_TIMEOUT}::interval)
    returning n.id
  `
  result.claimed = claimedIds.length
  if (claimedIds.length === 0) return result

  // 3. Load what is needed to render: the recipient's own address and name, the event.
  const rows = await db<ClaimedRow[]>`
    select n.id, n.type, n.title, n.body, n.action_url, n.email_attempts,
           public.should_send_notification(n.user_id, n.event_id, n.type, 'email') as email_wanted,
           a.email as recipient_email,
           (a.email_verified_at is not null) as recipient_verified,
           nullif(trim(p.display_name), '') as recipient_name,
           e.slug as event_slug, e.name as event_name, e.logo_url as event_logo_url,
           e.start_date as event_start_date, e.end_date as event_end_date,
           e.location_name as event_location_name
    from notifications n
    join accounts a on a.id = n.user_id
    left join profiles p on p.id = n.user_id
    left join events e on e.id = n.event_id
    where n.id in ${db(claimedIds.map((r) => r.id))}
    order by n.created_at, n.id
  `

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (!row.recipient_email || !row.recipient_verified) {
      await resolve(db, row.id, 'no_email')
      result.noEmail++
      continue
    }
    if (!row.email_wanted && !TRANSACTIONAL_TYPES.has(row.type)) {
      await resolve(db, row.id, 'opted_out')
      result.optedOut++
      continue
    }

    const event: EventInfo | null = row.event_slug && row.event_name
      ? {
          name: row.event_name,
          slug: row.event_slug,
          logoUrl: row.event_logo_url ?? undefined,
          dateRange: formatEventDateRange(row.event_start_date, row.event_end_date),
          location: row.event_location_name ?? undefined,
        }
      : null
    const email = renderNotificationEmail({
      type: row.type,
      title: row.title,
      body: row.body,
      actionUrl: row.action_url,
      recipientName: row.recipient_name,
      event,
    })

    try {
      const { delivered } = await send({ to: row.recipient_email, subject: email.subject, text: email.text, html: email.html })
      await resolve(db, row.id, delivered ? 'sent' : 'dev_logged')
      if (delivered) result.sent++
      else result.devLogged++
    } catch (err) {
      if (err instanceof MailNotConfiguredError) {
        // Production without a mail key: release everything still claimed and stop.
        const remaining = rows.slice(i).map((r) => r.id)
        await db`update notifications set email_claimed_at = null, email_attempts = greatest(email_attempts - 1, 0) where id in ${db(remaining)}`
        result.error = 'mail_not_configured'
        break
      }
      if (row.email_attempts >= MAX_ATTEMPTS) {
        await resolve(db, row.id, 'failed')
        result.failed++
      } else {
        await db`update notifications set email_claimed_at = null where id = ${row.id}`
        result.retry++
      }
    }
  }

  console.info(
    `[notifications:dispatch] claimed=${result.claimed} sent=${result.sent} dev_logged=${result.devLogged} ` +
      `opted_out=${result.optedOut} no_email=${result.noEmail} rate_limited=${result.rateLimited} ` +
      `failed=${result.failed} retry=${result.retry}${result.error ? ` error=${result.error}` : ''}`,
  )
  return result
}
