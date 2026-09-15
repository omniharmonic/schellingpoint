import { NextResponse } from 'next/server'
import { sql, dbErrorResponse } from '@/lib/db'
import { assertSameOrigin, requireViewer, type Viewer } from '@/lib/auth/viewer'
import { publicUrl } from '@/lib/atproto/config'
import { validateProfilePatch } from './validate'

/**
 * The signed-in person's own profile (spec §7, §9): app-side, self-written, global across
 * gatherings. Nobody else writes it — no organizer, importer or CSV.
 *
 *   GET    → { profile }
 *   PATCH  { display_name?, bio?, affiliation?, building?, telegram?, avatar_url?, interests?,
 *            ens?, show_ens?, onboarding_completed? } → { profile }
 *
 * `ens` set here is unverified until POST /api/me/ens/verify; changing it clears a previous
 * verification (trigger `profiles_clear_ens_verification`). Unverified names are never shown
 * to anyone else.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const MAX_BODY_BYTES = 32 * 1024

export interface OwnProfile {
  id: string
  did: string
  handle: string | null
  email: string | null
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  affiliation: string | null
  building: string | null
  telegram: string | null
  interests: string[] | null
  ens: string | null
  ens_verified_at: string | null
  show_ens: boolean
  onboarding_completed: boolean
  publish_proposals: boolean
}

async function loadOwnProfile(viewer: Viewer): Promise<OwnProfile | null> {
  const rows = await sql<OwnProfile[]>`
    select p.id, a.did, a.handle, a.email,
           p.display_name, p.bio, p.avatar_url, p.affiliation, p.building, p.telegram, p.interests,
           p.ens, p.ens_verified_at, p.show_ens,
           coalesce(p.onboarding_completed, false) as onboarding_completed,
           p.publish_proposals
    from accounts a join profiles p on p.id = a.id
    where a.id = ${viewer.accountId}
  `
  return rows[0] ?? null
}

function appOrigin(): string | null {
  try {
    return new URL(publicUrl()).origin
  } catch {
    return null
  }
}

export async function GET(request: Request) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const profile = await loadOwnProfile(viewer)
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: NO_STORE })
  return NextResponse.json({ profile }, { headers: NO_STORE })
}

export async function PATCH(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const length = Number(request.headers.get('content-length') ?? '0')
  if (length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request too large' }, { status: 413, headers: NO_STORE })
  }
  let body: unknown
  try {
    const raw = await request.text()
    if (raw.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: 'Request too large' }, { status: 413, headers: NO_STORE })
    }
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: NO_STORE })
  }

  const current = await loadOwnProfile(viewer)
  if (!current) return NextResponse.json({ error: 'Profile not found' }, { status: 404, headers: NO_STORE })

  const result = validateProfilePatch(body, { appOrigin: appOrigin(), currentAvatarUrl: current.avatar_url })
  if (!result.ok) {
    return NextResponse.json({ error: result.error, field: result.field }, { status: 400, headers: NO_STORE })
  }
  const patch = result.value
  const has = (k: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, k)

  if (has('display_name') && patch.display_name === null) {
    return NextResponse.json({ error: 'Display name cannot be empty', field: 'display_name' }, { status: 400, headers: NO_STORE })
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ profile: current }, { headers: NO_STORE })

  try {
    // Every column is guarded by "was it in the body?" so a partial update leaves the rest alone.
    await sql`
      update profiles set
        display_name = case when ${has('display_name')} then ${patch.display_name ?? null}::text else display_name end,
        bio = case when ${has('bio')} then ${patch.bio ?? null}::text else bio end,
        affiliation = case when ${has('affiliation')} then ${patch.affiliation ?? null}::text else affiliation end,
        building = case when ${has('building')} then ${patch.building ?? null}::text else building end,
        telegram = case when ${has('telegram')} then ${patch.telegram ?? null}::text else telegram end,
        avatar_url = case when ${has('avatar_url')} then ${patch.avatar_url ?? null}::text else avatar_url end,
        interests = case when ${has('interests')} then ${patch.interests ?? null}::text[] else interests end,
        ens = case when ${has('ens')} then ${patch.ens ?? null}::text else ens end,
        show_ens = case when ${has('show_ens')} then ${patch.show_ens ?? false}::boolean else show_ens end,
        onboarding_completed = case when ${has('onboarding_completed')}
          then ${patch.onboarding_completed ?? false}::boolean else onboarding_completed end
      where id = ${viewer.accountId}
    `
  } catch (e) {
    const mapped = dbErrorResponse(e)
    if (mapped) return mapped
    console.error('[profile] update failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Could not save your profile' }, { status: 500, headers: NO_STORE })
  }

  return NextResponse.json({ profile: await loadOwnProfile(viewer) }, { headers: NO_STORE })
}
