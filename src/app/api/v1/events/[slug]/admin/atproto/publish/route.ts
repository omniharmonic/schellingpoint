/**
 * POST /api/v1/events/[slug]/admin/atproto/publish   body { what }
 *
 * `what`: 'gathering' | 'venues' | 'tracks' | 'grids' | 'schedule' | 'all'.
 * Owner/admin. Every write goes through the gathering actor port (audited);
 * per-record failures are reported in `results`, never thrown.
 */
import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { createAdminClient } from '@/lib/supabase/server'
import {
  publishGathering,
  publishSchedule,
  publishSlotGrids,
  publishTracks,
  publishVenues,
  type PublishOutput,
  type PublishResult,
} from '@/lib/atproto/publish'

const WHAT = ['gathering', 'venues', 'tracks', 'grids', 'schedule', 'all'] as const
type What = (typeof WHAT)[number]

const STEPS: Record<Exclude<What, 'all'>, (input: { eventId: string; callerUserId: string }) => Promise<PublishOutput>> = {
  gathering: publishGathering,
  venues: publishVenues,
  tracks: publishTracks,
  grids: publishSlotGrids,
  schedule: publishSchedule,
}

/** 'all' runs in dependency order: venues/tracks before grids and slots that reference them. */
const ALL_ORDER: Array<Exclude<What, 'all'>> = ['gathering', 'venues', 'tracks', 'grids', 'schedule']

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const db = await createAdminClient()
  const { data: event } = await db.from('events').select('id, actor_did').eq('slug', slug).maybeSingle()
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const { data: member } = await db.from('event_members').select('role').eq('event_id', event.id).eq('user_id', user.id).maybeSingle()
  if (!member || !['owner', 'admin'].includes(member.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  if (!event.actor_did) return NextResponse.json({ error: 'Connect a gathering account before publishing.' }, { status: 409 })

  const body = (await request.json().catch(() => null)) as { what?: unknown } | null
  const what = body?.what
  if (typeof what !== 'string' || !(WHAT as readonly string[]).includes(what)) {
    return NextResponse.json({ error: `what must be one of ${WHAT.join(', ')}` }, { status: 400 })
  }

  const input = { eventId: event.id as string, callerUserId: user.id }
  const results: PublishResult[] = []
  const steps = what === 'all' ? ALL_ORDER : [what as Exclude<What, 'all'>]
  for (const step of steps) {
    try {
      results.push(...(await STEPS[step](input)).results)
    } catch (err) {
      console.error(`[atproto] publish ${step} failed:`, err)
      results.push({ kind: step === 'grids' ? 'slot-grid' : step === 'schedule' ? 'slot' : step === 'venues' ? 'venue' : step === 'tracks' ? 'track' : 'gathering', id: event.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const published = results.filter((r) => !r.error).length
  const failed = results.length - published
  return NextResponse.json({ what, published, failed, results })
}
