import 'server-only'
import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * Scheduler authentication for job routes (plan §7.2 "Jobs"):
 *   `Authorization: Bearer $CRON_SECRET`, else 401.
 *   CRON_SECRET unset: allowed in development, 503 everywhere else (never run jobs open).
 * Returns null when the request may proceed, else the response to send.
 */
export function authorizeCron(
  request: Request,
  env: { secret?: string | undefined; nodeEnv?: string | undefined } = {
    secret: process.env.CRON_SECRET,
    nodeEnv: process.env.NODE_ENV,
  },
): Response | null {
  const secret = env.secret?.trim()
  const headers = { 'Cache-Control': 'no-store' }
  if (!secret) {
    if (env.nodeEnv === 'development') return null
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503, headers })
  }
  const header = request.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  // Compare digests so the comparison is constant-time regardless of length.
  const given = createHash('sha256').update(match?.[1] ?? '').digest()
  const expected = createHash('sha256').update(secret).digest()
  if (!match || !timingSafeEqual(given, expected)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  }
  return null
}
