import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { getViewer } from '@/lib/auth/viewer'

/** `GET /api/auth/me` → `{ user: {id, email, did, handle, kind} | null, profile | null }`. */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function GET(request: Request) {
  const viewer = await getViewer(request)
  if (!viewer) return NextResponse.json({ user: null, profile: null }, { headers: NO_STORE })
  const rows = await sql`select * from profiles where id = ${viewer.accountId}`
  return NextResponse.json(
    {
      user: { id: viewer.accountId, email: viewer.email, did: viewer.did, handle: viewer.handle, kind: viewer.kind },
      profile: rows[0] ?? null,
    },
    { headers: NO_STORE },
  )
}
