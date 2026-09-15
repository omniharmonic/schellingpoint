/**
 * Mark the signed-in person's notifications read.
 *
 *   POST /api/me/notifications/read   { ids: string[] }  |  { all: true, event?: <slug> }
 *   → { updated: number }
 */
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { markRead } from '@/lib/notifications'
import { resolveEventScope } from '@/lib/notifications/scope'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const MAX_IDS = 200

function bad(error: string, field?: string): Response {
  return Response.json({ error, ...(field ? { field } : {}) }, { status: 400, headers: NO_STORE })
}

export async function POST(request: Request): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return bad('Invalid JSON body')
  }
  if (!body || typeof body !== 'object') return bad('Invalid JSON body')
  const input = body as { ids?: unknown; all?: unknown; event?: unknown; eventId?: unknown }

  if (input.all === true) {
    let eventId: string | null = null
    const slug = typeof input.event === 'string' ? input.event : null
    if (slug) {
      const scope = await resolveEventScope(slug, viewer.accountId)
      if (!scope) return Response.json({ updated: 0 }, { headers: NO_STORE })
      eventId = scope.id
    }
    const updated = await markRead(viewer.accountId, { all: true, eventId })
    return Response.json({ updated }, { headers: NO_STORE })
  }

  if (!Array.isArray(input.ids) || input.ids.length === 0) return bad('Provide ids or all: true', 'ids')
  if (input.ids.length > MAX_IDS) return bad(`At most ${MAX_IDS} ids per request`, 'ids')
  if (!input.ids.every((id) => typeof id === 'string')) return bad('ids must be strings', 'ids')
  const updated = await markRead(viewer.accountId, { ids: input.ids as string[] })
  return Response.json({ updated }, { headers: NO_STORE })
}
