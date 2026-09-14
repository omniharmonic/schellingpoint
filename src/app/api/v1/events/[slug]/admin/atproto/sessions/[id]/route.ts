/**
 * POST /api/v1/events/[slug]/admin/atproto/sessions/[id]   body { action }
 *
 * `action`: 'cancel' | 'move' | 'republish' for one session's network records
 * (spec §6). cancel/move are destructive: the actor port requires owner/admin;
 * this route asks the same so a moderator sees 403 before any audit row.
 */
import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { createAdminClient } from '@/lib/supabase/server'
import { cancelSession, moveSession, republishSession } from '@/lib/atproto/publish'

const ACTIONS = { cancel: cancelSession, move: moveSession, republish: republishSession } as const
type Action = keyof typeof ACTIONS

export async function POST(request: Request, { params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await params
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = await createAdminClient()
  const { data: event } = await db.from('events').select('id, actor_did').eq('slug', slug).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const { data: member } = await db.from('event_members').select('role').eq('event_id', event.id).eq('user_id', user.id).maybeSingle()
  if (!member || !['owner', 'admin'].includes(member.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!event.actor_did) return NextResponse.json({ error: 'Connect a gathering account before publishing.' }, { status: 409 })

  const body = (await request.json().catch(() => null)) as { action?: unknown } | null
  const action = body?.action
  if (typeof action !== 'string' || !(action in ACTIONS)) {
    return NextResponse.json({ error: `action must be one of ${Object.keys(ACTIONS).join(', ')}` }, { status: 400 })
  }
  const { data: session } = await db.from('sessions').select('id').eq('id', id).eq('event_id', event.id).maybeSingle()
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  try {
    const { results } = await ACTIONS[action as Action]({ eventId: event.id as string, callerUserId: user.id, sessionId: id })
    const published = results.filter((r) => !r.error).length
    return NextResponse.json({ action, published, failed: results.length - published, results })
  } catch (err) {
    console.error(`[atproto] session ${action} failed:`, err)
    const status = (err as { status?: number }).status === 403 ? 403 : 500
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Network write failed' }, { status })
  }
}
