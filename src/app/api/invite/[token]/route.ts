import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

// GET /api/invite/[token] — Public invite lookup (no auth required)
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  if (!token || token.length !== 64) {
    return NextResponse.json({ error: 'Invalid invite token' }, { status: 400 })
  }

  const admin = await createAdminClient()

  const { data: invite, error } = await admin
    .from('cohost_invites')
    .select(`
      id,
      status,
      expires_at,
      session:sessions(
        id,
        title,
        description,
        format,
        duration,
        host_name,
        host:profiles!host_id(id, display_name, avatar_url),
        event:events(slug)
      )
    `)
    .eq('token', token)
    .single()

  if (error || !invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 })
  }

  // Check expiry
  const isExpired = new Date(invite.expires_at) < new Date()
  const effectiveStatus = invite.status === 'pending' && isExpired ? 'expired' : invite.status

  // Supabase infers nested joins as arrays; the FK relationships are to-one.
  const session = invite.session as any
  const eventSlug: string | null = session?.event?.slug ?? null

  return NextResponse.json({
    status: effectiveStatus,
    session_id: session?.id ?? null,
    event_slug: eventSlug,
    session,
  })
}
