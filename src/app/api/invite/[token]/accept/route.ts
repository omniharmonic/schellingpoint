import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { publishCohost } from '@/lib/atproto/participant'

// POST /api/invite/[token]/accept — Accept a co-host invite
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  if (!token || token.length !== 64) {
    return NextResponse.json({ error: 'Invalid invite token' }, { status: 400 })
  }

  // Require authentication
  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'You must be signed in to accept an invite' }, { status: 401 })
  }

  const admin = await createAdminClient()

  // Fetch the invite
  const { data: invite, error: fetchError } = await admin
    .from('cohost_invites')
    .select('id, session_id, status, expires_at')
    .eq('token', token)
    .single()

  if (fetchError || !invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
  }

  // Validate status
  if (invite.status !== 'pending') {
    return NextResponse.json({ error: `Invite is ${invite.status}` }, { status: 400 })
  }

  // Check expiry
  if (new Date(invite.expires_at) < new Date()) {
    await admin.from('cohost_invites').update({ status: 'expired' }).eq('id', invite.id)
    return NextResponse.json({ error: 'Invite has expired' }, { status: 400 })
  }

  // Load the session (and its event) so we can scope the co-host row and
  // return a routable event slug to the client.
  const { data: session } = await admin
    .from('sessions')
    .select('id, host_id, event_id, event:events(slug)')
    .eq('id', invite.session_id)
    .single()

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  const eventSlug: string | null = (session as any).event?.slug ?? null

  // Check if user is already the primary host
  if (session.host_id === user.id) {
    return NextResponse.json({ error: 'You are already the primary host of this session' }, { status: 400 })
  }

  // Check if already a co-host
  const { data: existing } = await admin
    .from('session_cohosts')
    .select('id')
    .eq('session_id', invite.session_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({
      error: 'You are already a co-host of this session',
      session_id: invite.session_id,
      event_slug: eventSlug,
    }, { status: 409 })
  }

  // Claim the invite first. The status guard makes this atomic against a
  // concurrent accept, and checking the error means a failed transition can
  // never leave a silently reusable "pending" invite behind.
  const { data: claimed, error: claimError } = await admin
    .from('cohost_invites')
    .update({
      status: 'accepted',
      accepted_by: user.id,
      accepted_at: new Date().toISOString(),
    })
    .eq('id', invite.id)
    .eq('status', 'pending')
    .select('id')
    .maybeSingle()

  if (claimError) {
    console.error('[invite/accept] failed to mark invite accepted:', claimError.message)
    return NextResponse.json({ error: claimError.message }, { status: 500 })
  }
  if (!claimed) {
    return NextResponse.json({ error: 'Invite is no longer pending' }, { status: 409 })
  }

  // Add as co-host (event-scoped)
  const { error: insertError } = await admin
    .from('session_cohosts')
    .insert({
      session_id: invite.session_id,
      user_id: user.id,
      event_id: session.event_id,
    })

  if (insertError) {
    // Best-effort rollback so the invite can be retried
    await admin
      .from('cohost_invites')
      .update({ status: 'pending', accepted_by: null, accepted_at: null })
      .eq('id', invite.id)
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  // ATProto: if the acceptor has a linked DID and the author has published the
  // proposal, write the co-host's own `schellingpoint.draft.cohost` record.
  // Best-effort: a network failure never undoes the acceptance.
  let atproto: { uri?: string; error?: string } | undefined
  const [{ data: acceptorProfile }, { data: sessionRefs }] = await Promise.all([
    admin.from('profiles').select('did').eq('id', user.id).maybeSingle(),
    admin.from('sessions').select('proposal_uri, proposal_cid').eq('id', invite.session_id).maybeSingle(),
  ])
  if (acceptorProfile?.did && sessionRefs?.proposal_uri && sessionRefs?.proposal_cid) {
    try {
      const result = await publishCohost({ sessionId: invite.session_id, userId: user.id })
      atproto = { uri: result.uri }
    } catch (e) {
      console.error('[invite/accept] atproto cohost publish failed:', e)
      atproto = { error: e instanceof Error ? e.message : 'publish failed' }
    }
  }

  return NextResponse.json({ session_id: invite.session_id, event_slug: eventSlug, ...(atproto ? { atproto } : {}) })
}
