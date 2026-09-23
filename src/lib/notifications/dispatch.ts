import 'server-only'
import { sql as defaultSql, type Sql } from '@/lib/db'
import { MailNotConfiguredError, sendMail } from '@/lib/auth/mail'
import { renderDigestEmail, renderNotificationEmail, type DigestItem, type EventInfo } from '@/lib/email/notification-emails'
import { unsubscribeHeaders, unsubscribeUrl } from '@/lib/email/unsubscribe'
import { TRANSACTIONAL_TYPES, type NotificationType } from './categories'

/**
 * The email side of the notifications outbox (spec §6: notifications "ride the outbox").
 *
 * One run:
 *   1. rows that have been over their recipient's hourly limit for an hour are collected
 *      into ONE digest email per recipient and closed as `digested` (a flood is a reason
 *      to batch, not a reason to say nothing — inventory P2-8);
 *   2. up to `limit` pending rows within each recipient's remaining hourly allowance are
 *      claimed (`email_claimed_at`, fenced against concurrent runs);
 *   3. each claimed row is resolved: no verified email → `no_email`; category email off →
 *      `opted_out` (receipts in TRANSACTIONAL_TYPES excepted); otherwise rendered and sent →
 *      `sent`, or `dev_logged` when mail is not configured in development.
 *   A send that throws releases the claim for a later run; after MAX_ATTEMPTS it is `failed`.
 *
 * Every non-identity email carries a signed one-click unsubscribe (RFC 8058): the
 * `List-Unsubscribe` / `List-Unsubscribe-Post` headers and a footer link, both scoped to
 * this recipient and this gathering (src/lib/email/unsubscribe.ts).
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
  /** Rows folded into a digest because the recipient was over their hourly limit. */
  digested: number
  /** Digest emails actually sent (one per recipient). */
  digests: number
  rateLimited: number
  failed: number
  /** Sends that threw and were released for a later run. */
  retry: number
  /** Set when the run stopped early because mail is not configured in production. */
  error?: 'mail_not_configured'
}

const MAX_ATTEMPTS = 3
const CLAIM_TIMEOUT = '10 minutes'

type Outcome = 'sent' | 'dev_logged' | 'opted_out' | 'no_email' | 'rate_limited' | 'failed' | 'digested'

/** Rows wait this long over the limit before they are folded into a digest. */
const DIGEST_AFTER = '1 hour'
/** Lines in one digest email; a longer backlog is paged into several, never truncated. */
const DIGEST_MAX_ITEMS = 40
/** Digest emails one recipient may receive in a single run; the rest wait for the next. */
const DIGEST_MAX_PER_RUN = 5
/** Rows claimed for digesting across all recipients in one run. */
const DIGEST_CLAIM_LIMIT = 500

interface ClaimedRow {
  id: string
  user_id: string
  event_id: string | null
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

interface DigestRow {
  id: string
  user_id: string
  event_id: string | null
  type: NotificationType
  title: string
  body: string | null
  action_url: string | null
  created_at: string
}

/** Signing an unsubscribe link needs a key; without one the email simply has no link. */
function safely<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch {
    return null
  }
}

async function resolveMany(db: Sql, ids: readonly string[], outcome: Outcome): Promise<void> {
  if (!ids.length) return
  await db`
    update notifications
    set email_sent_at = now(), email_outcome = ${outcome}, email_claimed_at = null
    where id in ${db(ids as string[])}
  `
}

/** Puts claimed rows back in the queue, unhandled, for the next run. */
async function releaseMany(db: Sql, ids: readonly string[]): Promise<void> {
  if (!ids.length) return
  await db`update notifications set email_claimed_at = null where id in ${db(ids as string[])}`
}

/**
 * One email per recipient for everything that sat over their hourly limit (P2-8). The
 * digest itself does not count against the limit: it IS the limit working.
 *
 * Rows whose recipient has no verified address, or whose category has email off, are
 * closed with the outcome they would have got individually, so nothing is silently lost.
 *
 * A backlog longer than one digest is PAGED, never truncated: a row is marked `digested`
 * only once an email carrying it was accepted. Past `DIGEST_MAX_PER_RUN` pages the rest of
 * the backlog is released back into the queue for the next run rather than being buried.
 */
