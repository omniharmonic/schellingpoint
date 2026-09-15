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
 * swallowed. Callers fire-and-forget.
 */
import { sql } from '@/lib/db'
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
    if (typeof data.did !== 'string' || typeof data.handle !== 'string') return null
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

  const rows = await sql<{ display_name: string | null; avatar_url: string | null; bio: string | null }[]>`
    select display_name, avatar_url, bio from profiles where id = ${userId}
  `
  const current = rows[0]
  if (!current) return { updated: [] }

  const name = current.display_name?.trim() ?? ''
  const nameIsEmpty = !name || (opts.placeholderName ? name === opts.placeholderName : false)
  const displayName = nameIsEmpty && remote.displayName ? remote.displayName : null
  const avatar = !current.avatar_url?.trim() && remote.avatar ? remote.avatar : null
  const bio = !current.bio?.trim() && remote.description ? remote.description : null

  const updated = [
    ...(displayName ? ['display_name'] : []),
    ...(avatar ? ['avatar_url'] : []),
    ...(bio ? ['bio'] : []),
  ]
  if (updated.length === 0) return { updated }
  try {
    await sql`
      update profiles set
        display_name = coalesce(${displayName}, display_name),
        avatar_url = coalesce(${avatar}, avatar_url),
        bio = coalesce(${bio}, bio)
      where id = ${userId}
    `
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
