import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { createAdminClient } from '@/lib/supabase/server'
import { isAtprotoConfigured, oauthMode } from '@/lib/atproto/config'
import { clearSessionCookieHeader } from '@/lib/atproto/session'
import { describe, isDidOnlyEmail, unlinkDid } from '@/lib/atproto/bridge'

/**
 * The signed-in member's ATProto identity.
 *
 *   GET     `{ configured, oauthMode, linked, did, handle, publishProposals }`
 *           — works without a bearer too (then `linked: false`), so the login
 *           page can learn whether the feature is on.
 *   PATCH   `{ publish_proposals: boolean }`
 *   DELETE  unlink. Refused (409 `primary_identity`) for an account whose only
 *           way in is the DID — unlinking it would lock the member out.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function base() {
  return { configured: isAtprotoConfigured(), oauthMode: oauthMode() }
}

async function loadIdentity(userId: string) {
  const db = await createAdminClient()
  const { data, error } = await db
    .from('profiles')
    .select('did, atproto_handle, publish_proposals')
    .eq('id', userId)
    .maybeSingle()
  if (error) throw new Error(`profiles get: ${error.message}`)
  return {
    linked: !!data?.did,
    did: (data?.did as string | null) ?? null,
    handle: (data?.atproto_handle as string | null) ?? null,
    publishProposals: Boolean(data?.publish_proposals),
  }
}

export async function GET(request: Request) {
  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json(
      { ...base(), linked: false, did: null, handle: null, publishProposals: false },
      { headers: NO_STORE },
    )
  }
  try {
    return NextResponse.json({ ...base(), ...(await loadIdentity(user.id)) }, { headers: NO_STORE })
  } catch (e) {
    console.error('[atproto] me GET failed:', describe(e))
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }
  const publish = (body as { publish_proposals?: unknown } | null)?.publish_proposals
  if (typeof publish !== 'boolean') return NextResponse.json({ error: 'publish_proposals must be boolean' }, { status: 400 })

  try {
    const db = await createAdminClient()
    const { error } = await db.from('profiles').update({ publish_proposals: publish }).eq('id', user.id)
    if (error) throw new Error(`profiles update: ${error.message}`)
    return NextResponse.json({ ...base(), ...(await loadIdentity(user.id)) }, { headers: NO_STORE })
  } catch (e) {
    console.error('[atproto] me PATCH failed:', describe(e))
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (isDidOnlyEmail(user.email)) {
    return NextResponse.json(
      { error: 'primary_identity', detail: 'This account signs in with its Bluesky identity; it cannot be unlinked.' },
      { status: 409 },
    )
  }
  try {
    const current = await loadIdentity(user.id)
    if (current.did) await unlinkDid(user.id, current.did)
    const res = NextResponse.json({ ...base(), ...(await loadIdentity(user.id)) }, { headers: NO_STORE })
    if (isAtprotoConfigured()) res.headers.append('Set-Cookie', clearSessionCookieHeader())
    return res
  } catch (e) {
    console.error('[atproto] me DELETE failed:', describe(e))
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
