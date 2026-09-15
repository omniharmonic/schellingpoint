import 'server-only'
import { createHmac } from 'node:crypto'
import * as jose from 'jose'
import QRCode from 'qrcode'

/**
 * Check-in QR tokens (spec §5.5): a JWT signed by the AppView, scoped to one ticket at one
 * gathering and bound to the holder's DID, with a short TTL. It is a bearer credential for
 * the door, not an identity claim, and it is never stored: the ticket page asks for a fresh
 * one while it is open.
 *
 * Claims: { event_id, ticket_id, did } plus iat/exp, audience `ticket-checkin`.
 */

export const TICKET_QR_TTL_SECONDS = 15 * 60
const AUDIENCE = 'ticket-checkin'
const TYP = 'ticket-qr+jwt'

export interface TicketQrClaims {
  event_id: string
  ticket_id: string
  did: string
}

/**
 * HS256 key: TICKET_QR_SECRET when set (at least 32 characters), otherwise derived from
 * ATPROTO_SESSION_SECRET with a purpose label so the two keys are never interchangeable.
 */
function signingKey(): Uint8Array {
  const dedicated = process.env.TICKET_QR_SECRET?.trim()
  if (dedicated) {
    if (dedicated.length < 32) throw new Error('TICKET_QR_SECRET must be at least 32 characters')
    return new TextEncoder().encode(dedicated)
  }
  const session = process.env.ATPROTO_SESSION_SECRET?.trim()
  if (!session || session.length < 32) {
    throw new Error('TICKET_QR_SECRET (or ATPROTO_SESSION_SECRET) must be set to sign ticket QR codes')
  }
  return new Uint8Array(createHmac('sha256', session).update('unconference ticket-qr v1').digest())
}

export async function mintTicketToken(
  claims: TicketQrClaims,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  const iat = Math.floor(now.getTime() / 1000)
  const exp = iat + TICKET_QR_TTL_SECONDS
  const token = await new jose.SignJWT({ event_id: claims.event_id, ticket_id: claims.ticket_id, did: claims.did })
    .setProtectedHeader({ alg: 'HS256', typ: TYP })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setAudience(AUDIENCE)
    .sign(signingKey())
  return { token, expiresAt: new Date(exp * 1000).toISOString() }
}

/** The claims of a valid, unexpired token; null for anything else. */
export async function readTicketToken(token: string, now: Date = new Date()): Promise<TicketQrClaims | null> {
  if (typeof token !== 'string' || token.length > 4096) return null
  try {
    const { payload, protectedHeader } = await jose.jwtVerify(token, signingKey(), {
      algorithms: ['HS256'],
      audience: AUDIENCE,
      typ: TYP,
      currentDate: now,
      clockTolerance: 30,
    })
    if (protectedHeader.typ !== TYP) return null
    const { event_id, ticket_id, did } = payload as Record<string, unknown>
    if (typeof event_id !== 'string' || typeof ticket_id !== 'string' || typeof did !== 'string') return null
    return { event_id, ticket_id, did }
  } catch {
    return null
  }
}

/** PNG data URL for a token. */
export async function ticketQrDataUrl(token: string): Promise<string> {
  return QRCode.toDataURL(token, {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    margin: 2,
    width: 300,
    color: { dark: '#000000', light: '#ffffff' },
  })
}
