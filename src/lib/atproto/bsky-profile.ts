import 'server-only'
/**
 * The person's network profile → local `profiles` row (release design §5).
 *
 * Where it comes from, in order:
 *   1. `app.bsky.actor.profile` at `self` in the person's OWN repo, read from their PDS
 *      (`com.atproto.repo.getRecord`); the avatar blob comes from `com.atproto.sync.getBlob` there.
 *      The PDS URL is named by the DID document (attacker-influenced), so it is dialled only through
 *      `serviceForDid` + `safeFetch`; our own PDS is reached internally.
 *   2. The public Bluesky AppView (`app.bsky.actor.getProfile`) when the PDS read fails.
 * Both paths cross-check the DID.
 *
 * What it writes: `display_name`, `avatar_url` (mirrored through `storeImage`), `bio` — into fields
 * that are blank OR still network-owned (`profiles.synced_fields`). A field the person edited in
 * the app (PATCH /api/me/profile drops it from `synced_fields`) is left alone until they ask for
 * a re-sync (`resyncProfile`, POST /api/atproto/me/resync), which re-imports all three.
 *
 * Best-effort and bounded: failures are logged and swallowed; sign-in never waits on the network
 * for longer than a short grace period (`oauth/callback`), the rest finishes in the background.
 */
import { sql } from '@/lib/db'
import sharp from 'sharp'
import { storeImage } from '@/lib/storage/files'
import { safeFetch } from '@/lib/net/safe-fetch'
import { resolveDidDoc } from './identity'
import { NSID } from './nsids'
import { fetchForService, serviceForDid } from './service-url'

const PUBLIC_APPVIEW = 'https://public.api.bsky.app'
const TIMEOUT_MS = 5000

export const SYNCED_PROFILE_FIELDS = ['display_name', 'avatar_url', 'bio'] as const
export type SyncedProfileField = (typeof SYNCED_PROFILE_FIELDS)[number]

export interface BskyProfile {
  did: string
  /** From the DID document (PDS path) or the AppView; null when the document names none. */
  handle: string | null
  displayName: string | null
  /** Where the avatar bytes are (a PDS `getBlob` URL or an AppView CDN URL); mirrored, never stored. */
  avatar: string | null
  description: string | null
  /** True when `avatar` points at OUR PDS through its internal URL (operator configuration, plain fetch). */
  avatarInternal?: boolean
  source?: 'pds' | 'appview'
}

function cleanText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** The CID of a blob reference in JSON form (`{ ref: { $link } }`, or the legacy `{ cid }`). */
function blobCid(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const blob = value as { ref?: unknown; cid?: unknown }
  const ref = blob.ref as { $link?: unknown } | string | undefined
  if (ref && typeof ref === 'object' && typeof ref.$link === 'string') return ref.$link
  if (typeof ref === 'string') return ref
  if (typeof blob.cid === 'string') return blob.cid
  return null
}

/**
 * `app.bsky.actor.profile@self` from the person's own PDS. Null when the DID does not resolve, the
 * PDS is unreachable or unsafe, or there is no such record. `handle` comes from the DID document.
 */
export async function fetchActorProfile(did: string, opts: { handle?: string | null } = {}): Promise<BskyProfile | null> {
  if (!did.startsWith('did:')) return null
  try {
    const doc = await resolveDidDoc(did)
    const service = await serviceForDid(did)
    const fetch = fetchForService(service)
    const url = new URL(`${service.url}/xrpc/com.atproto.repo.getRecord`)
    url.searchParams.set('repo', did)
    url.searchParams.set('collection', NSID.actorProfile)
    url.searchParams.set('rkey', 'self')
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const data = (await res.json()) as { uri?: unknown; value?: unknown }
    if (typeof data.uri !== 'string' || !data.uri.startsWith(`at://${did}/${NSID.actorProfile}/`)) return null
    if (!data.value || typeof data.value !== 'object') return null
    const value = data.value as Record<string, unknown>
    if (value.$type !== undefined && value.$type !== NSID.actorProfile) return null
    const avatarCid = blobCid(value.avatar)
    let avatar: string | null = null
    if (avatarCid) {
      const blob = new URL(`${service.url}/xrpc/com.atproto.sync.getBlob`)
      blob.searchParams.set('did', did)
      blob.searchParams.set('cid', avatarCid)
      avatar = blob.toString()
    }
    return {
      did,
      handle: opts.handle ?? doc.handle,
      displayName: cleanText(value.displayName),
      avatar,
      description: cleanText(value.description),
      avatarInternal: service.internal,
      source: 'pds',
    }
  } catch {
    return null
  }
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
      displayName: cleanText(data.displayName),
      avatar: typeof data.avatar === 'string' && data.avatar ? data.avatar : null,
      description: cleanText(data.description),
      avatarInternal: false,
      source: 'appview',
    }
  } catch {
    return null
  }
}

/** The person's own PDS record first, the AppView as fallback. */
export async function fetchNetworkProfile(did: string, opts: { handle?: string | null } = {}): Promise<BskyProfile | null> {
  return (await fetchActorProfile(did, opts)) ?? (await fetchBskyProfile(did))
}

export interface ImportOptions {
  /** The display name we set at account creation (the handle's first label); counts as blank. */
  placeholderName?: string | null
  /** Re-import every field, whether or not the person edited it here (explicit re-sync). */
  force?: boolean
}

export interface ImportResult {
  /** Fields whose stored value changed. */
  updated: SyncedProfileField[]
  /** Fields now network-owned (after this import). */
  synced: SyncedProfileField[]
  /** False when nothing could be read from the network (the row is untouched). */
  fetched: boolean
}

