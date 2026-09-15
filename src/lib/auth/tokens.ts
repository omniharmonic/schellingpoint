import 'server-only'
/**
 * Bearer tokens for magic links and reveal links, and the random passwords
 * custodial accounts are minted with. Only a token's `hashToken()` is ever
 * stored (`auth_email_tokens.token_hash`); the token itself exists in the
 * email and nowhere else.
 */
import { createHash, randomBytes } from 'node:crypto'

/** 32 random bytes, base64url — the value that goes into an emailed link. */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/** sha256 hex of a token: the primary key of its `auth_email_tokens` row. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** A random password of `bytes` bytes, base64url. The member never chooses or sees a custodial one. */
export function randomPassword(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
