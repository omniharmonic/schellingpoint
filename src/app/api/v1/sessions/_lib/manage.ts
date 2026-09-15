import 'server-only'
import { sql } from '@/lib/db'
import { requireViewer, assertSameOrigin, type Viewer } from '@/lib/auth/viewer'
import {
  canSeeSession,
  jsonError,
  loadSessionEventAccess,
  sessionRelation,
  type EventAccess,
  type SessionRelation,
} from './access'

export interface ManageContext {
  viewer: Viewer
  access: EventAccess
  rel: SessionRelation
  /** The proposer, or an organizer of the event. */
  canInvite: boolean
}

/** Signed-in viewer + a session they can see, with their relationship to it. */
export async function loadManageContext(request: Request, sessionId: string): Promise<ManageContext | Response> {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const access = await loadSessionEventAccess(request, sessionId)
  if (access instanceof Response) return access
  const rel = await sessionRelation(sql, sessionId, access.event.id, viewer.accountId)
  if (!rel || !canSeeSession(rel, access)) return jsonError(404, 'Session not found')
  return { viewer, access, rel, canInvite: rel.isHost || access.isOrganizer }
}