const NOTHING: ImportResult = { updated: [], synced: [], fetched: false }

/** Read the network profile and apply it (see module doc). Never throws. */
export async function importBskyProfile(userId: string, did: string, opts: ImportOptions = {}): Promise<ImportResult> {
  try {
    const remote = await fetchNetworkProfile(did)
    if (!remote) return NOTHING
    return await applyBskyProfile(userId, remote, opts)
  } catch (e) {
    console.warn('[atproto] profile import failed:', e instanceof Error ? e.message : String(e))
    return NOTHING
  }
}

/** Re-import all three fields regardless of local edits and rebuild `synced_fields`. */
export async function resyncProfile(userId: string, did: string): Promise<ImportResult> {
  return importBskyProfile(userId, did, { force: true })
}

/** Download, normalise (rotate, 512² cover, WebP) and mirror an avatar; null on any failure. */
async function mirrorAvatar(remote: BskyProfile): Promise<string | null> {
  if (!remote.avatar) return null
  try {
    const fetch = remote.avatarInternal ? globalThis.fetch : safeFetch
    const response = await fetch(remote.avatar, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!response.ok) return null
    const bytes = await response.arrayBuffer()
    const normalized = await sharp(Buffer.from(bytes), { limitInputPixels: 16_000_000, animated: false })
      .rotate().resize(512, 512, { fit: 'cover', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer()
    return (await storeImage(normalized, 'webp')).url
  } catch {
    return null // A broken avatar does not prevent name/bio import or sign-in.
  }
}

/**
 * Apply a network profile to `profiles.id = userId` (an `accounts.id`).
 *
 * A field is written when the network has a value for it and it is network-owned: blank, listed in
 * `synced_fields`, the creation placeholder (display name only), or `force`. Every write is a
 * compare-and-swap against the values read first, so an edit made during the fetch wins, and the
 * row must belong to `remote.did`. `synced_fields` afterwards = fields written now (whose CAS held)
 * plus, unless `force`, fields that were already synced. `profile_synced_at` is stamped on success.
 */
export async function applyBskyProfile(userId: string, remote: BskyProfile, opts: ImportOptions = {}): Promise<ImportResult> {
  const rows = await sql<{
    display_name: string | null
    avatar_url: string | null
    bio: string | null
    onboarding_completed: boolean | null
    synced_fields: string[] | null
  }[]>`
    select display_name, avatar_url, bio, onboarding_completed, synced_fields from profiles where id = ${userId}
  `
  const current = rows[0]
  if (!current) return NOTHING
  const force = opts.force === true
  const synced = new Set(current.synced_fields ?? [])
  const owned = (field: SyncedProfileField, blank: boolean) => force || blank || synced.has(field)

  const name = current.display_name?.trim() ?? ''
  const nameIsPlaceholder = !!opts.placeholderName && name === opts.placeholderName
  const writeName = !!remote.displayName && owned('display_name', !name || nameIsPlaceholder)
  const writeBio = !!remote.description && owned('bio', !current.bio?.trim())
  const avatarOwned = !!remote.avatar && owned('avatar_url', !current.avatar_url?.trim())
  const avatar = avatarOwned ? await mirrorAvatar(remote) : null
  const writeAvatar = avatar !== null

  const displayName = writeName ? remote.displayName : null
  const bio = writeBio ? remote.description : null

  let saved
  try {
    saved = await sql<{ display_name: string | null; avatar_url: string | null; bio: string | null; synced_fields: string[] }[]>`
      update profiles set
        display_name = case when display_name is not distinct from ${current.display_name} then coalesce(${displayName}, display_name) else display_name end,
        avatar_url = case when avatar_url is not distinct from ${current.avatar_url} then coalesce(${avatar}, avatar_url) else avatar_url end,
        bio = case when bio is not distinct from ${current.bio} then coalesce(${bio}, bio) else bio end,
        synced_fields = array_remove(array[
          case when (${writeName} and display_name is not distinct from ${current.display_name})
                 or (not ${force} and 'display_name' = any(synced_fields)) then 'display_name'::text end,
          case when (${writeAvatar} and avatar_url is not distinct from ${current.avatar_url})
                 or (not ${force} and 'avatar_url' = any(synced_fields)) then 'avatar_url'::text end,
          case when (${writeBio} and bio is not distinct from ${current.bio})
                 or (not ${force} and 'bio' = any(synced_fields)) then 'bio'::text end
        ], null),
        profile_synced_at = now()
      where id = ${userId} and exists (select 1 from accounts where id = ${userId} and did = ${remote.did})
      returning display_name, avatar_url, bio, synced_fields
    `
  } catch (e) {
    console.warn('[atproto] profile import write failed:', e instanceof Error ? e.message : String(e))
    return NOTHING
  }
  const after = saved[0]
  if (!after) return NOTHING
  const updated: SyncedProfileField[] = []
  if (after.display_name !== current.display_name) updated.push('display_name')
  if (after.avatar_url !== current.avatar_url) updated.push('avatar_url')
  if (after.bio !== current.bio) updated.push('bio')
  return { updated, synced: after.synced_fields as SyncedProfileField[], fetched: true }
}

/** Fire-and-forget wrapper: never throws, never awaited by the caller. */
export function importBskyProfileInBackground(userId: string, did: string, opts: ImportOptions = {}): void {
  void importBskyProfile(userId, did, opts).catch((e) => {
    console.warn('[atproto] bsky profile import failed:', e instanceof Error ? e.message : String(e))
  })
}
