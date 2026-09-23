import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { appUrl } from './base-template'

/**
 * One-click unsubscribe (RFC 8058, inventory P2-7).
 *
 * Every notification email carries a link and a `List-Unsubscribe` header pointing at a
 * signed token. The token says only "this account, at this gathering"; it carries no
 * address, no expiry (an unsubscribe link must keep working) and no privilege beyond
 * turning email off. Redeeming it sets `email_enabled = false` for every notification
 * category at that scope — the gathering when the notification had one, otherwise
 * globally — which is exactly what the preferences page writes.
 *
 * Signed with a key derived from ATPROTO_SESSION_SECRET under its own purpose label, so
 * an unsubscribe token can never be replayed as a session or a ticket QR.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function key(): Buffer {
  const dedicated = process.env.UNSUBSCRIBE_SECRET?.trim()
  if (dedicated) {
    if (dedicated.length < 32) throw new Error('UNSUBSCRIBE_SECRET must be at least 32 characters')
    return Buffer.from(dedicated, 'utf8')
  }
  const session = process.env.ATPROTO_SESSION_SECRET?.trim()
  if (!session || session.length < 32) {
    throw new Error('UNSUBSCRIBE_SECRET (or ATPROTO_SESSION_SECRET) must be set to sign unsubscribe links')
  }
  return createHmac('sha256', session).update('unconference unsubscribe v1').digest()
}

export interface UnsubscribeScope {
  accountId: string
  /** The gathering the email was about, or null for a global unsubscribe. */
  eventId: string | null
}

function payloadOf(scope: UnsubscribeScope): string {
  return `${scope.accountId}.${scope.eventId ?? ''}`
}

function sign(payload: string): string {
  return createHmac('sha256', key()).update(payload).digest('base64url')
}

/** `<accountId>.<eventId|->.<mac>`; safe in a URL and in a header. */
export function unsubscribeToken(scope: UnsubscribeScope): string {
  const payload = payloadOf(scope)
  return `${scope.accountId}.${scope.eventId ?? '-'}.${sign(payload)}`
}

/** The scope a token names, or null when it is malformed or not ours. */
export function verifyUnsubscribeToken(token: string | null | undefined): UnsubscribeScope | null {
  if (typeof token !== 'string' || token.length > 300) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [accountId, eventPart, mac] = parts
  if (!UUID.test(accountId)) return null
  if (eventPart !== '-' && !UUID.test(eventPart)) return null
  const scope: UnsubscribeScope = { accountId, eventId: eventPart === '-' ? null : eventPart }
  let expected: Buffer
  try {
    expected = Buffer.from(sign(payloadOf(scope)), 'utf8')
  } catch {
    return null
  }
  const given = Buffer.from(mac, 'utf8')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  return scope
}

/** The page a person lands on from the footer link. */
export function unsubscribeUrl(scope: UnsubscribeScope): string {
  return `${appUrl()}/unsubscribe?t=${encodeURIComponent(unsubscribeToken(scope))}`
}

/** The endpoint a mail client POSTs to for RFC 8058 one-click. */
export function unsubscribePostUrl(scope: UnsubscribeScope): string {
  return `${appUrl()}/api/unsubscribe?t=${encodeURIComponent(unsubscribeToken(scope))}`
}

/** `List-Unsubscribe` + `List-Unsubscribe-Post`, or null when no key is configured. */
export function unsubscribeHeaders(scope: UnsubscribeScope): Record<string, string> | null {
  try {
    return {
      'List-Unsubscribe': `<${unsubscribePostUrl(scope)}>, <${unsubscribeUrl(scope)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    }
  } catch {
    return null
  }
}
