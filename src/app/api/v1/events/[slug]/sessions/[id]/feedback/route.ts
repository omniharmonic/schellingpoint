import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'

/**
 * /api/v1/events/[slug]/sessions/[id]/feedback
 *
 * GET    -> aggregate summary (public), the caller's own feedback (signed in),
 *           and the full list for session hosts/cohosts and event organizers.
 * POST   -> upsert the caller's feedback (only once the session has started)
 * DELETE -> remove the caller's feedback
 */

const ORGANIZER_ROLES = ['owner', 'admin', 'moderator']
const MAX_COMMENT_LENGTH = 2000

type RouteParams = { params: Promise<{ slug: string; id: string }> }

interface SessionRow {
  id: string
  event_id: string
  host_id: string | null
  status: string
  is_self_hosted: boolean | null
  self_hosted_start_time: string | null
  time_slot: { start_time: string } | { start_time: string }[] | null
}

interface Context {
  supabase: Awaited<ReturnType<typeof createAdminClient>>
  session: SessionRow
  userId: string | null
  role: string | null
  isOrganizer: boolean
  isHost: boolean
  canManage: boolean
  startedAt: string | null
  feedbackOpen: boolean
}

function unwrap<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value
}

/**
 * Resolve event + session and the caller's relationship to them.
 * Returns a NextResponse when the request should be rejected.
 */
async function loadContext(
  request: Request,
  slug: string,
  sessionId: string
): Promise<Context | NextResponse> {
  const supabase = await createAdminClient()
  const user = await getUserFromRequest(request)

  const { data: event } = await supabase
    .from('events')
    .select('id, visibility, status')
    .eq('slug', slug)
    .single()
  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const { data: session } = await supabase
    .from('sessions')
    .select('id, event_id, host_id, status, is_self_hosted, self_hosted_start_time, time_slot:time_slots(start_time)')
    .eq('id', sessionId)
    .eq('event_id', event.id)
    .single()
  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  let role: string | null = null
  let isCohost = false
  if (user) {
    const [{ data: membership }, { data: cohost }] = await Promise.all([
      supabase
        .from('event_members')
        .select('role')
        .eq('event_id', event.id)
        .eq('user_id', user.id)
        .maybeSingle(),
      supabase
        .from('session_cohosts')
        .select('id')
        .eq('session_id', session.id)
        .eq('user_id', user.id)
        .maybeSingle(),
    ])
    role = membership?.role ?? null
    isCohost = !!cohost
  }

  const isOrganizer = !!role && ORGANIZER_ROLES.includes(role)
  const isHost = !!user && (session.host_id === user.id || isCohost)
  const canManage = isOrganizer || isHost

  // Mirror the event visibility boundary + session visibility policies.
  const eventReadable =
    (['public', 'unlisted'].includes(event.visibility) && event.status !== 'draft') ||
    (!!role && (event.status !== 'draft' || ['owner', 'admin'].includes(role)))
  const sessionVisible =
    ['approved', 'scheduled'].includes(session.status) || canManage
  if (!eventReadable || !sessionVisible) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const slot = unwrap(session.time_slot as SessionRow['time_slot'])
  const startedAt =
    session.status !== 'scheduled'
      ? null
      : session.is_self_hosted
        ? session.self_hosted_start_time
        : slot?.start_time ?? null
  const feedbackOpen = !!startedAt && new Date(startedAt).getTime() <= Date.now()

  return {
    supabase,
    session: session as SessionRow,
    userId: user?.id ?? null,
    role,
    isOrganizer,
    isHost,
    canManage,
    startedAt,
    feedbackOpen,
  }
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof NextResponse) return ctx

  const { supabase, session, userId, isOrganizer, canManage } = ctx

  const summaryPromise = supabase.rpc('session_feedback_summary', { target_session: session.id })
  const ownPromise = userId
    ? supabase
        .from('session_feedback')
        .select('id, rating, comment, would_attend_again, created_at, updated_at')
        .eq('session_id', session.id)
        .eq('user_id', userId)
        .maybeSingle()
    : Promise.resolve({ data: null, error: null })
  const listPromise = canManage
    ? supabase
        .from('session_feedback')
        .select(
          isOrganizer
            ? 'id, rating, comment, would_attend_again, created_at, user:profiles!user_id(id, display_name, avatar_url)'
            : 'id, rating, comment, would_attend_again, created_at'
        )
        .eq('session_id', session.id)
        .order('created_at', { ascending: false })
    : Promise.resolve({ data: null, error: null })

  const [summaryRes, ownRes, listRes] = await Promise.all([summaryPromise, ownPromise, listPromise])

  if (summaryRes.error) {
    console.error('session_feedback_summary failed:', summaryRes.error)
    return NextResponse.json({ error: 'Failed to load feedback' }, { status: 500 })
  }
  if (ownRes.error || listRes.error) {
    console.error('feedback fetch failed:', ownRes.error || listRes.error)
    return NextResponse.json({ error: 'Failed to load feedback' }, { status: 500 })
  }

  const summaryRow = unwrap(summaryRes.data as { avg_rating: number | string | null; count: number | null }[] | null)
  const summary = {
    avg_rating: summaryRow?.avg_rating != null ? Number(summaryRow.avg_rating) : null,
    count: summaryRow?.count ?? null,
  }

  return NextResponse.json({
    summary,
    own: ownRes.data ?? null,
    // Hosts see comments anonymously; organizers see who wrote them.
    feedback: canManage ? (listRes.data ?? []) : undefined,
    feedback_open: ctx.feedbackOpen,
    started_at: ctx.startedAt,
    can_manage: canManage,
    is_organizer: isOrganizer,
  })
}

