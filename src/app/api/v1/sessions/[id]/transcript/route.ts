import { sql } from '@/lib/db'
import { assertSameOrigin } from '@/lib/auth/viewer'
import {
  canSeeSession,
  json,
  jsonError,
  loadSessionEventAccess,
  sessionRelation,
  type EventAccess,
  type SessionRelation,
} from '@/app/api/v1/sessions/_lib/access'
import {
  MAX_TRANSCRIPT_BYTES,
  decodeUtf8,
  detectFormat,
  normalizeTranscript,
  wordCount,
} from '@/lib/knowledge/normalize'
import {
  canReadTranscript,
  currentTranscript,
  deleteCurrentTranscript,
  editSummary,
  MAX_SUMMARY_CHARS,
  readTier,
  saveTranscript,
  type TranscriptRow,
  type TranscriptVisibility,
} from '@/lib/knowledge/store'

/**
 * /api/v1/sessions/[id]/transcript  (design §10.1)
 *
 * GET     → the session's current transcript for the viewer's tier (members of the gathering, or
 *           organizers only when the gathering or the transcript says so). `?download=1` streams
 *           it as Markdown. Non-members: 401 / 403 — transcripts are never public.
 * POST    → attach or replace the transcript: host, co-host or organizer; `consent: true` is
 *           required; the gathering's `transcripts_enabled` must be on (409 otherwise).
 *           multipart/form-data (`file`, `consent`, `language?`, `visibility?`) or JSON
 *           (`text`, `format?`, `consent`, `language?`, `visibility?`). 5 MB, text only.
 * PATCH   → edit the generated summary (design §10.3): ORGANIZERS only, `{ summary }`. Members
 *           then read the edited text, not the generated one; `summary_edited_at/_by` record who
 *           stands behind it. An empty summary clears it.
 * DELETE  → remove the current transcript (same people).
 *
 * Transcripts are never records: nothing here touches a repo.
 */

export const runtime = 'nodejs'

type RouteParams = { params: Promise<{ id: string }> }

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

interface Context {
  access: EventAccess
  rel: SessionRelation
  enabled: boolean
  eventVisibility: TranscriptVisibility
  canManage: boolean
}

async function loadContext(request: Request, sessionId: string): Promise<Context | Response> {
  const access = await loadSessionEventAccess(request, sessionId)
  if (access instanceof Response) return access
  const rel = await sessionRelation(sql, sessionId, access.event.id, access.viewer?.accountId ?? null)
  if (!rel || !canSeeSession(rel, access)) return jsonError(404, 'Session not found')
  const [policy] = await sql<{ transcripts_enabled: boolean; transcripts_visibility: TranscriptVisibility }[]>`
    select transcripts_enabled, transcripts_visibility from events where id = ${access.event.id}
  `
  return {
    access,
    rel,
    enabled: policy?.transcripts_enabled ?? true,
    eventVisibility: policy?.transcripts_visibility ?? 'members',
    canManage: rel.isHost || rel.isCohost || access.isOrganizer,
  }
}

function requireManager(request: Request, ctx: Context): Response | null {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  if (!ctx.access.viewer) return jsonError(401, 'Unauthorized')
  if (!ctx.canManage) return jsonError(403, 'Only the session host, co-hosts or organizers can manage its transcript')
  return null
}

function publicRow(row: TranscriptRow) {
  const { uploaded_by: _uploadedBy, ...rest } = row
  return rest
}

export async function GET(request: Request, { params }: RouteParams) {
  const { id } = await params
  const ctx = await loadContext(request, id)
  if (ctx instanceof Response) return ctx
  const tier = readTier(ctx.access.role)
  const base = { enabled: ctx.enabled, visibility: ctx.eventVisibility, tier, can_manage: ctx.canManage, can_edit_summary: ctx.access.isOrganizer }
  if (!ctx.access.viewer) return jsonError(401, 'Sign in to read transcripts')
  if (!tier) return jsonError(403, 'Transcripts are for members of this gathering')

  const transcript = await currentTranscript(sql, id)
  if (!transcript) return json({ ...base, transcript: null })
  if (!canReadTranscript(tier, ctx.eventVisibility, transcript.visibility)) {
    // A member may know a transcript exists (the host attached it) but not read it.
    return json({ ...base, transcript: null, restricted: true })
  }
  const url = new URL(request.url)
  if (url.searchParams.get('download') === '1') {
    const filename = `${ctx.rel.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'transcript'}-transcript.md`
    return new Response(`# ${ctx.rel.title}\n\n${transcript.content}\n`, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }
  return json({ ...base, transcript: { ...publicRow(transcript), text: transcript.content, word_count: wordCount(transcript.content) } })
}

interface Submission {
  raw: string
  format: ReturnType<typeof detectFormat>
  consent: boolean
  language: string | null
  visibility: unknown
  source: 'upload' | 'paste'
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === '1'
}

function cleanLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v) ? v : null
}

