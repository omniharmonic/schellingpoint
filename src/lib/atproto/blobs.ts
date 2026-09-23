import 'server-only'
/**
 * Avatar blobs (design §14 item 1).
 *
 * A profile record that carries an avatar needs the image IN THE REPO that owns the record: a
 * blob uploaded with that repo's own credential. This module is the only path to one, and it is
 * deliberately narrow:
 *
 *   SOURCE   bytes come from OUR upload store (`/uploads/<aa>/<sha256>.<ext>`, `src/lib/storage`)
 *            and nowhere else. A third-party CDN URL is never fetched and never re-published: a
 *            gathering's logo was uploaded here by an organiser, and a person's avatar is either
 *            their own upload or the copy `bsky-profile.ts` mirrored FROM THEIR OWN repo on
 *            import — theirs either way. Anything else returns null and the record stays text.
 *   SHAPE    re-encoded through sharp: 512², JPEG. `app.bsky.actor.profile.avatar` accepts only
 *            `image/png` and `image/jpeg` (the vendored lexicon), so the WebP the upload store
 *            keeps cannot be published as-is; JPEG satisfies the avatar field AND the link card's
 *            `image/*`. Anything over `BLOB_MAX_BYTES` (the lexicon's `maxSize`) is re-encoded
 *            smaller and then refused if it still does not fit.
 *   WRITE    the gathering's blob goes through the audited port (`upload-blob`, steward, a
 *            written reason, one audit row); a person's blob goes through their own custodial
 *            agent, exactly like their own profile record.
 *   CACHE    `at_blobs` maps (repo DID, sha256 of the uploaded bytes) → CID, so re-publishing a
 *            profile does not re-upload the same image on every run.
 *
 * Nothing here ever throws into a publish: every entry point answers `null` when the image is
 * missing, unreadable or refused, and the caller writes the record without an avatar.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { sql } from '@/lib/db'
import { resolveStoredPath } from '@/lib/storage/files'
import type { UploadedBlobRef } from './actor'
import { uploadBlobAsGathering } from './actors'
import { agentForAccount } from './agent'
import { paceRepoWrite, PDS_WRITE_POINTS } from './rate-limit'

export type { UploadedBlobRef }

/** `app.bsky.actor.profile.avatar` and `app.bsky.embed.external.thumb` both cap at 1 MB. */
export const BLOB_MAX_BYTES = 1_000_000
export const AVATAR_PX = 512
/** The two types the avatar field accepts; JPEG is what we produce. */
export const BLOB_MIME = 'image/jpeg'

/** Bytes of an image in our own upload store, or null (absent, foreign, or unreadable). */
export async function localImageBytes(url: string | null | undefined): Promise<Buffer | null> {
  const value = url?.trim()
  if (!value || !value.startsWith('/uploads/')) return null
  const stored = resolveStoredPath(value.slice('/uploads/'.length).split('/'))
  if (!stored) return null
  try {
    return await readFile(stored.file)
  } catch {
    return null
  }
}

/**
 * Re-encode an image for a repo blob: square cover at 512², JPEG, under the lexicon's cap.
 * Quality steps down once if the first pass is too big; null when it cannot be made to fit.
 */
