import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'

// Event-scoped authorization: the session's primary host, or an event
// owner/admin/moderator (via event_members). Replaces the pre-multi-tenant
// global profile admin flag check.
const MANAGER_ROLES = ['owner', 'admin', 'moderator']

async function canManageSession(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  session: { host_id: string | null; event_id: string },
  userId: string
): Promise<boolean> {
  if (session.host_id === userId) return true
  const { data: membership } = await admin
    .from('event_members')
    .select('role')
    .eq('event_id', session.event_id)
    .eq('user_id', userId)
    .maybeSingle()
  return !!membership && MANAGER_ROLES.includes(membership.role)
}

// DELETE /api/sessions/[id]/invites/[inviteId] — Revoke an invite
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; inviteId: string }> }
) {
  const { id: sessionId, inviteId } = await params

  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = await createAdminClient()

  // Verify caller is primary host or an event manager
  const { data: session } = await admin
    .from('sessions')
    .select('id, host_id, event_id')
    .eq('id', sessionId)
    .single()

  if (!session) {
    return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  }

  if (!(await canManageSession(admin, session, user.id))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error } = await admin
    .from('cohost_invites')
    .update({ status: 'revoked' })
    .eq('id', inviteId)
    .eq('session_id', sessionId)
    .eq('status', 'pending')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
