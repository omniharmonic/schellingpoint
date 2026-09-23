/**
 * `/api/me/calendar-feed` — the person's own subscription URLs (MT §12.8).
 *
 * GET     → { feeds: [{ id, created_at, last_used_at }], limit, webcalHost }
 * POST    → { url, webcalUrl, feed }. The URL contains the credential and is shown exactly
 *           once: only its sha256 is stored.
 * DELETE  → `?id=<uuid>` revokes one, or `?all=true` revokes every one of them, immediately.
 *
 * Same-origin and signed-in for every method, GET included: the list says how many calendars
 * a person has connected, which is theirs alone.
 */
import { NextResponse } from 'next/server'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { publicUrl } from '@/lib/atproto/config'
import {
  FeedLimitError,
  listFeedTokens,
  MAX_LIVE_FEEDS,
  mintFeedToken,
  revokeAllFeedTokens,
  revokeFeedToken,
} from '@/lib/calendar/feed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function origin(): string {
  try {
    return publicUrl().replace(/\/+$/, '')
  } catch {
    return 'http://localhost:3001'
  }
}

export async function GET(request: Request) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  return NextResponse.json(
    { feeds: await listFeedTokens(viewer.accountId), limit: MAX_LIVE_FEEDS },
    { headers: NO_STORE },
  )
}

export async function POST(request: Request) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  try {
    const { token, row } = await mintFeedToken(viewer.accountId)
    const url = `${origin()}/api/calendar/${token}`
    return NextResponse.json(
      { feed: row, url, webcalUrl: url.replace(/^https?:/, 'webcal:') },
      { status: 201, headers: NO_STORE },
    )
  } catch (e) {
    if (e instanceof FeedLimitError) {
      return NextResponse.json({ error: e.message, code: 'TooManyFeeds' }, { status: 409, headers: NO_STORE })
    }
    console.error('[calendar] could not mint a feed token:', e instanceof Error ? e.name : 'error')
    return NextResponse.json({ error: 'Could not create the subscription. Try again.' }, { status: 500, headers: NO_STORE })
  }
}

export async function DELETE(request: Request) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const params = new URL(request.url).searchParams
  if (params.get('all') === 'true') {
    return NextResponse.json({ revoked: await revokeAllFeedTokens(viewer.accountId) }, { headers: NO_STORE })
  }
  const id = params.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'Which subscription?' }, { status: 400, headers: NO_STORE })
  const done = await revokeFeedToken(viewer.accountId, id)
  if (!done) return NextResponse.json({ error: 'No such subscription.' }, { status: 404, headers: NO_STORE })
  return NextResponse.json({ revoked: 1 }, { headers: NO_STORE })
}
