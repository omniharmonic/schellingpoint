import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'

/**
 * /api/v1/events/[slug]/sessions/[id]/resources
 *
 * GET    -> list resources (anyone who can view the session)
 * POST   -> add a resource (host, cohost, or event organizer)
 * PATCH  -> edit one resource, or reorder via { order: [id, ...] }
 * DELETE -> ?id=<resourceId> remove a resource
 */

const ORGANIZER_ROLES = ['owner', 'admin', 'moderator']
const RESOURCE_KINDS = ['slides', 'recording', 'notes', 'link', 'repo'] as const
type ResourceKind = (typeof RESOURCE_KINDS)[number]

const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 2048
const RESOURCE_SELECT = 'id, session_id, title, url, kind, display_order, added_by, created_at'

type RouteParams = { params: Promise<{ slug: string; id: string }> }

interface Context {
  supabase: Awaited<ReturnType<typeof createAdminClient>>
  sessionId: string
  eventId: string
  userId: string | null
  canManage: boolean
}

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
    .select('id, event_id, host_id, status')
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

  const eventReadable =
    (['public', 'unlisted'].includes(event.visibility) && event.status !== 'draft') ||
    (!!role && (event.status !== 'draft' || ['owner', 'admin'].includes(role)))
  const sessionVisible =
    ['approved', 'scheduled'].includes(session.status) || canManage
  if (!eventReadable || !sessionVisible) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  return { supabase, sessionId: session.id, eventId: session.event_id, userId: user?.id ?? null, canManage }
}

function requireManager(ctx: Context): NextResponse | null {
  if (!ctx.userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!ctx.canManage) return NextResponse.json({ error: 'Only the session host or event organizers can manage resources' }, { status: 403 })
  return null
}

function validateUrl(value: unknown): string | NextResponse {
  if (typeof value !== 'string' || !value.trim()) {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 })
  }
  const url = value.trim()
  if (url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: 'URL must start with http:// or https://' }, { status: 400 })
  }
  try {
    new URL(url)
  } catch {
    return NextResponse.json({ error: 'URL is not valid' }, { status: 400 })
  }
  return url
}

function validateTitle(value: unknown): string | NextResponse {
  if (typeof value !== 'string' || !value.trim()) {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 })
  }
  const title = value.trim()
  if (title.length > MAX_TITLE_LENGTH) {
    return NextResponse.json({ error: `Title must be ${MAX_TITLE_LENGTH} characters or fewer` }, { status: 400 })
  }
  return title
}

function validateKind(value: unknown): ResourceKind | NextResponse {
  if (value == null) return 'link'
  if (typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value)) {
    return value as ResourceKind
  }
  return NextResponse.json({ error: `Kind must be one of: ${RESOURCE_KINDS.join(', ')}` }, { status: 400 })
}

async function readJson(request: Request): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    return body as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof NextResponse) return ctx

  const { data, error } = await ctx.supabase
    .from('session_resources')
    .select(RESOURCE_SELECT)
    .eq('session_id', ctx.sessionId)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Failed to load resources:', error)
    return NextResponse.json({ error: 'Failed to load resources' }, { status: 500 })
  }

  return NextResponse.json({ resources: data ?? [], can_manage: ctx.canManage })
}

