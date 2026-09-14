/**
 * Accept Event Invitation
 * POST - Accept invitation and join event
 *
 * Email-bound invitations are single-use (accepted_at). Shareable links are
 * bounded by max_uses (null = unlimited); use_count is incremented with a
 * compare-and-swap UPDATE so concurrent accepts cannot exceed the limit.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'

const EXHAUSTED = { error: 'This invitation has reached its use limit' }

type Admin = Awaited<ReturnType<typeof createAdminClient>>

/**
 * Atomically reserve one use of a link invitation.
 * Returns 'ok' when a use was reserved, 'exhausted' when the limit is reached.
 * The UPDATE is guarded by the last-seen use_count (compare-and-swap), and the
 * value we read was verified below max_uses, so two racing accepts can never
 * both succeed past the limit: the loser sees 0 rows and re-reads.
 */
async function reserveUse(supabase: Admin, invitationId: string): Promise<'ok' | 'exhausted' | 'error'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data: current, error: readError } = await supabase
      .from('event_invitations')
      .select('use_count, max_uses')
      .eq('id', invitationId)
      .single()

    if (readError || !current) return 'error'
    if (current.max_uses !== null && current.use_count >= current.max_uses) return 'exhausted'

    const { data: updated, error: updateError } = await supabase
      .from('event_invitations')
      .update({ use_count: current.use_count + 1 })
      .eq('id', invitationId)
      .eq('use_count', current.use_count) // CAS: someone else incremented → 0 rows
      .select('id')

    if (updateError) return 'error'
    if (updated && updated.length === 1) return 'ok'
    // Lost the race; re-read and try again.
  }
  return 'error'
}

async function releaseUse(supabase: Admin, invitationId: string) {
  const { data: current } = await supabase
    .from('event_invitations')
    .select('use_count')
    .eq('id', invitationId)
    .single()
  if (current && current.use_count > 0) {
    await supabase
      .from('event_invitations')
      .update({ use_count: current.use_count - 1 })
      .eq('id', invitationId)
      .eq('use_count', current.use_count)
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Please log in to accept invitation' }, { status: 401 })
  }

  const supabase = await createAdminClient()

  // Find invitation
  const { data: invitation, error: inviteError } = await supabase
    .from('event_invitations')
    .select('id, event_id, email, role, expires_at, accepted_at, revoked_at, max_uses, use_count')
    .eq('token', token)
    .single()

  if (inviteError || !invitation) {
    return NextResponse.json({ error: 'Invalid invitation' }, { status: 404 })
  }

  const isEmailInvite = !!invitation.email

  // Check if already accepted (only for email-specific invitations)
  if (isEmailInvite && invitation.accepted_at) {
    return NextResponse.json({ error: 'Invitation already used' }, { status: 400 })
  }

  // Check if revoked
  if (invitation.revoked_at) {
    return NextResponse.json({ error: 'Invitation has been revoked' }, { status: 400 })
  }

  // Check expiration
  if (new Date(invitation.expires_at) < new Date()) {
    return NextResponse.json({ error: 'Invitation has expired' }, { status: 400 })
  }

  // Early exhausted check for link invites (the authoritative check is the CAS below)
  if (!isEmailInvite && invitation.max_uses !== null && invitation.use_count >= invitation.max_uses) {
    return NextResponse.json(EXHAUSTED, { status: 410 })
  }

  // If email-specific, verify email matches.
  // Check the user's profile email first, then fall back to auth.users email
  // (which is the source of truth since we require email auth).
  if (invitation.email) {
    let userEmail: string | null = null

    const { data: profile } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', user.id)
      .maybeSingle()

    userEmail = profile?.email ?? null

    // Fallback to auth user email (always present)
    if (!userEmail && user.email) {
      userEmail = user.email
    }

    if (!userEmail || userEmail.toLowerCase() !== invitation.email.toLowerCase()) {
      return NextResponse.json({
        error: 'This invitation was sent to a different email address'
      }, { status: 403 })
    }
  }

  // Check if already a member
  const { data: existingMember } = await supabase
    .from('event_members')
    .select('id')
    .eq('event_id', invitation.event_id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (existingMember) {
    // Mark invitation as accepted anyway (for email invitations). Link
    // invitations do not consume a use when nothing was granted.
    if (isEmailInvite) {
      await supabase
        .from('event_invitations')
        .update({ accepted_at: new Date().toISOString() })
        .eq('id', invitation.id)
    }

    // Get event slug for redirect
    const { data: event } = await supabase
      .from('events')
      .select('slug')
      .eq('id', invitation.event_id)
      .single()

    return NextResponse.json({
      success: true,
      message: 'You are already a member of this event',
      eventSlug: event?.slug
    })
  }

  // Reserve a use of the link before granting membership
  if (!isEmailInvite) {
    const reserved = await reserveUse(supabase, invitation.id)
    if (reserved === 'exhausted') {
      return NextResponse.json(EXHAUSTED, { status: 410 })
    }
    if (reserved === 'error') {
      return NextResponse.json({ error: 'Failed to join event' }, { status: 500 })
    }
  }

  // Add user to event
  const { error: memberError } = await supabase
    .from('event_members')
    .insert({
      event_id: invitation.event_id,
      user_id: user.id,
      role: invitation.role,
    })

  if (memberError) {
    console.error('Error adding member:', memberError)
    if (!isEmailInvite) await releaseUse(supabase, invitation.id)
    return NextResponse.json({ error: 'Failed to join event' }, { status: 500 })
  }

  // Mark invitation as accepted (only for email invitations)
  if (isEmailInvite) {
    await supabase
      .from('event_invitations')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', invitation.id)
  }

  // Get event slug for redirect
  const { data: event } = await supabase
    .from('events')
    .select('slug, name')
    .eq('id', invitation.event_id)
    .single()

  return NextResponse.json({
    success: true,
    message: `Welcome to ${event?.name}!`,
    eventSlug: event?.slug,
    role: invitation.role
  })
}
