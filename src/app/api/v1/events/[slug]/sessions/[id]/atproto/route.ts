/**
 * /api/v1/events/[slug]/sessions/[id]/atproto
 *
 * GET  (public)     what this session looks like on the network, plus the signed-in viewer's own
 *                   state (never anyone else's).
 * POST (signed in)  one participant-side action. Every record written here lands in the CALLER's
 *                   own repo, never anyone else's:
 *   publish-proposal | withdraw-proposal | publish-cohost | withdraw-cohost
 *   endorse { note? } | unendorse | rsvp-public { status } | rsvp-retract
 *   time-preference { windows, blackouts?, publish? }
 * Any action accepts `confirmPublicLinkage: true` (the OAuth-door one-time confirmation).
 */
import { sql } from '@/lib/db'
import { assertSameOrigin, eventRole, getViewer, requireViewer } from '@/lib/auth/viewer'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import { atprotoErrorResponse } from '@/lib/atproto/http'
import { RSVP_STATUS } from '@/lib/atproto/nsids'
import {
  countEndorsements,
  endorse,
  findEndorsement,
  PUBLIC_RSVP_PERMANENCE,
  PUBLIC_RSVP_STATUSES,
  publicRsvp,
  publishCohost,
  publishProposal,
  publishTimePreference,
  retractPublicRsvp,
  splitAtUri,
  unendorse,
  withdrawCohost,
  withdrawProposal,
  type PublicRsvpStatus,
} from '@/lib/atproto/participant'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ACTIONS = [
  'publish-proposal',
  'withdraw-proposal',
  'publish-cohost',
  'withdraw-cohost',
  'endorse',
  'unendorse',
  'rsvp-public',
  'rsvp-retract',
  'time-preference',
] as const
type Action = (typeof ACTIONS)[number]
type RouteParams = { params: Promise<{ slug: string; id: string }> }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface SessionRow {
  id: string
  event_id: string
  host_id: string | null
  host_did: string | null
  status: string
  proposal_uri: string | null
  proposal_cid: string | null
  proposal_withdrawn_at: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
}

async function loadVisibleSession(request: Request, slug: string, sessionId: string): Promise<{ session: SessionRow; accountId: string | null } | Response> {
  const notFound = () => Response.json({ error: 'Session not found' }, { status: 404 })
  if (!UUID.test(sessionId)) return notFound()
  const [event] = await sql<{ id: string; visibility: string; status: string }[]>`select id, visibility, status from events where slug = ${slug}`
  if (!event) return Response.json({ error: 'Event not found' }, { status: 404 })
  const [session] = await sql<SessionRow[]>`
    select id, event_id, host_id, host_did, status, proposal_uri, proposal_cid, proposal_withdrawn_at, calendar_event_uri, calendar_event_cid
    from sessions where id = ${sessionId} and event_id = ${event.id}
  `
  if (!session) return notFound()
  const viewer = await getViewer(request)
  const role = viewer ? await eventRole(event.id, viewer.accountId) : null
  let isCohost = false
  if (viewer) {
    const rows = await sql`select 1 from session_cohosts where session_id = ${session.id} and user_id = ${viewer.accountId}`
    isCohost = rows.length > 0
  }
  const isOrganizer = !!role && ['owner', 'admin', 'moderator'].includes(role)
  const isHost = !!viewer && (session.host_id === viewer.accountId || isCohost)
  const eventReadable = (['public', 'unlisted'].includes(event.visibility) && event.status !== 'draft') || (!!role && (event.status !== 'draft' || isOrganizer))
  const sessionVisible = ['approved', 'scheduled'].includes(session.status) || isOrganizer || isHost
  if (!eventReadable || !sessionVisible) return notFound()
  return { session, accountId: viewer?.accountId ?? null }
}

