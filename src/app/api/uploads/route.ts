import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { canRolePerform } from '@/lib/permissions'
import { isHiddenEvent } from '@/lib/events'
import { MAX_UPLOAD_BYTES, sniffImage, storeImage } from '@/lib/storage/files'
import type { EventRoleName } from '@/types/event'

/**
 * POST /api/uploads  multipart/form-data: file, and one of
 *
 *   event=<slug|id>   an event asset (logo, banner); the viewer must be one of its organizers
 *                     (owner/admin). ≤ 5 MB.
 *   purpose=avatar    the signed-in account's own profile photo (package G's SettingsModal /
 *                     OnboardingModal). Any signed-in account, rate-limited. ≤ 2 MB.
 *   (neither)         the creation wizard, before the gathering exists: any signed-in
 *                     account, rate-limited. ≤ 5 MB.
 *
 *   file              PNG, JPEG, GIF or WebP by magic bytes (the declared type is ignored).
 *
 * → 201 { url }  (`/uploads/<aa>/<sha256>.<ext>`, content-addressed and immutable)
 */

export const runtime = 'nodejs'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Per-account ceilings for uploads not tied to an existing gathering, per hour. */
const LIMITS = { draft: 20, avatar: 10 } as const
const WINDOW_MS = 60 * 60 * 1000
const AVATAR_MAX_BYTES = 2 * 1024 * 1024
type Bucket = Map<string, number[]>
const g = globalThis as typeof globalThis & { __unconferenceUploadBuckets?: Bucket }
const buckets: Bucket = (g.__unconferenceUploadBuckets ??= new Map())

function allow(kind: keyof typeof LIMITS, accountId: string): boolean {
  const key = `${kind}:${accountId}`
  const now = Date.now()
  const recent = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= LIMITS[kind]) {
    buckets.set(key, recent)
    return false
  }
  recent.push(now)
  buckets.set(key, recent)
  return true
}

const err = (status: number, error: string, code?: string) =>
  NextResponse.json(code ? { error, code } : { error }, { status, headers: NO_STORE })

export async function POST(request: Request) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  // Refuse obviously oversized bodies before reading them (multipart overhead allowed).
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return err(413, 'Images can be at most 5 MB.', 'TooLarge')
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return err(400, 'Send the image as multipart/form-data with a "file" field.', 'InvalidBody')
  }

  const eventRef = form.get('event')
  const purpose = form.get('purpose')
  if ((eventRef !== null && typeof eventRef !== 'string') || (purpose !== null && typeof purpose !== 'string')) {
    return err(400, '"event" and "purpose" must be text fields.', 'InvalidBody')
  }
  const hasEvent = typeof eventRef === 'string' && eventRef.trim() !== ''
  const purposeValue = typeof purpose === 'string' ? purpose.trim() : ''
  if (purposeValue && purposeValue !== 'avatar') return err(400, 'Unknown upload purpose.', 'InvalidBody')
  if (purposeValue === 'avatar' && hasEvent) return err(400, 'A profile photo does not belong to an event.', 'InvalidBody')

  // Check the file before spending a rate-limit slot on it.
  const file = form.get('file')
  if (!file || typeof file === 'string') return err(400, 'Choose an image to upload.', 'MissingFile')
  if (file.size === 0) return err(400, 'That file is empty.', 'EmptyFile')
  const cap = purposeValue === 'avatar' ? AVATAR_MAX_BYTES : MAX_UPLOAD_BYTES
  if (file.size > cap) return err(413, `Images can be at most ${cap / (1024 * 1024)} MB.`, 'TooLarge')

  if (hasEvent) {
    const ref = (eventRef as string).trim()
    const [event] = UUID.test(ref)
      ? await sql<{ id: string; status: string; visibility: string }[]>`select id, status, visibility from events where id = ${ref}`
      : await sql<{ id: string; status: string; visibility: string }[]>`select id, status, visibility from events where slug = ${ref}`
    const [member] = event
      ? await sql<{ role: EventRoleName }[]>`select role from event_members where event_id = ${event.id} and user_id = ${viewer.accountId}`
      : []
    if (!event || (isHiddenEvent(event) && !member)) return err(404, 'Event not found')
    if (!member || !canRolePerform(member.role, 'editEventSettings')) {
      return err(403, 'Only this event’s organizers can upload its images.')
    }
  } else if (!allow(purposeValue === 'avatar' ? 'avatar' : 'draft', viewer.accountId)) {
    return err(429, 'Too many uploads. Try again in a little while.', 'RateLimited')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  const kind = sniffImage(bytes)
  if (!kind) return err(415, 'Upload a PNG, JPEG, GIF or WebP image.', 'UnsupportedType')

  try {
    const stored = await storeImage(bytes, kind)
    return NextResponse.json({ url: stored.url }, { status: 201, headers: NO_STORE })
  } catch (e) {
    console.error('[uploads] store failed:', e)
    return err(500, 'The image could not be saved. Try again.')
  }
}
