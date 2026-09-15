import { NextResponse } from 'next/server'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { authErrorResponse, RevealPendingError, takeOwnership } from '@/lib/auth/custody'

/**
 * `POST /api/me/take-ownership` — leave custody. Rotates the PDS password admin-side and
 * emails a single-use reveal link (returned directly as `revealUrl` when mail was not
 * delivered — the caller is this account's own session).
 */
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  try {
    const result = await takeOwnership(viewer.accountId)
    return NextResponse.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    if (e instanceof RevealPendingError) {
      return NextResponse.json(
        { error: e.message, code: e.code, expiresAt: e.expiresAt.toISOString() },
        { status: 409, headers: { 'Cache-Control': 'private, no-store' } },
      )
    }
    const mapped = authErrorResponse(e)
    if (mapped) return mapped
    console.error('[auth] take-ownership failed:', e instanceof Error ? e.name : 'error')
    return NextResponse.json({ error: 'Could not take ownership. Please try again.' }, { status: 500 })
  }
}
