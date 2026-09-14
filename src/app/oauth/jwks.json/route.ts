import { NextResponse } from 'next/server'
import { isAtprotoConfigured, oauthMode } from '@/lib/atproto/config'
import { jwks } from '@/lib/atproto/oauth'

/** Public half of the confidential client's signing key. Empty in loopback mode. */
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!isAtprotoConfigured()) {
    return NextResponse.json({ error: 'atproto_not_configured' }, { status: 503 })
  }
  const body = oauthMode() === 'loopback' ? { keys: [] } : await jwks()
  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
