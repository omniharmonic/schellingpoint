/**
 * Tracks of an event.
 *   GET  /api/v1/events/[slug]/admin/tracks            tracks with session counts and skill URIs
 *   POST /api/v1/events/[slug]/admin/tracks            create { name, color?, description?, skill_uris? }
 *   PUT  /api/v1/events/[slug]/admin/tracks            reorder { order: [trackId, …] } (every track, once)
 *
 * `skill_uris` are at:// URIs of freeschool.draft.skill records from the shared taxonomy (spec §4.1).
 */
import { asAccount, sql } from '@/lib/db'
import { InputError, errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith, rolesWithAny } from '@/lib/scheduling/admin-api'
import { validateSkillUris } from '@/lib/atproto/skills'
import { parseTrack } from '@/lib/scheduling/inputs'
import { loadEvent, selectTracks, syncProgramRecords } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const READ_ROLES = rolesWithAny('manageTracks', 'manageSchedule', 'approveProposals', 'manageTrackSessions')
const WRITE_ROLES = rolesWith('manageTracks')

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, READ_ROLES)
  if (ctx instanceof Response) return ctx
  try {
    return json({ tracks: await selectTracks(sql, ctx.event.id) })
  } catch (e) {
    return errorResponse(e, 'list tracks')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, WRITE_ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    // Skills must exist in the shared taxonomy (package F's authority index), not merely look like URIs.
    const skills = await validateSkillUris(body.skill_uris, 20)
    if (!skills.ok) return fail(400, skills.error, { field: 'skill_uris' })
    const input = parseTrack({ ...body, skill_uris: skills.uris })
    const track = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [{ next }] = await tx<{ next: number }[]>`
        select coalesce(max(display_order), -1)::int + 1 as next from tracks where event_id = ${ctx.event.id}
      `
      const [row] = await tx<{ id: string }[]>`
        insert into tracks ${tx({ ...input, event_id: ctx.event.id, display_order: next })} returning id
      `
      const [created] = await selectTracks(tx, ctx.event.id, row.id)
      return created
    })
    const network = await syncProgramRecords('tracks', await loadEvent(ctx.event.id), ctx.viewer.accountId)
    return json({ track, network }, { status: 201 })
  } catch (e) {
    return errorResponse(e, 'create track')
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, WRITE_ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    const order = body.order
    if (!Array.isArray(order) || !order.every(isUuid) || new Set(order).size !== order.length) {
      return fail(400, 'order must list each track id once', { field: 'order' })
    }
    const tracks = await asAccount(ctx.viewer.accountId, async (tx) => {
      const existing = await tx<{ id: string }[]>`
        select id from tracks where event_id = ${ctx.event.id} order by id for update
      `
      const ids = new Set(existing.map((t) => t.id))
      if (existing.length !== order.length || !order.every((id) => ids.has(id))) {
        throw new InputError('The track list changed. Refresh and try again.', 'order', 409, 'StaleOrder')
      }
      const rows = order.map((id, index) => ({ id, display_order: index }))
      await tx`
        update tracks set display_order = v.display_order::int
        from (values ${tx(rows.map((r) => [r.id, r.display_order]))}) as v(id, display_order)
        where tracks.id = v.id::uuid and tracks.event_id = ${ctx.event.id}
      `
      return selectTracks(tx, ctx.event.id)
    })
    return json({ tracks })
  } catch (e) {
    return errorResponse(e, 'reorder tracks')
  }
}
