import { sql } from '@/lib/db'
import { publicEventForRow } from '@/lib/api/auth'
import { badRequest, isValidUUID, methodNotAllowed, notFound, parseIncludes } from '@/lib/api/response'
import { publicJson, publishedSessions, publishedTracks } from '../../schedule/public-read'

/**
 * GET /api/v1/tracks/[id][?event=<slug>][&include=sessions] — one published track, optionally
 * with its published sessions. Unpublished tracks, and tracks of private or draft gatherings,
 * are 404.
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return badRequest('Invalid track ID format. Expected a UUID.')
  const includes = parseIncludes(request, ['sessions'])
  if ('error' in includes) return includes.error

  const [row] = await sql<{ event_id: string }[]>`select event_id from tracks where id = ${id}`
  const event = await publicEventForRow(request, row?.event_id)
  if (!event) return notFound('Track')
  const [track] = await publishedTracks(event.id, id)
  if (!track) return notFound('Track')

  if (includes.includes.includes('sessions')) {
    const sessions = await publishedSessions(event.id, { actorDid: event.actor_did, trackId: id })
    return publicJson({ ...track, sessions })
  }
  return publicJson(track)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
