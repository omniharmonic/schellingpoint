import 'server-only'
/**
 * Public Bluesky profile → local `profiles` row.
 *
 * On first sign-in through the Bluesky door we borrow the display name, avatar and bio from
 * the account's public AppView profile so a new member is not called
 * `did-plc-…`. This never overwrites a value the member already has — the
 * only exception is a display name that is still the placeholder we set
 * ourselves at creation (the handle), which the real display name may replace.
 *
 * Read-only, unauthenticated, and best-effort: any failure is logged and
 * swallowed. Sign-in awaits the bounded import before rendering onboarding.
 */
import { sql } from '@/lib/db'
import sharp from 'sharp'
import { storeImage } from '@/lib/storage/files'
import { safeFetch } from '@/lib/net/safe-fetch'

const PUBLIC_APPVIEW = 'https://public.api.bsky.app'
const TIMEOUT_MS = 5000

export interface BskyProfile {
  did: string
  handle: string
  displayName: string | null
  avatar: string | null
  description: string | null
}

/** `app.bsky.actor.getProfile` on the public AppView. Null when unavailable. */
export async function fetchBskyProfile(actor: string): Promise<BskyProfile | null> {
  const url = `${PUBLIC_APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`
  try {
    const res = await safeFetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    if (typeof data.did !== 'string' || typeof data.handle !== 'string' || (actor.startsWith('did:') && data.did !== actor)) return null
    return {
      did: data.did,
      handle: data.handle,
      displayName: typeof data.displayName === 'string' && data.displayName.trim() ? data.displayName.trim() : null,
      avatar: typeof data.avatar === 'string' && data.avatar ? data.avatar : null,
      description: typeof data.description === 'string' && data.description.trim() ? data.description.trim() : null,
    }
  } catch {
    return null
  }
}

/**
 * Fill empty `display_name` / `avatar_url` / `bio` on `profiles.id = userId` (an `accounts.id`)
 * from the DID's public profile. `placeholderName` (the handle we set at
 * account creation) counts as empty for `display_name` only.
 */
export async function importBskyProfile(
  userId: string,
  did: string,
  opts: { placeholderName?: string | null } = {},
): Promise<{ updated: string[] }> {
  const remote = await fetchBskyProfile(did)
  if (!remote) return { updated: [] }

  return applyBskyProfile(userId, remote, opts)
}

/** Fill missing fields atomically; a profile edit made during the remote fetch always wins. */
export async function applyBskyProfile(
  userId: string,
  remote: BskyProfile,
  opts: { placeholderName?: string | null } = {},
): Promise<{ updated: string[] }> {
  const rows = await sql<{ display_name: string | null; avatar_url: string | null; bio: string | null; onboarding_completed: boolean }[]>`
    select display_name, avatar_url, bio, onboarding_completed from profiles where id = ${userId}
  `
  const current = rows[0]
  if (!current) return { updated: [] }

  const name = current.display_name?.trim() ?? ''
  const nameIsEmpty = !name || (!current.onboarding_completed && opts.placeholderName ? name === opts.placeholderName : false)
  const displayName = nameIsEmpty && remote.displayName ? remote.displayName : null
  let avatar: string | null = null
  if (!current.avatar_url?.trim() && remote.avatar) {
    try {
      const response = await safeFetch(remote.avatar, { signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (response.ok) {
        const bytes = await response.arrayBuffer()
        const normalized = await sharp(Buffer.from(bytes), { limitInputPixels: 16_000_000, animated: false })
          .rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
        avatar = (await storeImage(normalized, 'webp')).url
      }
    } catch { /* A broken avatar does not prevent name/bio import or sign-in. */ }
  }
  const bio = !current.bio?.trim() && remote.description ? remote.description : null

  const updated = [
    ...(displayName ? ['display_name'] : []),
    ...(avatar ? ['avatar_url'] : []),
    ...(bio ? ['bio'] : []),
  ]
  if (updated.length === 0) return { updated }
  try {
    const saved = await sql`
      update profiles set
        display_name = case when display_name is not distinct from ${current.display_name} then coalesce(${displayName}, display_name) else display_name end,
        avatar_url = case when avatar_url is not distinct from ${current.avatar_url} then coalesce(${avatar}, avatar_url) else avatar_url end,
        bio = case when bio is not distinct from ${current.bio} then coalesce(${bio}, bio) else bio end
      where id = ${userId} and exists (select 1 from accounts where id = ${userId} and did = ${remote.did})
    `
    if (!saved.count) return { updated: [] }
  } catch {
    return { updated: [] }
  }
  return { updated }
}

/** Fire-and-forget wrapper: never throws, never awaited by the caller. */
export function importBskyProfileInBackground(
  userId: string,
  did: string,
  opts: { placeholderName?: string | null } = {},
): void {
  void importBskyProfile(userId, did, opts).catch((e) => {
    console.warn('[atproto] bsky profile import failed:', e instanceof Error ? e.message : String(e))
  })
}
