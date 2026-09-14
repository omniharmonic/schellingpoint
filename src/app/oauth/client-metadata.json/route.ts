import { NextResponse } from 'next/server'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import { clientMetadata } from '@/lib/atproto/oauth'

/**
 * The ATProto OAuth client metadata document. In confidential mode this URL
 * IS the `client_id`, and every authorization server fetches it; in loopback
 * mode it is informational (the server derives the metadata from the id).
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  if (!isAtprotoConfigured()) {
    return NextResponse.json({ error: 'atproto_not_configured' }, { status: 503 })
  }
  return NextResponse.json(clientMetadata(), {
    headers: { 'Cache-Control': 'public, max-age=300' },
  })
}
