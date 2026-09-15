import { NextResponse } from 'next/server'
import { revealOwnershipPassword } from '@/lib/auth/custody'

/**
 * `GET /api/me/reveal?token=` → `{ handle, password }`, exactly once. The token (from the
 * take-ownership email) is the credential; the page at `/account/reveal` calls this only
 * when the member presses the reveal button, so a link scanner opening the email link
 * does not burn it.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') ?? ''
  try {
    const result = await revealOwnershipPassword(token)
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status, headers: NO_STORE })
    return NextResponse.json({ handle: result.handle, password: result.password }, { headers: NO_STORE })
  } catch (e) {
    console.error('[auth] reveal failed:', e instanceof Error ? e.name : 'error')
    return NextResponse.json({ error: 'Could not reveal the password.' }, { status: 500, headers: NO_STORE })
  }
}
