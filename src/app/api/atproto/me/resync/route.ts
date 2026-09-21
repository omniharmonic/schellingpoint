import { NextResponse } from 'next/server'
import { describe } from '@/lib/atproto/bridge'
import { resyncProfile } from '@/lib/atproto/bsky-profile'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'

/**
 * "Re-sync from my Bluesky profile" (release design §5.2).
 *
 *   POST  → `{ updated, synced, fetched }`
 *
 * Re-reads the person's network profile (their PDS record first, the AppView as fallback) and
 * re-imports display name, avatar and bio whether or not they were edited here, rebuilding
 * `profiles.synced_fields`. OAuth (Bluesky-door) accounts only: a custodial account's repo lives
 * on our PDS and has nothing to import from. `fetched: false` means nothing could be read (the
 * profile is untouched).
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

export async function POST(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  if (viewer.kind !== 'oauth') {
    return NextResponse.json(
      { error: 'Only an account signed in with its own ATProto identity has a network profile to re-sync.', code: 'not_oauth' },
      { status: 409, headers: NO_STORE },
    )
  }
  try {
    const result = await resyncProfile(viewer.accountId, viewer.did)
    return NextResponse.json(result, { status: result.fetched ? 200 : 502, headers: NO_STORE })
  } catch (e) {
    console.error('[atproto] profile resync failed:', describe(e))
    return NextResponse.json({ error: 'internal' }, { status: 500, headers: NO_STORE })
  }
}
