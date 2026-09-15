import { resolvePublicEvent } from '@/lib/api/auth'
import { methodNotAllowed } from '@/lib/api/response'
import { publicJson, publishedTracks } from '../schedule/public-read'

/**
 * GET /api/v1/tracks?event=<slug> — the gathering's published tracks
 * (`schellingpoint.draft.track` records). Public; no key. Track leads are never included (R9).
 */
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const resolved = await resolvePublicEvent(request)
  if ('error' in resolved) return resolved.error
  const tracks = await publishedTracks(resolved.event.id)
  return publicJson(tracks, tracks.length)
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
