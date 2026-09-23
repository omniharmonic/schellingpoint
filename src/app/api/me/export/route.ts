/**
 * `GET /api/me/export` — "Download my data" (MT §12.6).
 *
 * Everything this app holds about the signed-in account, as one JSON file. Signed-in and
 * same-origin-free (it is a GET the browser downloads), but never cached and never available
 * to anyone but the account itself: there is no `?account=` parameter, by design.
 */
import { NextResponse } from 'next/server'
import { requireViewer } from '@/lib/auth/viewer'
import { buildAccountExport } from '@/lib/account/export'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const data = await buildAccountExport(viewer.accountId)
  if (!data) return NextResponse.json({ error: 'No account for this session.' }, { status: 404 })
  const stamp = new Date().toISOString().slice(0, 10)
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="unconference-my-data-${stamp}.json"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