export async function POST(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof NextResponse) return ctx
  const denied = requireManager(ctx)
  if (denied) return denied

  const body = await readJson(request)
  if (body instanceof NextResponse) return body

  const title = validateTitle(body.title)
  if (title instanceof NextResponse) return title
  const url = validateUrl(body.url)
  if (url instanceof NextResponse) return url
  const kind = validateKind(body.kind)
  if (kind instanceof NextResponse) return kind

  // Append at the end of the current list
  const { data: last } = await ctx.supabase
    .from('session_resources')
    .select('display_order')
    .eq('session_id', ctx.sessionId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle()
  const displayOrder = (last?.display_order ?? -1) + 1

  const { data, error } = await ctx.supabase
    .from('session_resources')
    .insert({
      event_id: ctx.eventId,
      session_id: ctx.sessionId,
      added_by: ctx.userId,
      title,
      url,
      kind,
      display_order: displayOrder,
    })
    .select(RESOURCE_SELECT)
    .single()

  if (error) {
    console.error('Failed to add resource:', error)
    return NextResponse.json({ error: 'Failed to add resource' }, { status: 500 })
  }

  return NextResponse.json({ resource: data }, { status: 201 })
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof NextResponse) return ctx
  const denied = requireManager(ctx)
  if (denied) return denied

  const body = await readJson(request)
  if (body instanceof NextResponse) return body

  // Reorder: { order: [resourceId, ...] }
  if (Array.isArray(body.order)) {
    const order = body.order
    if (!order.every((v) => typeof v === 'string')) {
      return NextResponse.json({ error: 'order must be an array of resource ids' }, { status: 400 })
    }
    const { data: existing } = await ctx.supabase
      .from('session_resources')
      .select('id')
      .eq('session_id', ctx.sessionId)
    const known = new Set((existing ?? []).map((r: { id: string }) => r.id))
    const ids = (order as string[]).filter((rid) => known.has(rid))

    const results = await Promise.all(
      ids.map((rid, index) =>
        ctx.supabase
          .from('session_resources')
          .update({ display_order: index })
          .eq('id', rid)
          .eq('session_id', ctx.sessionId)
      )
    )
    const failed = results.find((r) => r.error)
    if (failed?.error) {
      console.error('Failed to reorder resources:', failed.error)
      return NextResponse.json({ error: 'Failed to reorder resources' }, { status: 500 })
    }
  } else {
    // Edit a single resource: { id, title?, url?, kind? }
    if (typeof body.id !== 'string') {
      return NextResponse.json({ error: 'id is required' }, { status: 400 })
    }
    const updates: { title?: string; url?: string; kind?: ResourceKind } = {}
    if (body.title !== undefined) {
      const title = validateTitle(body.title)
      if (title instanceof NextResponse) return title
      updates.title = title
    }
    if (body.url !== undefined) {
      const url = validateUrl(body.url)
      if (url instanceof NextResponse) return url
      updates.url = url
    }
    if (body.kind !== undefined) {
      const kind = validateKind(body.kind)
      if (kind instanceof NextResponse) return kind
      updates.kind = kind
    }
    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('session_resources')
      .update(updates)
      .eq('id', body.id)
      .eq('session_id', ctx.sessionId)
      .select(RESOURCE_SELECT)
      .maybeSingle()
    if (error) {
      console.error('Failed to update resource:', error)
      return NextResponse.json({ error: 'Failed to update resource' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
    }
  }

  const { data: resources, error } = await ctx.supabase
    .from('session_resources')
    .select(RESOURCE_SELECT)
    .eq('session_id', ctx.sessionId)
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) {
    console.error('Failed to load resources:', error)
    return NextResponse.json({ error: 'Failed to load resources' }, { status: 500 })
  }

  return NextResponse.json({ resources: resources ?? [] })
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof NextResponse) return ctx
  const denied = requireManager(ctx)
  if (denied) return denied

  const resourceId = new URL(request.url).searchParams.get('id')
  if (!resourceId) {
    return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 })
  }

  const { data, error } = await ctx.supabase
    .from('session_resources')
    .delete()
    .eq('id', resourceId)
    .eq('session_id', ctx.sessionId)
    .select('id')
    .maybeSingle()

  if (error) {
    console.error('Failed to delete resource:', error)
    return NextResponse.json({ error: 'Failed to delete resource' }, { status: 500 })
  }
  if (!data) {
    return NextResponse.json({ error: 'Resource not found' }, { status: 404 })
  }

  return NextResponse.json({ success: true })
}
