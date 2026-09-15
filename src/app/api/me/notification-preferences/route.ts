/**
 * The signed-in person's notification preferences, globally or for one event.
 *
 *   GET /api/me/notification-preferences?event=<slug>
 *   → { scope: 'global' | 'event', preferences: EffectivePreference[] }
 *
 *   PUT /api/me/notification-preferences?event=<slug>
 *       { preferences: [{ category, email_enabled?, in_app_enabled?, push_enabled? }] }
 *   → same shape as GET
 */
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { getPreferences, setPreferences, type PreferenceUpdate } from '@/lib/notifications'
import { isNotificationCategory } from '@/lib/notifications/categories'
import { resolveEventScope } from '@/lib/notifications/scope'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const CHANNELS = ['email_enabled', 'in_app_enabled', 'push_enabled'] as const

async function scopeFrom(request: Request, accountId: string): Promise<{ eventId: string | null } | Response> {
  const slug = new URL(request.url).searchParams.get('event')
  if (!slug) return { eventId: null }
  const scope = await resolveEventScope(slug, accountId)
  if (!scope) return Response.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
  return { eventId: scope.id }
}

export async function GET(request: Request): Promise<Response> {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const scope = await scopeFrom(request, viewer.accountId)
  if (scope instanceof Response) return scope
  const preferences = await getPreferences(viewer.accountId, scope.eventId)
  return Response.json({ scope: scope.eventId ? 'event' : 'global', preferences }, { headers: NO_STORE })
}

export async function PUT(request: Request): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const scope = await scopeFrom(request, viewer.accountId)
  if (scope instanceof Response) return scope

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }
  const list = (body as { preferences?: unknown } | null)?.preferences
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) {
    return Response.json({ error: 'preferences must be a non-empty array', field: 'preferences' }, { status: 400, headers: NO_STORE })
  }

  const updates: PreferenceUpdate[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || !isNotificationCategory((item as { category?: unknown }).category)) {
      return Response.json({ error: 'Unknown notification category', field: 'category' }, { status: 400, headers: NO_STORE })
    }
    const entry = item as Record<string, unknown>
    const update: PreferenceUpdate = { category: entry.category as PreferenceUpdate['category'] }
    for (const channel of CHANNELS) {
      if (entry[channel] === undefined) continue
      if (typeof entry[channel] !== 'boolean') {
        return Response.json({ error: `${channel} must be a boolean`, field: channel }, { status: 400, headers: NO_STORE })
      }
      update[channel] = entry[channel] as boolean
    }
    updates.push(update)
  }

  const preferences = await setPreferences(viewer.accountId, scope.eventId, updates)
  return Response.json({ scope: scope.eventId ? 'event' : 'global', preferences }, { headers: NO_STORE })
}
