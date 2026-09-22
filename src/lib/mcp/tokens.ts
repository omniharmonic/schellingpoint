import 'server-only'
/**
 * Assistant tokens: the credential a member's own AI assistant presents to `/api/mcp`
 * (migration 0028).
 *
 * `unc_<32 bytes base64url>`. Only `sha256(token)` is stored, so a token is shown exactly once —
 * at mint time — and cannot be recovered from the server afterwards. A member holds at most
 * `MAX_LIVE_TOKENS` live tokens at a time; revoking is immediate.
 *
 * A token is *not* a session: it never carries the session cookie's powers. It resolves to an
 * account id, and every MCP tool then applies the same membership and reading-tier checks the
 * browser goes through. It grants nothing a mutation route would accept.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { sql } from '@/lib/db'

export const TOKEN_PREFIX = 'unc_'
export const MAX_LIVE_TOKENS = 5
export const MAX_TOKEN_NAME = 60
/** `last_used_at` is written at most this often per token (an assistant polling hard writes once). */
const LAST_USED_THROTTLE_MS = 60_000

export interface AssistantTokenRow {
  id: string
  name: string
  scopes: string[]
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  revoked_at: string | null
}

/** A freshly minted token: `secret` is returned to the member once and never stored. */
export interface MintedToken {
  token: AssistantTokenRow
  secret: string
}

export function newAssistantToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function hashAssistantToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** `Authorization: Bearer unc_…` → the raw token, or null when the header is absent or not ours. */
export function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  const token = match?.[1]
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null
  // 32 bytes base64url is 43 chars; refuse anything obviously not a token before touching the db.
  return token.length >= TOKEN_PREFIX.length + 20 && token.length <= 200 ? token : null
}

export function validateTokenName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim()
  return name.length >= 1 && name.length <= MAX_TOKEN_NAME ? name : null
}

const COLUMNS = () => sql`id, name, scopes, created_at, last_used_at, expires_at, revoked_at`

/** The account's live tokens, newest first. Never includes the secret (it is not stored). */
export async function listAssistantTokens(accountId: string): Promise<AssistantTokenRow[]> {
  return sql<AssistantTokenRow[]>`
    select ${COLUMNS()} from assistant_tokens
    where account_id = ${accountId} and revoked_at is null
    order by created_at desc
  `
}

export type MintResult = MintedToken | { error: 'limit' }

/** Mint a token for the account, unless it already holds `MAX_LIVE_TOKENS`. */
export async function mintAssistantToken(accountId: string, name: string): Promise<MintResult> {
  const secret = newAssistantToken()
  const rows = await sql<AssistantTokenRow[]>`
    insert into assistant_tokens (account_id, name, token_hash)
    select ${accountId}, ${name}, ${hashAssistantToken(secret)}
    where (select count(*) from assistant_tokens where account_id = ${accountId} and revoked_at is null) < ${MAX_LIVE_TOKENS}
    returning ${COLUMNS()}
  `
  const token = rows[0]
  return token ? { token, secret } : { error: 'limit' }
}

/** Revoke one of the account's own tokens. False when it is not theirs, or already revoked. */
export async function revokeAssistantToken(accountId: string, id: string): Promise<boolean> {
  const rows = await sql`
    update assistant_tokens set revoked_at = now()
    where id = ${id} and account_id = ${accountId} and revoked_at is null
    returning id
  `
  return rows.length > 0
}

export interface AssistantPrincipal {
  tokenId: string
  tokenName: string
  accountId: string
  did: string
  handle: string | null
  scopes: string[]
}

/** In-process throttle for `last_used_at`; a restart simply writes once more than it had to. */
const lastUsedWrites = new Map<string, number>()

/**
 * Resolve a presented token to the account behind it, or null (absent, unknown, revoked, expired).
 * The lookup is by hash, so an attacker who can read this code still has to guess 32 random bytes;
 * the constant-time compare below guards the (already indexed, already hashed) equality anyway.
 */
export async function resolveAssistantToken(raw: string): Promise<AssistantPrincipal | null> {
  const hash = hashAssistantToken(raw)
  const rows = await sql<{
    id: string; name: string; token_hash: string; scopes: string[]; account_id: string
    did: string; handle: string | null; expires_at: string | null; revoked_at: string | null
  }[]>`
    select t.id, t.name, t.token_hash, t.scopes, t.account_id, a.did, a.handle, t.expires_at, t.revoked_at
    from assistant_tokens t join accounts a on a.id = t.account_id
    where t.token_hash = ${hash}
  `
  const row = rows[0]
  if (!row) return null
  const presented = Buffer.from(hash, 'utf8')
  const stored = Buffer.from(row.token_hash, 'utf8')
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null
  if (row.revoked_at) return null
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null
  return {
    tokenId: row.id,
    tokenName: row.name,
    accountId: row.account_id,
    did: row.did,
    handle: row.handle,
    scopes: row.scopes ?? ['read'],
  }
}

/** Record that the token was used, at most once a minute. Never blocks the request on failure. */
export async function touchAssistantToken(tokenId: string): Promise<void> {
  const now = Date.now()
  const last = lastUsedWrites.get(tokenId) ?? 0
  if (now - last < LAST_USED_THROTTLE_MS) return
  lastUsedWrites.set(tokenId, now)
  try {
    await sql`update assistant_tokens set last_used_at = now() where id = ${tokenId}`
  } catch (e) {
    console.warn('[mcp] could not record token use:', e instanceof Error ? e.message : e)
  }
}