export async function encodeAvatarBytes(input: Buffer): Promise<{ bytes: Buffer; mimeType: string } | null> {
  try {
    for (const quality of [82, 60, 40]) {
      const bytes = await sharp(input, { limitInputPixels: 16_000_000, animated: false })
        .rotate()
        .resize(AVATAR_PX, AVATAR_PX, { fit: 'cover', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer()
      if (bytes.byteLength <= BLOB_MAX_BYTES) return { bytes, mimeType: BLOB_MIME }
    }
  } catch {
    return null
  }
  return null
}

function hashOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function cached(did: string, sourceHash: string): Promise<UploadedBlobRef | null> {
  const [row] = await sql<{ cid: string; mime_type: string; size: number }[]>`
    select cid, mime_type, size from at_blobs where did = ${did} and source_hash = ${sourceHash}
  `
  return row ? { $type: 'blob', ref: { $link: row.cid }, mimeType: row.mime_type, size: row.size } : null
}

async function remember(input: { did: string; sourceHash: string; blob: UploadedBlobRef; purpose: string; eventId?: string | null }): Promise<void> {
  await sql`
    insert into at_blobs (did, source_hash, cid, mime_type, size, purpose, event_id)
    values (${input.did}, ${input.sourceHash}, ${input.blob.ref.$link}, ${input.blob.mimeType}, ${input.blob.size}, ${input.purpose}, ${input.eventId ?? null})
    on conflict (did, source_hash) do update set cid = excluded.cid, mime_type = excluded.mime_type, size = excluded.size
  `.catch(() => undefined)
}

export interface GatheringAvatarInput {
  eventId: string
  actorDid: string
  callerUserId: string | null
  /** `events.logo_url` — a path in our own upload store. */
  url: string | null | undefined
  reason: string
  purpose?: string
}

/**
 * The gathering's avatar blob, uploaded through the audited port and cached. `null` when there
 * is no usable logo, when the port refuses (a caller who is not a steward), or when the upload
 * fails — the profile record and the link card are then written without an image.
 */
export async function gatheringAvatarBlob(input: GatheringAvatarInput): Promise<UploadedBlobRef | null> {
  const source = await localImageBytes(input.url)
  if (!source) return null
  const encoded = await encodeAvatarBytes(source)
  if (!encoded) return null
  const sourceHash = hashOf(encoded.bytes)
  const hit = await cached(input.actorDid, sourceHash)
  if (hit) return hit
  try {
    const { blob } = await uploadBlobAsGathering(input.eventId, {
      callerUserId: input.callerUserId,
      bytes: encoded.bytes,
      mimeType: encoded.mimeType,
      reason: input.reason,
      purpose: input.purpose ?? 'gathering-avatar',
    })
    await remember({ did: input.actorDid, sourceHash, blob, purpose: input.purpose ?? 'gathering-avatar', eventId: input.eventId })
    return blob
  } catch (e) {
    console.warn('[atproto:blobs] gathering avatar not uploaded:', e instanceof Error ? e.name : 'error')
    return null
  }
}

/**
 * A custodial person's own avatar blob, uploaded with THEIR credential into THEIR repo. Only
 * from our upload store (their own upload, or the copy mirrored from their own Bluesky repo at
 * import): we never re-publish someone else's hosted image on their behalf.
 */
export async function personAvatarBlob(input: { accountId: string; did: string; url: string | null | undefined }): Promise<UploadedBlobRef | null> {
  const source = await localImageBytes(input.url)
  if (!source) return null
  const encoded = await encodeAvatarBytes(source)
  if (!encoded) return null
  const sourceHash = hashOf(encoded.bytes)
  const hit = await cached(input.did, sourceHash)
  if (hit) return hit
  try {
    const agent = await agentForAccount(input.accountId)
    const blob = await paceRepoWrite(input.did, PDS_WRITE_POINTS.create, async () => {
      const res = await agent.com.atproto.repo.uploadBlob(encoded.bytes, { encoding: encoded.mimeType })
      const ref = res.data.blob as unknown as { ref?: { $link?: string; toString(): string }; mimeType?: string; size?: number }
      const link = typeof ref?.ref?.$link === 'string' ? ref.ref.$link : ref?.ref?.toString()
      if (!link) throw new Error('uploadBlob returned no blob ref')
      return { $type: 'blob' as const, ref: { $link: link }, mimeType: ref.mimeType ?? encoded.mimeType, size: Number(ref.size ?? encoded.bytes.byteLength) }
    })
    await remember({ did: input.did, sourceHash, blob, purpose: 'person-avatar' })
    return blob
  } catch (e) {
    console.warn('[atproto:blobs] person avatar not uploaded:', e instanceof Error ? e.name : 'error')
    return null
  }
}
