import { NextResponse } from 'next/server'
import { clearSessionCookieHeaders, destroyAtSession } from '@/lib/atproto/session'
import { assertSameOrigin } from '@/lib/auth/viewer'

/** `POST /api/auth/signout` — delete the session row and clear the cookie (every scope). */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const res = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'private, no-store' } })
  let cookies: string[]
  try {
    cookies = await destroyAtSession(request)
  } catch (e) {
    console.warn('[auth] signout could not delete the session row:', e instanceof Error ? e.name : 'error')
    cookies = clearSessionCookieHeaders()
  }
  for (const c of cookies) res.headers.append('Set-Cookie', c)
  return res
}
