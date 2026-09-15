import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isAtprotoConfigured, oauthMode } from '@/lib/atproto/config'
import { describe } from '@/lib/atproto/bridge'
import { assertSameOrigin, getViewer, requireViewer, type Viewer } from '@/lib/auth/viewer'

/**
 * The signed-in member's ATProto identity.
 *
 *   GET     `{ configured, oauthMode, linked, did, handle, kind, owned, publishProposals }`
 *           — also answers signed out (`linked: false`) so the login page can learn
 *           whether the Bluesky door is on.
 *   PATCH   `{ publish_proposals: boolean }`
 *   DELETE  refused (409): every account IS its identity; there is nothing to unlink.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function base() {
  return { configured: isAtprotoConfigured(), oauthMode: oauthMode() }
}

async function loadIdentity(viewer: Viewer) {
  const rows = await sql<{ owned_at: string | null; publish_proposals: boolean | null }[]>`
    select a.owned_at, p.publish_proposals
    from accounts a left join profiles p on p.id = a.id
    where a.id = ${viewer.accountId}
  `
  return {
    linked: true,
    did: viewer.did,
    handle: viewer.handle,
    kind: viewer.kind,
    owned: viewer.kind === 'oauth' || Boolean(rows[0]?.owned_at),
    publishProposals: Boolean(rows[0]?.publish_proposals),
  }
}

export async function GET(request: Request) {
  try {
    const viewer = await getViewer(request)
    if (!viewer) {
      return NextResponse.json(
        { ...base(), linked: false, did: null, handle: null, kind: null, owned: false, publishProposals: false },
        { headers: NO_STORE },
      )
    }
    return NextResponse.json({ ...base(), ...(await loadIdentity(viewer)) }, { headers: NO_STORE })
  } catch (e) {
    console.error('[atproto] me GET failed:', describe(e))
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const publish = (body as { publish_proposals?: unknown } | null)?.publish_proposals
  if (typeof publish !== 'boolean') {
    return NextResponse.json({ error: 'publish_proposals must be boolean', field: 'publish_proposals' }, { status: 400 })
  }

  try {
    await sql`update profiles set publish_proposals = ${publish} where id = ${viewer.accountId}`
    return NextResponse.json({ ...base(), ...(await loadIdentity(viewer)) }, { headers: NO_STORE })
  } catch (e) {
    console.error('[atproto] me PATCH failed:', describe(e))
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  return NextResponse.json(
    { error: 'This account is its identity; there is nothing to unlink.', code: 'primary_identity' },
    { status: 409, headers: NO_STORE },
  )
}
