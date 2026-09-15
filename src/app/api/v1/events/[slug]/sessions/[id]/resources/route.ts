import { sql, tx } from '@/lib/db'
import { assertSameOrigin } from '@/lib/auth/viewer'
import {
  canSeeSession,
  isUuid,
  json,
  jsonError,
  loadEventAccess,
  readJsonObject,
  sessionRelation,
} from '@/app/api/v1/sessions/_lib/access'

/**
 * /api/v1/events/[slug]/sessions/[id]/resources
 *
 * GET    -> list resources (anyone who can see the session)
 * POST   -> add a resource (host, co-host, or event organizer)
 * PATCH  -> edit one resource, or reorder via { order: [id, ...] }
 * DELETE -> ?id=<resourceId> remove a resource
 *
 * `added_by` is never returned: who attached a link is not other people's business (R9).
 */

const RESOURCE_KINDS = ['slides', 'recording', 'notes', 'link', 'repo'] as const
type ResourceKind = (typeof RESOURCE_KINDS)[number]
const MAX_TITLE_LENGTH = 200
const MAX_URL_LENGTH = 2048

type RouteParams = { params: Promise<{ slug: string; id: string }> }

interface Resource {
  id: string
  session_id: string
  title: string
  url: string
  kind: ResourceKind
  display_order: number
  created_at: string
}

interface Context {
  eventId: string
  sessionId: string
  accountId: string | null
  canManage: boolean
}

async function loadContext(request: Request, slug: string, sessionId: string): Promise<Context | Response> {
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  if (!isUuid(sessionId)) return jsonError(404, 'Session not found')
  const accountId = access.viewer?.accountId ?? null
  const rel = await sessionRelation(sql, sessionId, access.event.id, accountId)
  if (!rel || !canSeeSession(rel, access)) return jsonError(404, 'Session not found')
  return {
    eventId: access.event.id,
    sessionId: rel.id,
    accountId,
    canManage: rel.isHost || rel.isCohost || access.isOrganizer,
  }
}

function requireManager(request: Request, ctx: Context): Response | null {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  if (!ctx.accountId) return jsonError(401, 'Unauthorized')
  if (!ctx.canManage) return jsonError(403, 'Only the session host or event organizers can manage resources')
  return null
}

function validateUrl(value: unknown): string | Response {
  if (typeof value !== 'string' || !value.trim()) return jsonError(400, 'URL is required', { field: 'url' })
  const url = value.trim()
  if (url.length > MAX_URL_LENGTH || !/^https?:\/\//i.test(url)) {
    return jsonError(400, 'URL must start with http:// or https://', { field: 'url' })
  }
  try {
    new URL(url)
  } catch {
    return jsonError(400, 'URL is not valid', { field: 'url' })
  }
  return url
}

function validateTitle(value: unknown): string | Response {
  if (typeof value !== 'string' || !value.trim()) return jsonError(400, 'Title is required', { field: 'title' })
  const title = value.trim()
  if (title.length > MAX_TITLE_LENGTH) {
    return jsonError(400, `Title must be ${MAX_TITLE_LENGTH} characters or fewer`, { field: 'title' })
  }
  return title
}

function validateKind(value: unknown): ResourceKind | Response {
  if (value == null) return 'link'
  if (typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value)) return value as ResourceKind
  return jsonError(400, `Kind must be one of: ${RESOURCE_KINDS.join(', ')}`, { field: 'kind' })
}

function listResources(sessionId: string) {
  return sql<Resource[]>`
    select id, session_id, title, url, kind, display_order, created_at
    from session_resources
    where session_id = ${sessionId}
    order by display_order asc, created_at asc
  `
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof Response) return ctx
  return json({ resources: await listResources(ctx.sessionId), can_manage: ctx.canManage })
}

export async function POST(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof Response) return ctx
  const denied = requireManager(request, ctx)
  if (denied) return denied

  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  const title = validateTitle(body.title)
  if (title instanceof Response) return title
  const url = validateUrl(body.url)
  if (url instanceof Response) return url
  const kind = validateKind(body.kind)
  if (kind instanceof Response) return kind

  const resource = await tx(async (t) => {
    const [count] = await t<{ n: number; max: number | null }[]>`
      select count(*)::int as n, max(display_order) as max from session_resources where session_id = ${ctx.sessionId}
    `
    if ((count?.n ?? 0) >= 50) return null
    const [row] = await t<Resource[]>`
      insert into session_resources (event_id, session_id, added_by, title, url, kind, display_order)
      values (${ctx.eventId}, ${ctx.sessionId}, ${ctx.accountId}, ${title}, ${url}, ${kind}, ${(count?.max ?? -1) + 1})
      returning id, session_id, title, url, kind, display_order, created_at
    `
    return row
  })
  if (!resource) return jsonError(409, 'A session can hold at most 50 resources')
  return json({ resource }, { status: 201 })
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof Response) return ctx
  const denied = requireManager(request, ctx)
  if (denied) return denied

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  if (Array.isArray(body.order)) {
    const order = body.order
    if (!order.every((v) => typeof v === 'string')) {
      return jsonError(400, 'order must be an array of resource ids', { field: 'order' })
    }
    await tx(async (t) => {
      const existing = await t<{ id: string }[]>`select id from session_resources where session_id = ${ctx.sessionId}`
      const known = new Set(existing.map((r) => r.id))
      const ids = (order as string[]).filter((rid) => known.has(rid))
      for (const [index, rid] of ids.entries()) {
        await t`update session_resources set display_order = ${index} where id = ${rid} and session_id = ${ctx.sessionId}`
      }
    })
  } else {
    if (!isUuid(body.id)) return jsonError(400, 'id is required', { field: 'id' })
    const updates: Record<string, string> = {}
    if (body.title !== undefined) {
      const title = validateTitle(body.title)
      if (title instanceof Response) return title
      updates.title = title
    }
    if (body.url !== undefined) {
      const url = validateUrl(body.url)
      if (url instanceof Response) return url
      updates.url = url
    }
    if (body.kind !== undefined) {
      const kind = validateKind(body.kind)
      if (kind instanceof Response) return kind
      updates.kind = kind
    }
    const keys = Object.keys(updates)
    if (keys.length === 0) return jsonError(400, 'Nothing to update')
    const rows = await sql`
      update session_resources set ${sql(updates, keys as never)}
      where id = ${body.id} and session_id = ${ctx.sessionId}
      returning id
    `
    if (!rows.length) return jsonError(404, 'Resource not found')
  }

  return json({ resources: await listResources(ctx.sessionId) })
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const ctx = await loadContext(request, slug, id)
  if (ctx instanceof Response) return ctx
  const denied = requireManager(request, ctx)
  if (denied) return denied

  const resourceId = new URL(request.url).searchParams.get('id')
  if (!isUuid(resourceId)) return jsonError(400, 'id query parameter is required', { field: 'id' })

  const rows = await sql`
    delete from session_resources where id = ${resourceId} and session_id = ${ctx.sessionId} returning id
  `
  if (!rows.length) return jsonError(404, 'Resource not found')
  return json({ success: true })
}
