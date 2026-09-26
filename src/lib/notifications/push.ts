import 'server-only'
import webpush from 'web-push'
import { sql, type Sql } from '@/lib/db'

export function pushConfig() {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY
  return publicKey && privateKey ? { publicKey, privateKey, subject: process.env.WEB_PUSH_SUBJECT || 'https://unconference.events' } : null
}

// Endpoints are browser-issued capability URLs, never arbitrary fetch targets. Exact provider
// hosts prevent localhost/private-network requests and redirects to attacker-selected hosts.
const PROVIDERS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'])
export function validPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash && PROVIDERS.has(u.hostname) && u.pathname.length > 1 } catch { return false }
}
export function validPushKey(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && /^[\w-]+$/.test(value) && Buffer.from(value, 'base64url').length === bytes
}

/** Independent of email delivery. Claims are per-device; retries cannot duplicate successful devices. */
export async function dispatchPush({ db = sql, send = webpush.sendNotification }: { db?: Sql; send?: typeof webpush.sendNotification } = {}) {
  const config = pushConfig()
  if (!config) return { configured: false, sent: 0, failed: 0 }
  await db`delete from push_subscriptions p using at_sessions a where p.session_id = a.id and a.expires_at <= now()`
  await db`
    insert into push_deliveries (notification_id, subscription_id)
    select n.id, p.id from notifications n join push_subscriptions p on p.user_id = n.user_id
      join at_sessions a on a.id = p.session_id and a.expires_at > now()
    where n.created_at >= p.created_at and n.created_at > now() - interval '1 day'
      and public.should_send_notification(n.user_id, n.event_id, n.type, 'push')
    on conflict do nothing
  `
  const rows = await db<{ notification_id: string; subscription_id: string; endpoint: string; p256dh: string; auth: string }[]>`
    with pending as (
      select d.notification_id, d.subscription_id from push_deliveries d
      join notifications n on n.id = d.notification_id
      where d.completed_at is null and d.attempts < 3
        and (d.claimed_at is null or d.claimed_at < now() - interval '5 minutes')
        and n.created_at > now() - interval '1 day'
      order by n.created_at limit 200 for update of d skip locked
    ), claimed as (
      update push_deliveries d set claimed_at = now(), attempts = d.attempts + 1
      from pending p where p.notification_id = d.notification_id and p.subscription_id = d.subscription_id
      returning d.notification_id, d.subscription_id
    ) select c.*, p.endpoint, p.p256dh, p.auth from claimed c join push_subscriptions p on p.id = c.subscription_id
  `
  let sent = 0, failed = 0
  const deliver = async (row: typeof rows[number]) => {
    // Re-check preferences, membership and session immediately before delivery. A queued
    // message must not survive opt-out, departure from a private gathering, or sign-out.
    const [allowed] = await db`
      select n.action_url from push_subscriptions p join at_sessions a on a.id = p.session_id
      join notifications n on n.id = ${row.notification_id} and n.user_id = p.user_id
      where p.id = ${row.subscription_id} and a.expires_at > now()
        and public.should_send_notification(n.user_id, n.event_id, n.type, 'push')
        and (n.event_id is null or exists (select 1 from event_members m where m.event_id = n.event_id and m.user_id = p.user_id))
    `
    try {
      if (allowed && validPushEndpoint(row.endpoint)) {
        // No gathering name, identity, vote or private content on the lock screen.
        await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, JSON.stringify({ title: 'unconference', body: 'You have a new gathering update. Open the app to read it.', tag: row.notification_id, url: typeof allowed.action_url === 'string' && /^\/(?!\/)/.test(allowed.action_url) ? allowed.action_url : '/' }), { vapidDetails: config, TTL: 3600, timeout: 5000 })
        sent++
      }
      await db`update push_deliveries set completed_at = now(), claimed_at = null where notification_id = ${row.notification_id} and subscription_id = ${row.subscription_id}`
    } catch (e) {
      failed++
      const status = (e as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) await db`delete from push_subscriptions where id = ${row.subscription_id}`
      else await db`update push_deliveries set claimed_at = null where notification_id = ${row.notification_id} and subscription_id = ${row.subscription_id}`
    }
  }
  // Bound outbound concurrency so a gathering-wide update does not serialize hundreds
  // of requests, and provider timeouts stay within the scheduler's request budget.
  for (let i = 0; i < rows.length; i += 10) await Promise.all(rows.slice(i, i + 10).map(deliver))
  return { configured: true, sent, failed }
}
