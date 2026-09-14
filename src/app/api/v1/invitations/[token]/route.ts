/**
 * Get Invitation Info (public)
 * Returns invitation details for display on acceptance page
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const supabase = await createAdminClient()

  // Find invitation with event info
  const { data: invitation, error } = await supabase
    .from('event_invitations')
    .select(`
      email,
      role,
      expires_at,
      accepted_at,
      revoked_at,
      max_uses,
      use_count,
      events (
        name,
        slug,
        description,
        start_date,
        end_date
      )
    `)
    .eq('token', token)
    .single()

  if (error || !invitation) {
    return NextResponse.json({ error: 'Invalid invitation' }, { status: 404 })
  }

  // events is a single object since we're joining on event_id FK
  const event = invitation.events as unknown as { name: string; slug: string; description: string | null; start_date: string; end_date: string } | null

  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  // Email-bound invitations are single-use (accepted_at); shareable links are
  // bounded by max_uses (null = unlimited).
  const isEmailInvite = !!invitation.email
  const exhausted =
    !isEmailInvite &&
    invitation.max_uses !== null &&
    invitation.use_count >= invitation.max_uses

  return NextResponse.json({
    event: {
      name: event.name,
      slug: event.slug,
      description: event.description,
      start_date: event.start_date,
      end_date: event.end_date,
    },
    role: invitation.role,
    expires_at: invitation.expires_at,
    is_expired: new Date(invitation.expires_at) < new Date(),
    is_used: isEmailInvite && !!invitation.accepted_at,
    is_revoked: !!invitation.revoked_at,
    max_uses: invitation.max_uses,
    use_count: invitation.use_count,
    exhausted,
  })
}