async function readSubmission(request: Request): Promise<Submission | Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_TRANSCRIPT_BYTES + 64 * 1024) return jsonError(413, 'Transcripts are limited to 5 MB')
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return jsonError(400, 'Invalid upload')
    }
    const file = form.get('file')
    if (!(file instanceof File)) return jsonError(400, 'Attach a transcript file', { field: 'file' })
    if (file.size > MAX_TRANSCRIPT_BYTES) return jsonError(413, 'Transcripts are limited to 5 MB', { field: 'file' })
    const format = detectFormat(file.name, form.get('format'))
    if (!format) return jsonError(400, 'Upload a .txt, .md, .vtt or .srt file', { field: 'file' })
    const bytes = new Uint8Array(await file.arrayBuffer())
    return {
      raw: decodeUtf8(bytes),
      format,
      consent: truthy(form.get('consent')),
      language: cleanLanguage(form.get('language')),
      visibility: form.get('visibility'),
      source: 'upload',
    }
  }
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > MAX_TRANSCRIPT_BYTES * 1.5) return jsonError(413, 'Transcripts are limited to 5 MB')
    body = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  if (typeof body.text !== 'string' || !body.text.trim()) return jsonError(400, 'Paste the transcript text', { field: 'text' })
  if (Buffer.byteLength(body.text, 'utf8') > MAX_TRANSCRIPT_BYTES) return jsonError(413, 'Transcripts are limited to 5 MB', { field: 'text' })
  const format = detectFormat(typeof body.filename === 'string' ? body.filename : null, body.format) ?? 'txt'
  return {
    raw: body.text,
    format,
    consent: truthy(body.consent),
    language: cleanLanguage(body.language),
    visibility: body.visibility,
    source: 'paste',
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const { id } = await params
  const ctx = await loadContext(request, id)
  if (ctx instanceof Response) return ctx
  const denied = requireManager(request, ctx)
  if (denied) return denied
  if (!ctx.enabled) return jsonError(409, 'Transcripts are turned off for this gathering', { code: 'TranscriptsDisabled' })

  const submission = await readSubmission(request)
  if (submission instanceof Response) return submission
  if (!submission.consent) {
    return jsonError(400, 'Confirm that everyone in the room was told the session was being recorded or transcribed', { field: 'consent' })
  }
  const normalized = normalizeTranscript(submission.raw, submission.format!)
  if (!normalized.paragraphs.length) return jsonError(400, 'The transcript has no readable text', { field: submission.source === 'upload' ? 'file' : 'text' })

  // A transcript can be narrower than the gathering's default tier, never wider.
  const requested = submission.visibility === 'organizers' || submission.visibility === 'members' ? submission.visibility : ctx.eventVisibility
  const visibility: TranscriptVisibility = ctx.eventVisibility === 'organizers' ? 'organizers' : requested

  const saved = await saveTranscript({
    eventId: ctx.access.event.id,
    sessionId: id,
    uploadedBy: ctx.access.viewer!.accountId,
    source: submission.source,
    language: submission.language,
    visibility,
    normalized,
  })
  return json(
    {
      transcript: { ...publicRow(saved.transcript), text: normalized.text, word_count: normalized.wordCount },
      chunks: saved.chunks,
      embed_queued: saved.embedQueued,
    },
    { status: 201 },
  )
}

/** Organizer edit of the summary. The transcript itself is never edited: only its summary. */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { id } = await params
  const ctx = await loadContext(request, id)
  if (ctx instanceof Response) return ctx
  const bad = assertSameOrigin(request)
  if (bad) return bad
  if (!ctx.access.viewer) return jsonError(401, 'Unauthorized')
  if (!ctx.access.isOrganizer) return jsonError(403, 'Only organizers can edit a session summary')

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  if (!('summary' in body) || (body.summary !== null && typeof body.summary !== 'string')) {
    return jsonError(400, 'Send the summary text (or null to clear it)', { field: 'summary' })
  }
  if (typeof body.summary === 'string' && body.summary.length > MAX_SUMMARY_CHARS) {
    return jsonError(400, `Summaries are limited to ${MAX_SUMMARY_CHARS} characters`, { field: 'summary' })
  }
  const updated = await editSummary({ sessionId: id, summary: body.summary, editedBy: ctx.access.viewer.accountId })
  if (!updated) return jsonError(404, 'This session has no transcript')
  return json({ transcript: publicRow(updated) })
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { id } = await params
  const ctx = await loadContext(request, id)
  if (ctx instanceof Response) return ctx
  const denied = requireManager(request, ctx)
  if (denied) return denied
  const removed = await deleteCurrentTranscript(id)
  if (!removed) return jsonError(404, 'This session has no transcript')
  return json({ success: true })
}
