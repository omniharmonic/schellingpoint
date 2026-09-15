import { NextResponse } from 'next/server'
import { publicUrl } from '@/lib/atproto/config'
import { createAtSession } from '@/lib/atproto/session'
import { getAccount, verifyEmailToken } from '@/lib/auth/custody'

/**
 * `GET /auth/verify?token=` — the magic link. Consumes the token (single use), opens a
 * session, sets the cookie and redirects to the path the sign-in started from. Any
 * failure lands on `/login?error=link`.
 */
export const dynamic = 'force-dynamic'

function redirect(path: string, setCookie?: string) {
  const res = NextResponse.redirect(new URL(path, publicUrl()), { status: 302 })
  if (setCookie) res.headers.append('Set-Cookie', setCookie)
  res.headers.set('Cache-Control', 'private, no-store')
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  try {
    const { accountId, nextPath } = await verifyEmailToken(token)
    const account = await getAccount(accountId)
    if (!account) return redirect('/login?error=link')
    const session = await createAtSession({ did: account.did, accountId: account.id, kind: account.kind })
    return redirect(nextPath, session.setCookie)
  } catch (e) {
    if (!(e instanceof Error && e.name === 'AuthError')) {
      console.error('[auth] verify failed:', e instanceof Error ? `${e.name}: ${e.message}` : 'error')
    }
    return redirect('/login?error=link')
  }
}
