/**
 * One track.
 *   PATCH  /api/v1/events/[slug]/admin/tracks/[id]   partial update (name, color, description, is_active, max_sessions, skill_uris)
 *   DELETE /api/v1/events/[slug]/admin/tracks/[id]   sessions in it keep existing, without a track
 */
import { asAccount } from '@/lib/db'
import { errorResponse, fail, isUuid, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { validateSkillUris } from '@/lib/atproto/skills'
import { parseTrack, type TrackInput } from '@/lib/scheduling/inputs'
import { loadEvent, selectTracks, syncProgramRecords } from '@/lib/scheduling/program'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageTracks')

type Params = { params: Promise<{ slug: string; id: string }> }

export async function PATCH(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Track not found')
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    let update = body
    if (Object.prototype.hasOwnProperty.call(body, 'skill_uris')) {
      const skills = await validateSkillUris(body.skill_uris, 20)
      if (!skills.ok) return fail(400, skills.error, { field: 'skill_uris' })
      update = { ...body, skill_uris: skills.uris }
    }
    const track = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [current] = await tx<TrackInput[]>`
        select name, slug, description, color, coalesce(is_active, true) as is_active, max_sessions, skill_uris
        from tracks where id = ${id} and event_id = ${ctx.event.id} for update
      `
      if (!current) return null
      const next = parseTrack(update, current)
      await tx`update tracks set ${tx(next)} where id = ${id} and event_id = ${ctx.event.id}`
      const [updated] = await selectTracks(tx, ctx.event.id, id)
      return updated
    })
    if (!track) return fail(404, 'Track not found')
    const network = await syncProgramRecords('tracks', await loadEvent(ctx.event.id), ctx.viewer.accountId)
    return json({ track, network })
  } catch (e) {
    return errorResponse(e, 'update track')
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { slug, id } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  if (!isUuid(id)) return fail(404, 'Track not found')

  try {
    const deleted = await asAccount(ctx.viewer.accountId, async (tx) => {
      const [row] = await tx<{ id: string; session_count: number }[]>`
        select tr.id, (select count(*)::int from sessions s where s.event_id = tr.event_id and s.track_id = tr.id) as session_count
        from tracks tr where tr.id = ${id} and tr.event_id = ${ctx.event.id} for update
      `
      if (!row) return null
      await tx`update sessions set track_id = null where event_id = ${ctx.event.id} and track_id = ${id}`
      await tx`delete from tracks where id = ${id} and event_id = ${ctx.event.id}`
      return row
    })
    if (!deleted) return fail(404, 'Track not found')
    const network = await syncProgramRecords('tracks', await loadEvent(ctx.event.id), ctx.viewer.accountId)
    return json({ deleted: true, sessionsWithoutTrack: deleted.session_count, network })
  } catch (e) {
    return errorResponse(e, 'delete track')
  }
}