function rsvpStatusFromToken(token: unknown): PublicRsvpStatus | null {
  for (const status of PUBLIC_RSVP_STATUSES) if (RSVP_STATUS[status] === token) return status
  return null
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const loaded = await loadVisibleSession(request, slug, id)
  if (loaded instanceof Response) return loaded
  const { session, accountId } = loaded
  const live = !!session.proposal_uri && !session.proposal_withdrawn_at

  const [author] = session.host_did ? await sql<{ handle: string | null }[]>`select handle from accounts where did = ${session.host_did}` : []
  const body: Record<string, unknown> = {
    configured: isAtprotoConfigured(),
    proposal: live
      ? { uri: session.proposal_uri, cid: session.proposal_cid, did: splitAtUri(session.proposal_uri)?.did ?? null, handle: author?.handle ?? null }
      : null,
    calendarEvent: session.calendar_event_uri ? { uri: session.calendar_event_uri, cid: session.calendar_event_cid } : null,
    endorsements: live ? await countEndorsements(session.proposal_uri!) : 0,
    publicRsvpNotice: PUBLIC_RSVP_PERMANENCE,
  }

  if (accountId) {
    const [[account], [cohost], [rsvp], [pref]] = await Promise.all([
      sql<{ did: string; handle: string | null; kind: string; owned_at: string | null; publish_proposals: boolean | null }[]>`
        select a.did, a.handle, a.kind, a.owned_at, p.publish_proposals from accounts a left join profiles p on p.id = a.id where a.id = ${accountId}
      `,
      sql<{ cohost_uri: string | null }[]>`select cohost_uri from session_cohosts where session_id = ${session.id} and user_id = ${accountId}`,
      sql<{ rsvp_uri: string | null; status: string }[]>`select rsvp_uri, status from session_rsvps where session_id = ${session.id} and user_id = ${accountId}`,
      sql<{ windows: unknown; blackouts: unknown; publish: boolean; record_uri: string | null }[]>`
        select windows, blackouts, publish, record_uri from time_preferences where session_id = ${session.id} and account_id = ${accountId}
      `,
    ])
    const did = account?.did ?? null
    const endorsed = did && live ? !!(await findEndorsement(did, session.proposal_uri!)) : false
    let publicRsvpStatus: PublicRsvpStatus | null = null
    if (rsvp?.rsvp_uri) {
      const [indexed] = await sql<{ record: { status?: unknown } }[]>`select record from at_records where uri = ${rsvp.rsvp_uri}`
      publicRsvpStatus = rsvpStatusFromToken(indexed?.record?.status) ?? 'going'
    }
    body.viewer = {
      did,
      handle: account?.handle ?? null,
      door: account?.kind ?? null,
      canPublish: !!account && !account.owned_at && (account.kind === 'custodial' || !!account.publish_proposals),
      needsLinkageConfirmation: account?.kind === 'oauth' && !account.publish_proposals,
      isAuthor: session.host_id === accountId,
      isCohost: !!cohost,
      hasProposalRecord: !!did && live && splitAtUri(session.proposal_uri)?.did === did,
      endorsed,
      cohostPublished: !!cohost?.cohost_uri,
      hasRsvp: !!rsvp && rsvp.status !== 'cancelled',
      publicRsvp: publicRsvpStatus,
      publicRsvpUri: rsvp?.rsvp_uri ?? null,
      timePreference: pref ? { windows: pref.windows, blackouts: pref.blackouts, publish: pref.publish, recordUri: pref.record_uri } : null,
    }
  }
  return Response.json(body, { headers: { 'Cache-Control': 'private, no-store' } })
}

export async function POST(request: Request, { params }: RouteParams) {
  const denied = assertSameOrigin(request)
  if (denied) return denied
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { slug, id } = await params
  const loaded = await loadVisibleSession(request, slug, id)
  if (loaded instanceof Response) return loaded

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  const action = body.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return Response.json({ error: `action must be one of: ${ACTIONS.join(', ')}`, field: 'action' }, { status: 400 })
  }
  const ids = { sessionId: loaded.session.id, userId: viewer.accountId, confirmPublicLinkage: body.confirmPublicLinkage === true }
  try {
    switch (action as Action) {
      case 'publish-proposal':
        return Response.json({ action, ...(await publishProposal(ids)) })
      case 'withdraw-proposal':
        return Response.json({ action, ...(await withdrawProposal(ids)) })
      case 'publish-cohost':
        return Response.json({ action, ...(await publishCohost(ids)) })
      case 'withdraw-cohost':
        return Response.json({ action, ...(await withdrawCohost(ids)) })
      case 'endorse': {
        const note = body.note
        if (note !== undefined && note !== null && typeof note !== 'string') return Response.json({ error: 'note must be a string', field: 'note' }, { status: 400 })
        return Response.json({ action, ...(await endorse({ ...ids, note: (note as string | null | undefined) ?? null })) })
      }
      case 'unendorse':
        return Response.json({ action, ...(await unendorse(ids)) })
      case 'rsvp-public': {
        const status = body.status
        if (typeof status !== 'string' || !(PUBLIC_RSVP_STATUSES as readonly string[]).includes(status)) {
          return Response.json({ error: `status must be one of: ${PUBLIC_RSVP_STATUSES.join(', ')}`, field: 'status' }, { status: 400 })
        }
        return Response.json({ action, ...(await publicRsvp({ ...ids, status: status as PublicRsvpStatus })) })
      }
      case 'rsvp-retract':
        return Response.json({ action, ...(await retractPublicRsvp(ids)) })
      case 'time-preference':
        return Response.json({
          action,
          ...(await publishTimePreference({
            ...ids,
            windows: body.windows as never,
            blackouts: body.blackouts as never,
            publish: body.publish === true,
          })),
        })
    }
  } catch (e) {
    return atprotoErrorResponse(e, 'sessions/atproto')
  }
}
