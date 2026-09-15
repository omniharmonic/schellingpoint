import 'server-only'
/**
 * Image storage on the app's own disk (plan §7.2 "Uploads"): `UPLOADS_DIR` (`/data/uploads`
 * in the container; `.uploads/` locally), content-addressed as `<aa>/<sha256>.<ext>`, served
 * by `GET /uploads/<aa>/<sha256>.<ext>` with an immutable cache header.
 *
 * Only raster images whose magic bytes match an allowed type are accepted; the declared
 * MIME type and file name are ignored. SVG is refused (it is a document that can run script).
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

export type ImageKind = 'png' | 'jpg' | 'gif' | 'webp'

export const CONTENT_TYPES: Readonly<Record<ImageKind, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** `aa/<64 hex>.<ext>` — the only shape a stored path can have. */
export const STORED_PATH_RE = /^([0-9a-f]{2})\/([0-9a-f]{64})\.(png|jpg|gif|webp)$/

export function uploadsDir(): string {
  const configured = process.env.UPLOADS_DIR?.trim()
  return path.resolve(configured || path.join(process.cwd(), '.uploads'))
}

/** Identify an image by its first bytes. */
export function sniffImage(bytes: Uint8Array): ImageKind | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b)
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return 'jpg'
  if (bytes.length >= 6 && (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return 'gif'
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'webp'
  return null
}

export interface StoredUpload {
  /** Public path, served from the app origin (works on gathering subdomains too). */
  url: string
  path: string
  contentType: string
  bytes: number
  created: boolean
}

/** Store `bytes` under its content hash. Idempotent: the same image yields the same URL. */
export async function storeImage(bytes: Uint8Array, kind: ImageKind): Promise<StoredUpload> {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const relative = `${hash.slice(0, 2)}/${hash}.${kind}`
  const root = uploadsDir()
  const target = path.join(root, relative)
  const result = { url: `/uploads/${relative}`, path: relative, contentType: CONTENT_TYPES[kind], bytes: bytes.byteLength }

  try {
    await stat(target)
    return { ...result, created: false }
  } catch {
    // not stored yet
  }
  await mkdir(path.dirname(target), { recursive: true })
  // Write beside the target and rename, so a reader never sees a partial file.
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o644 })
    await rename(temp, target)
  } catch (e) {
    await unlink(temp).catch(() => {})
    throw e
  }
  return { ...result, created: true }
}

/** Absolute file path for a public `/uploads/...` path, or null when it is not a stored shape. */
export function resolveStoredPath(segments: readonly string[]): { file: string; kind: ImageKind } | null {
  const joined = segments.join('/')
  const match = STORED_PATH_RE.exec(joined)
  if (!match || match[2].slice(0, 2) !== match[1]) return null
  return { file: path.join(uploadsDir(), joined), kind: match[3] as ImageKind }
}
