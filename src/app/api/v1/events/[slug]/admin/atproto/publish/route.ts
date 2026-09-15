/**
 * POST /api/v1/events/[slug]/admin/atproto/publish   body { what }
 *
 * `what`: 'gathering' | 'policy' | 'venues' | 'tracks' | 'grids' | 'schedule' | 'all'. Owner/admin.
 * Every write goes through the gathering actor port (validated, R9-checked, audited, CAS'd);
 * per-record failures are reported in `results`, never thrown. Published sessions whose slot
 * changed come back as `skipped: 'requires-approval'` — move them through the approvals API.
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { atprotoErrorResponse } from '@/lib/atproto/http'
import {
  publishGathering,
  publishPolicy,
  publishSchedule,
  publishSlotGrids,
  publishTracks,
  publishVenues,
  type PublishOutput,
  type PublishResult,
} from '@/lib/atproto/publish'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const STEPS = {
  gathering: publishGathering,
  policy: publishPolicy,
  venues: publishVenues,
  tracks: publishTracks,
  grids: publishSlotGrids,
  schedule: publishSchedule,
} as const satisfies Record<string, (input: { eventId: string; callerUserId: string }) => Promise<PublishOutput>>
type Step = keyof typeof STEPS

/** 'all' runs in dependency order: venues/tracks before the grids and slots that reference them. */
const ALL_ORDER: Step[] = ['gathering', 'venues', 'tracks', 'grids', 'schedule']

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const denied = assertSameOrigin(request)
  if (denied) return denied
  const { slug } = await params
  const auth = await requireEventRole(request, slug, ['owner', 'admin'])
  if (auth instanceof Response) return auth
  if (!auth.event.actor_did) {
    return Response.json({ error: 'Create the gathering’s network identity before publishing.', code: 'GatheringNotLinked' }, { status: 409 })
  }
  const body = (await request.json().catch(() => null)) as { what?: unknown } | null
  const what = body?.what
  if (typeof what !== 'string' || !(what === 'all' || what in STEPS)) {
    return Response.json({ error: `what must be one of ${[...Object.keys(STEPS), 'all'].join(', ')}`, field: 'what' }, { status: 400 })
  }
  const input = { eventId: auth.event.id, callerUserId: auth.viewer.accountId }
  const results: PublishResult[] = []
  const steps = what === 'all' ? ALL_ORDER : [what as Step]
  try {
    for (const step of steps) results.push(...(await STEPS[step](input)).results)
  } catch (e) {
    return atprotoErrorResponse(e, 'admin/atproto/publish')
  }
  const published = results.filter((r) => !r.error && !r.skipped).length
  const skipped = results.filter((r) => r.skipped).length
  const failed = results.filter((r) => r.error).length
  return Response.json({ what, published, skipped, failed, results }, { headers: { 'Cache-Control': 'private, no-store' } })
}
