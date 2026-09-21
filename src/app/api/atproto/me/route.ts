import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isAtprotoConfigured, oauthMode } from '@/lib/atproto/config'
import { describe } from '@/lib/atproto/bridge'
import { PersonProfileError, publishPersonProfile, retractPersonProfile } from '@/lib/atproto/person-profile'
import { assertSameOrigin, getViewer, requireViewer, type Viewer } from '@/lib/auth/viewer'

/**
 * The signed-in member's ATProto identity.
 *
 *   GET     `{ configured, oauthMode, linked, did, handle, kind, owned, publishProposals,
 *             syncedFields, profileSyncedAt, publishProfile, profileRecordUri }`
 *           — also answers signed out (`linked: false`) so the login page can learn
 *           whether the Bluesky door is on. `syncedFields` / `profileSyncedAt`: which profile
 *           fields still mirror the network profile and when it was last read
 *           (`POST /api/atproto/me/resync` re-imports). `publishProfile` / `profileRecordUri`:
 *           the custodial opt-in to an `app.bsky.actor.profile` record in the person's own
 *           repo (release design §5.5) and the record it produced.
 *   PATCH   `{ publish_proposals?: boolean, publish_profile?: boolean }` (at least one)
 *           `publish_profile` is custodial-only (409 `not_custodial` for an OAuth account, 409
 *           `relink_atproto` once custody ended). `true` writes the record with the person's own
 *           credential before the flag is stored; `false` deletes it first. A PDS failure leaves
 *           the flag as it was and answers 502.
 *   DELETE  refused (409): every account IS its identity; there is nothing to unlink.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function base() {
  return { configured: isAtprotoConfigured(), oauthMode: oauthMode() }
}

async function loadIdentity(viewer: Viewer) {
  const rows = await sql<{
    owned_at: string | null; publish_proposals: boolean | null; synced_fields: string[] | null; profile_synced_at: string | null
    publish_profile: boolean | null; profile_record_uri: string | null
  }[]>`
    select a.owned_at, p.publish_proposals, p.synced_fields, p.profile_synced_at, p.publish_profile, p.profile_record_uri
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
    syncedFields: rows[0]?.synced_fields ?? [],
    profileSyncedAt: rows[0]?.profile_synced_at ?? null,
    publishProfile: Boolean(rows[0]?.publish_profile),
    profileRecordUri: rows[0]?.profile_record_uri ?? null,
  }
}

export async function GET(request: Request) {
  try {
    const viewer = await getViewer(request)
    if (!viewer) {
      return NextResponse.json(
        { ...base(), linked: false, did: null, handle: null, kind: null, owned: false, publishProposals: false, syncedFields: [], profileSyncedAt: null, publishProfile: false, profileRecordUri: null },
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
  const { publish_proposals: publish, publish_profile: publishProfile } =
    (body as { publish_proposals?: unknown; publish_profile?: unknown } | null) ?? {}
  if (publish !== undefined && typeof publish !== 'boolean') {
    return NextResponse.json({ error: 'publish_proposals must be boolean', field: 'publish_proposals' }, { status: 400 })
  }
  if (publishProfile !== undefined && typeof publishProfile !== 'boolean') {
    return NextResponse.json({ error: 'publish_profile must be boolean', field: 'publish_profile' }, { status: 400 })
  }
  if (publish === undefined && publishProfile === undefined) {
    return NextResponse.json({ error: 'publish_proposals or publish_profile is required' }, { status: 400 })
  }

  try {
    if (publish !== undefined) {
      await sql`update profiles set publish_proposals = ${publish} where id = ${viewer.accountId}`
    }
    if (publishProfile !== undefined) {
      if (viewer.kind !== 'custodial') {
        return NextResponse.json(
          { error: 'Only an account created here publishes its profile through this app; you manage your own profile where you signed up.', code: 'not_custodial' },
          { status: 409, headers: NO_STORE },
        )
      }
      try {
        if (publishProfile) {
          // The record goes out first, as the person, then the choice is stored: a PDS failure
          // leaves the flag off and the response honest.
          await publishPersonProfile(viewer.accountId, { requireOptIn: false })
          await sql`update profiles set publish_profile = true where id = ${viewer.accountId}`
        } else {
          await retractPersonProfile(viewer.accountId)
          await sql`update profiles set publish_profile = false where id = ${viewer.accountId}`
        }
      } catch (e) {
        if (e instanceof PersonProfileError) {
          return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: NO_STORE })
        }
        console.error('[atproto] profile record write failed:', describe(e))
        return NextResponse.json(
          { error: publishProfile ? 'Your profile record could not be written right now; nothing was changed.' : 'Your profile record could not be deleted right now; it is still published.', code: 'pds_unavailable' },
          { status: 502, headers: NO_STORE },
        )
      }
    }
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
