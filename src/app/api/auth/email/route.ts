import { after, NextResponse } from 'next/server'
import { assertSameOrigin } from '@/lib/auth/viewer'
import { clientIp } from '@/lib/auth/client-ip'
import { authErrorResponse, startEmailSignIn } from '@/lib/auth/custody'
import { dbErrorResponse } from '@/lib/db'

/**
 * `POST /api/auth/email {email, next}` — sign in or sign up with a magic link.
 * A new email gets a fresh identity on our PDS first (handle generated, never derived
 * from the email). `devVerifyUrl` is returned only when mail is unconfigured outside
 * production.
 *
 * Abuse controls (see `startEmailSignIn`): per-email, per-IP (`TRUST_PROXY=true` behind Caddy) and
 * global limits answer 429 `{ error, code: 'rate_limited' }` with `Retry-After`. An existing and a
 * new address get the same response; where mail is delivered the slow work runs in `after()`.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused

  let body: { email?: unknown; next?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof body?.email !== 'string') {
    return NextResponse.json({ error: 'Email is required', field: 'email' }, { status: 400 })
  }
  try {
    const result = await startEmailSignIn(body.email, typeof body.next === 'string' ? body.next : null, {
      ip: clientIp(request),
      defer: (task) => after(task),
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    const mapped = authErrorResponse(e) ?? dbErrorResponse(e)
    if (mapped) return mapped
    console.error('[auth] email sign-in failed:', e instanceof Error ? e.name : 'error')
    return NextResponse.json({ error: 'Could not send a sign-in link. Please try again.' }, { status: 503 })
  }
}
