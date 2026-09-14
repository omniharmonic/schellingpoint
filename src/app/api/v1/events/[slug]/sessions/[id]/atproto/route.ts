import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { NSID, RSVP_STATUS } from '@/lib/atproto/nsids'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import {
  endorse,
  findEndorsement,
  ParticipantError,
  PUBLIC_RSVP_STATUSES,
  publicRsvp,
  publishCohost,
  publishProposal,
  retractPublicRsvp,
  splitAtUri,
  unendorse,
  withdrawCohost,
  withdrawProposal,
  type PublicRsvpStatus,
} from '@/lib/atproto/participant'

/**
 * /api/v1/events/[slug]/sessions/[id]/atproto
 *
 * GET  (public)   -> what this session looks like on the network, plus the
 *                    signed-in viewer's own state when a token is sent.
 * POST (signed in)-> one participant-side action. Every record written here
 *                    lands in the CALLER's own repo, never anyone else's.
 */

const ORGANIZER_ROLES = ['owner', 'admin']

const ACTIONS = [
  'publish-proposal',
  'withdraw-proposal',
  'publish-cohost',
  'withdraw-cohost',
  'endorse',
  'unendorse',
  'rsvp-public',
  'rsvp-retract',
] as const
type Action = (typeof ACTIONS)[number]

type RouteParams = { params: Promise<{ slug: string; id: string }> }

interface SessionRow {
  id: string
  event_id: string
  host_id: string | null
  host_did: string | null
  status: string
  proposal_uri: string | null
  proposal_cid: string | null
  calendar_event_uri: string | null
  calendar_event_cid: string | null
}

interface Loaded {
  supabase: Awaited<ReturnType<typeof createAdminClient>>
  session: SessionRow
  userId: string | null
}

async function loadSession(request: Request, slug: string, sessionId: string): Promise<Loaded | NextResponse> {
  const supabase = await createAdminClient()
  const user = await getUserFromRequest(request)

  const { data: event } = await supabase.from('events').select('id, visibility, status').eq('slug', slug).single()
  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const { data: session } = await supabase
    .from('sessions')
    .select('id, event_id, host_id, host_did, status, proposal_uri, proposal_cid, calendar_event_uri, calendar_event_cid')
    .eq('id', sessionId)
    .eq('event_id', event.id)
    .maybeSingle()
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  let role: string | null = null
  let isCohost = false
  if (user) {
    const [{ data: membership }, { data: cohost }] = await Promise.all([
      supabase.from('event_members').select('role').eq('event_id', event.id).eq('user_id', user.id).maybeSingle(),
      supabase.from('session_cohosts').select('id').eq('session_id', session.id).eq('user_id', user.id).maybeSingle(),
    ])
    role = membership?.role ?? null
    isCohost = !!cohost
  }
  const isOrganizer = !!role && [...ORGANIZER_ROLES, 'moderator'].includes(role)
  const isHost = !!user && (session.host_id === user.id || isCohost)

  const eventReadable =
    (['public', 'unlisted'].includes(event.visibility) && event.status !== 'draft') ||
    (!!role && (event.status !== 'draft' || ORGANIZER_ROLES.includes(role)))
  const sessionVisible = ['approved', 'scheduled'].includes(session.status) || isOrganizer || isHost
  if (!eventReadable || !sessionVisible) return NextResponse.json({ error: 'Session not found' }, { status: 404 })

  return { supabase, session: session as SessionRow, userId: user?.id ?? null }
}

