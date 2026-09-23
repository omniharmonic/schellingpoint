import 'server-only'
/**
 * Subscribable calendar feeds (MT §12.8).
 *
 * A calendar client cannot hold a session cookie, so the subscription URL carries its own
 * credential. The rules are the ones already used for magic links and assistant tokens:
 * only the sha256 of the token is stored, the URL is shown once at mint time, and the feed
 * reads exactly what its owner can read — the sessions they have saved, in gatherings they
 * are still a member of. Revoking is immediate and is offered in Account → Notifications.
 *
 * The token is a bearer credential in a URL, which is why the feed is read-only, returns no
 * names but the person's own saved sessions, and is never used for anything else.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { sql } from '@/lib/db'

export const FEED_TOKEN_PREFIX = 'cal_'
export const MAX_LIVE_FEEDS = 3
/** How often a subscribed client should come back. */
export const FEED_REFRESH_INTERVAL = 'PT1H'

export interface FeedTokenRow {
  id: string
  created_at: string
  last_used_at: string | null
}

function hash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** `cal_<43 chars base64url>` — 32 bytes of randomness, same shape as an assistant token. */
function newToken(): string {
  return `${FEED_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export async function listFeedTokens(accountId: string): Promise<FeedTokenRow[]> {
  return sql<FeedTokenRow[]>`
    select id, created_at, last_used_at from calendar_feed_tokens
    where account_id = ${accountId} and revoked_at is null
    order by created_at desc
  `
}

export class FeedLimitError extends Error {
  constructor() {
    super(`You already have ${MAX_LIVE_FEEDS} calendar subscriptions. Revoke one first.`)
    this.name = 'FeedLimitError'
  }
}

/** Mint one. The token is returned exactly once; only its hash is stored. */
export async function mintFeedToken(accountId: string): Promise<{ token: string; row: FeedTokenRow }> {
  const live = await listFeedTokens(accountId)
  if (live.length >= MAX_LIVE_FEEDS) throw new FeedLimitError()
  const token = newToken()
  const [row] = await sql<FeedTokenRow[]>`
    insert into calendar_feed_tokens (account_id, token_hash) values (${accountId}, ${hash(token)})
    returning id, created_at, last_used_at
  `
  return { token, row }
}

export async function revokeFeedToken(accountId: string, id: string): Promise<boolean> {
  const rows = await sql`
    update calendar_feed_tokens set revoked_at = now()
    where id = ${id} and account_id = ${accountId} and revoked_at is null
  `
  return rows.count > 0
}

export async function revokeAllFeedTokens(accountId: string): Promise<number> {
  const rows = await sql`
    update calendar_feed_tokens set revoked_at = now() where account_id = ${accountId} and revoked_at is null
  `
  return rows.count
}

/**
 * Resolve a token from a feed URL to its account, or null. Constant-time on the hash so a
 * wrong token cannot be distinguished from a revoked one by timing; `last_used_at` is written
 * at most once an hour, because calendar clients poll hard.
 */
export async function accountForFeedToken(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !token.startsWith(FEED_TOKEN_PREFIX) || token.length > 128) return null
  const digest = hash(token)
  const [row] = await sql<{ id: string; account_id: string; token_hash: string; last_used_at: string | null }[]>`
    select id, account_id, token_hash, last_used_at from calendar_feed_tokens
    where token_hash = ${digest} and revoked_at is null
  `
  if (!row) return null
  const a = Buffer.from(row.token_hash, 'hex')
  const b = Buffer.from(digest, 'hex')
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > 3_600_000) {
    await sql`update calendar_feed_tokens set last_used_at = now() where id = ${row.id}`.catch(() => undefined)
  }
  return row.account_id
}