async function sendDigests(
  db: Sql,
  send: typeof sendMail,
  overdue: readonly DigestRow[],
  result: DispatchResult,
): Promise<void> {
  const byRecipient = new Map<string, DigestRow[]>()
  for (const row of overdue) {
    const list = byRecipient.get(row.user_id) ?? []
    list.push(row)
    byRecipient.set(row.user_id, list)
  }

  for (const [userId, rows] of byRecipient) {
    const [recipient] = await db<{
      email: string | null; verified: boolean; name: string | null
    }[]>`
      select a.email, (a.email_verified_at is not null) as verified, nullif(trim(p.display_name), '') as name
      from accounts a left join profiles p on p.id = a.id
      where a.id = ${userId}
    `
    if (!recipient?.email || !recipient.verified) {
      await resolveMany(db, rows.map((r) => r.id), 'no_email')
      result.noEmail += rows.length
      continue
    }

    // Preferences still decide: a category the person turned off never reaches the digest.
    const wanted: DigestRow[] = []
    const unwanted: DigestRow[] = []
    for (const row of rows) {
      const [pref] = await db<{ ok: boolean }[]>`
        select public.should_send_notification(${userId}::uuid, ${row.event_id}::uuid, ${row.type}::varchar, 'email'::varchar) as ok
      `
      if (pref?.ok || TRANSACTIONAL_TYPES.has(row.type)) wanted.push(row)
      else unwanted.push(row)
    }
    await resolveMany(db, unwanted.map((r) => r.id), 'opted_out')
    result.optedOut += unwanted.length
    if (!wanted.length) continue

    // One digest covers one gathering; rows from different gatherings get their own.
    const byEvent = new Map<string, DigestRow[]>()
    for (const row of wanted) {
      const key = row.event_id ?? ''
      byEvent.set(key, [...(byEvent.get(key) ?? []), row])
    }

    // Pages of this recipient's backlog, in order, across all their gatherings.
    let pagesLeft = DIGEST_MAX_PER_RUN
    for (const [eventKey, group] of byEvent) {
      const pages: DigestRow[][] = []
      for (let i = 0; i < group.length; i += DIGEST_MAX_ITEMS) pages.push(group.slice(i, i + DIGEST_MAX_ITEMS))
      const sending = pages.slice(0, pagesLeft)
      const deferred = pages.slice(pagesLeft).flat()
      pagesLeft -= sending.length
      await releaseMany(db, deferred.map((r) => r.id))

      const [ev] = eventKey
        ? await db<{
            slug: string; name: string; logo_url: string | null; start_date: string | null
            end_date: string | null; location_name: string | null
          }[]>`
            select slug, name, logo_url, start_date, end_date, location_name from events where id = ${eventKey}
          `
        : []
      const event: EventInfo | null = ev
        ? {
            name: ev.name,
            slug: ev.slug,
            logoUrl: ev.logo_url ?? undefined,
            dateRange: formatEventDateRange(ev.start_date, ev.end_date),
            location: ev.location_name ?? undefined,
          }
        : null
      const scope = { accountId: userId, eventId: eventKey || null }
      for (const page of sending) {
        const items: DigestItem[] = page.map((r) => ({
          type: r.type, title: r.title, body: r.body, actionUrl: r.action_url,
        }))
        const email = renderDigestEmail({
          items,
          recipientName: recipient.name,
          event,
          unsubscribeUrl: safely(() => unsubscribeUrl(scope)),
          unsubscribeHeaders: safely(() => unsubscribeHeaders(scope)),
        })
        try {
          await send({ to: recipient.email, subject: email.subject, text: email.text, html: email.html, headers: email.headers })
          result.digests++
        } catch (e) {
          // Whatever is still claimed for this recipient goes back in the queue unhandled.
          const stillClaimed = sending.slice(sending.indexOf(page)).flat().map((r) => r.id)
          await releaseMany(db, stillClaimed)
          if (e instanceof MailNotConfiguredError) {
            // Nothing can be delivered this run: hand every claimed row back. Releasing a
            // row that is already resolved is a no-op (its claim is null already).
            await releaseMany(db, overdue.map((r) => r.id))
            result.error = 'mail_not_configured'
            return
          }
          console.warn('[notifications:dispatch] digest send failed:', e instanceof Error ? e.name : 'error')
          break // the next run tries this recipient again
        }
        await resolveMany(db, page.map((r) => r.id), 'digested')
        result.digested += page.length
      }
    }
  }
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
  const result: DispatchResult = {
    claimed: 0, sent: 0, devLogged: 0, optedOut: 0, noEmail: 0,
    digested: 0, digests: 0, rateLimited: 0, failed: 0, retry: 0,
  }

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

  // 1. Rows that have sat over the limit for an hour become digests, one per recipient per
  //    gathering. They are CLAIMED as they are selected — with the same fence as step 2 —
  //    so two overlapping runs cannot both digest them and send the same backlog twice.
  const overdue = await db<DigestRow[]>`
    update notifications n
    set email_claimed_at = now()
    where n.id in (
      select x.id from (${ranked}) x
      where x.over_limit and x.created_at < now() - ${DIGEST_AFTER}::interval
      order by x.created_at, x.id
      limit ${DIGEST_CLAIM_LIMIT}
    )
      and n.email_sent_at is null
      and (n.email_claimed_at is null or n.email_claimed_at < now() - ${CLAIM_TIMEOUT}::interval)
    returning n.id, n.user_id, n.event_id, n.type, n.title, n.body, n.action_url, n.created_at
  `
  if (overdue.length) {
    overdue.sort((a, b) => a.user_id.localeCompare(b.user_id) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    await sendDigests(db, send, overdue, result)
  }

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
    select n.id, n.user_id, n.event_id, n.type, n.title, n.body, n.action_url, n.email_attempts,
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
    const scope = { accountId: row.user_id, eventId: row.event_id }
    const email = renderNotificationEmail({
      type: row.type,
      title: row.title,
      body: row.body,
      actionUrl: row.action_url,
      recipientName: row.recipient_name,
      event,
      unsubscribeUrl: safely(() => unsubscribeUrl(scope)),
      unsubscribeHeaders: safely(() => unsubscribeHeaders(scope)),
    })

    try {
      const { delivered } = await send({
        to: row.recipient_email,
        subject: email.subject,
        text: email.text,
        html: email.html,
        headers: email.headers,
      })
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
      `opted_out=${result.optedOut} no_email=${result.noEmail} digested=${result.digested} ` +
      `digests=${result.digests} rate_limited=${result.rateLimited} ` +
      `failed=${result.failed} retry=${result.retry}${result.error ? ` error=${result.error}` : ''}`,
  )
  return result
}