function rsvpStatusFromToken(token: unknown): PublicRsvpStatus | null {
  for (const status of PUBLIC_RSVP_STATUSES) if (RSVP_STATUS[status] === token) return status
  return null
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const loaded = await loadSession(request, slug, id)
  if (loaded instanceof NextResponse) return loaded
  const { supabase, session, userId } = loaded

  const [{ count: endorsements }, author] = await Promise.all([
    session.proposal_uri
      ? supabase
          .from('at_records')
          .select('uri', { count: 'exact', head: true })
          .eq('collection', NSID.endorsement)
          .eq('record->proposal->>uri', session.proposal_uri)
      : Promise.resolve({ count: 0 }),
    session.host_did
      ? supabase.from('profiles').select('atproto_handle').eq('did', session.host_did).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const proposalDid = splitAtUri(session.proposal_uri)?.did ?? session.host_did ?? null
  const body: Record<string, unknown> = {
    configured: isAtprotoConfigured(),
    proposal: session.proposal_uri
      ? {
          uri: session.proposal_uri,
          cid: session.proposal_cid,
          did: proposalDid,
          handle: (author?.data?.atproto_handle as string | null) ?? null,
        }
      : null,
    calendarEvent: session.calendar_event_uri ? { uri: session.calendar_event_uri, cid: session.calendar_event_cid } : null,
    endorsements: endorsements ?? 0,
  }

  if (userId) {
    const [{ data: profile }, { data: cohost }, { data: rsvp }] = await Promise.all([
      supabase.from('profiles').select('did, atproto_handle').eq('id', userId).maybeSingle(),
      supabase.from('session_cohosts').select('cohost_uri').eq('session_id', session.id).eq('user_id', userId).maybeSingle(),
      supabase.from('session_rsvps').select('rsvp_uri, status').eq('session_id', session.id).eq('user_id', userId).maybeSingle(),
    ])
    const did = (profile?.did as string | null) ?? null
    const proposalOwner = splitAtUri(session.proposal_uri)?.did ?? null

    let endorsed = false
    if (did && session.proposal_uri) endorsed = !!(await findEndorsement(supabase, did, session.proposal_uri))

    let publicRsvpStatus: PublicRsvpStatus | null = null
    const rsvpUri = (rsvp?.rsvp_uri as string | null) ?? null
    if (rsvpUri) {
      const { data: indexed } = await supabase.from('at_records').select('record').eq('uri', rsvpUri).maybeSingle()
      publicRsvpStatus = rsvpStatusFromToken((indexed?.record as { status?: unknown } | null)?.status) ?? 'going'
    }

    body.viewer = {
      linked: !!did,
      handle: (profile?.atproto_handle as string | null) ?? null,
      isAuthor: session.host_id === userId,
      isCohost: cohost !== null && cohost !== undefined,
      hasProposalRecord: !!did && !!proposalOwner && proposalOwner === did,
      endorsed,
      cohostPublished: !!(cohost?.cohost_uri as string | null),
      hasRsvp: !!rsvp,
      publicRsvp: publicRsvpStatus,
      publicRsvpUri: rsvpUri,
    }
  }

  return NextResponse.json(body)
}

function errorResponse(e: unknown): NextResponse {
  if (e instanceof ParticipantError) return NextResponse.json({ error: e.code, message: e.message }, { status: e.status })
  const err = e as { name?: string; message?: string; status?: number; error?: string }
  if (err?.name === 'ProfileNotLinkedError') {
    return NextResponse.json({ error: 'link_atproto_first', message: 'Link an ATProto account first' }, { status: 409 })
  }
  if (err?.name === 'NoActorCredentialError') {
    return NextResponse.json({ error: 'relink_atproto', message: 'Your ATProto session has expired. Link your account again.' }, { status: 409 })
  }
  if (err?.name === 'ForeignDidError' || err?.name === 'RecordValidationError') {
    return NextResponse.json({ error: 'invalid_record', message: err.message ?? 'Record failed validation' }, { status: 409 })
  }
  console.error('[sessions/atproto] write failed:', e)
  return NextResponse.json({ error: 'network', message: err?.message ?? 'The network write failed' }, { status: 502 })
}

export async function POST(request: Request, { params }: RouteParams) {
  const { slug, id } = await params
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const loaded = await loadSession(request, slug, id)
  if (loaded instanceof NextResponse) return loaded
  const { session } = loaded

  let body: Record<string, unknown>
  try {
    body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body')
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const action = body.action
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: `action must be one of: ${ACTIONS.join(', ')}` }, { status: 400 })
  }

  const ids = { sessionId: session.id, userId: user.id }
  try {
    switch (action as Action) {
      case 'publish-proposal':
        return NextResponse.json({ action, ...(await publishProposal(ids)) })
      case 'withdraw-proposal':
        return NextResponse.json({ action, ...(await withdrawProposal(ids)) })
      case 'publish-cohost':
        return NextResponse.json({ action, ...(await publishCohost(ids)) })
      case 'withdraw-cohost':
        return NextResponse.json({ action, ...(await withdrawCohost(ids)) })
      case 'endorse': {
        const note = body.note
        if (note !== undefined && note !== null && typeof note !== 'string') {
          return NextResponse.json({ error: 'note must be a string' }, { status: 400 })
        }
        return NextResponse.json({ action, ...(await endorse({ ...ids, note: (note as string | null | undefined) ?? null })) })
      }
      case 'unendorse':
        return NextResponse.json({ action, ...(await unendorse(ids)) })
      case 'rsvp-public': {
        const status = body.status
        if (typeof status !== 'string' || !(PUBLIC_RSVP_STATUSES as readonly string[]).includes(status)) {
          return NextResponse.json({ error: `status must be one of: ${PUBLIC_RSVP_STATUSES.join(', ')}` }, { status: 400 })
        }
        return NextResponse.json({ action, ...(await publicRsvp({ ...ids, status: status as PublicRsvpStatus })) })
      }
      case 'rsvp-retract':
        return NextResponse.json({ action, ...(await retractPublicRsvp(ids)) })
    }
  } catch (e) {
    return errorResponse(e)
  }
}