export async function POST(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof NextResponse) return ctx

  const { supabase, session, userId, role, feedbackOpen } = ctx
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!role) {
    return NextResponse.json({ error: 'Join the event before leaving feedback' }, { status: 403 })
  }
  if (!feedbackOpen) {
    return NextResponse.json({ error: 'Feedback opens once the session has started' }, { status: 403 })
  }

  let body: { rating?: unknown; comment?: unknown; would_attend_again?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rating = Number(body.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return NextResponse.json({ error: 'Rating must be an integer from 1 to 5' }, { status: 400 })
  }

  let comment: string | null = null
  if (body.comment != null) {
    if (typeof body.comment !== 'string') {
      return NextResponse.json({ error: 'Comment must be a string' }, { status: 400 })
    }
    comment = body.comment.trim() || null
    if (comment && comment.length > MAX_COMMENT_LENGTH) {
      return NextResponse.json({ error: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer` }, { status: 400 })
    }
  }

  let wouldAttendAgain: boolean | null = null
  if (body.would_attend_again != null) {
    if (typeof body.would_attend_again !== 'boolean') {
      return NextResponse.json({ error: 'would_attend_again must be a boolean' }, { status: 400 })
    }
    wouldAttendAgain = body.would_attend_again
  }

  const { data, error } = await supabase
    .from('session_feedback')
    .upsert(
      {
        event_id: session.event_id,
        session_id: session.id,
        user_id: userId,
        rating,
        comment,
        would_attend_again: wouldAttendAgain,
      },
      { onConflict: 'session_id,user_id' }
    )
    .select('id, rating, comment, would_attend_again, created_at, updated_at')
    .single()

  if (error) {
    // The DB trigger is the backstop for the time window check.
    if (error.code === '23514') {
      return NextResponse.json({ error: error.message }, { status: 403 })
    }
    console.error('Failed to save feedback:', error)
    return NextResponse.json({ error: 'Failed to save feedback' }, { status: 500 })
  }

  return NextResponse.json({ own: data })
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof NextResponse) return ctx

  const { supabase, session, userId } = ctx
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { error } = await supabase
    .from('session_feedback')
    .delete()
    .eq('session_id', session.id)
    .eq('user_id', userId)

  if (error) {
    console.error('Failed to delete feedback:', error)
    return NextResponse.json({ error: 'Failed to delete feedback' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
