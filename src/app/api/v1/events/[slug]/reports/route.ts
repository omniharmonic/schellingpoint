/**
 * `POST /api/v1/events/[slug]/reports` — a member reports a session, a person or a comment.
 *
 * Members only: reporting is part of being in a gathering, and an anonymous report form on a
 * public page is a spam cannon. The report is private to this gathering's organizers from the
 * moment it is written — the subject is never told who filed it, and no other gathering can
 * read it (spec §8, §9).
 *
 * → 201 { id, status: 'open', duplicate }   · 400 bad input · 401 signed out
 * → 403 not a member · 404 no such subject in this gathering · 429 rate limited
 */
import { NextResponse } from 'next/server'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { ALL_ROLES } from '@/lib/scheduling/admin-api'
import {
  fileReport,
  isReportReason,
  isReportSubjectKind,
  MAX_REPORT_DETAILS,
  ReportError,
  ReportRateLimitedError,
} from '@/lib/moderation'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function fail(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const ctx = await requireEventRole(request, slug, ALL_ROLES)
  if (ctx instanceof Response) return ctx

  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return fail(400, 'Invalid JSON body')
  }

  if (!isReportSubjectKind(body.subjectKind)) return fail(400, 'Say what you are reporting.', { field: 'subjectKind' })
  if (!isReportReason(body.reason)) return fail(400, 'Choose a reason.', { field: 'reason' })
  if (body.details !== undefined && body.details !== null && typeof body.details !== 'string') {
    return fail(400, 'Extra detail must be text.', { field: 'details' })
  }
  if (typeof body.details === 'string' && body.details.length > MAX_REPORT_DETAILS) {
    return fail(400, `Keep the detail under ${MAX_REPORT_DETAILS} characters.`, { field: 'details' })
  }

  try {
    const filed = await fileReport({
      eventId: ctx.event.id,
      reporterAccountId: ctx.viewer.accountId,
      subjectKind: body.subjectKind,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      accountId: typeof body.accountId === 'string' ? body.accountId : null,
      ref: typeof body.ref === 'string' ? body.ref : null,
      reason: body.reason,
      details: typeof body.details === 'string' ? body.details : null,
    })
    return NextResponse.json(filed, { status: filed.duplicate ? 200 : 201, headers: NO_STORE })
  } catch (e) {
    if (e instanceof ReportRateLimitedError) {
      return NextResponse.json(
        { error: e.message, code: 'RateLimited' },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(e.retryAfterSeconds) } },
      )
    }
    if (e instanceof ReportError) return fail(e.status, e.message, { code: e.code })
    console.error('[reports] could not file a report:', e instanceof Error ? e.name : 'error')
    return fail(500, 'Your report could not be filed. Try again.')
  }
}
