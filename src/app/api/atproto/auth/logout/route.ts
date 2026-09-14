import { NextResponse } from 'next/server'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import { destroyAtSession } from '@/lib/atproto/session'
import { describe } from '@/lib/atproto/bridge'

/**
 * Drop the `sp_at_session` cookie and its row. The Supabase half of sign-out
 * is the client's job (`useAuth().signOut`), which calls this alongside it.
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const origin = request.headers.get('Origin')
  if (origin && origin !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } })
  if (!isAtprotoConfigured()) return res
  try {
    res.headers.append('Set-Cookie', await destroyAtSession(request))
  } catch (e) {
    console.warn('[atproto] logout could not destroy session:', describe(e))
  }
  return res
}
