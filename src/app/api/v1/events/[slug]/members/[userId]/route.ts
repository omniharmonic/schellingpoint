/**
 * Event Member Management
 *
 * PATCH  - Change a member's role   body: { role }
 * DELETE - Remove a member from the event (votes are kept as history)
 *
 * Authorization matrix:
 * - Caller must be an owner or admin of the event (403 otherwise).
 * - Only an owner may assign the `owner` role, or change/remove a member
 *   who currently holds the `owner` role.
 * - Admins may set roles among admin|moderator|track_lead|volunteer|attendee.
 * - The last remaining owner can never be demoted or removed (409), which
 *   also covers a caller removing themselves while they are the last owner.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import type { EventRoleName } from '@/types/event'

const VALID_ROLES: EventRoleName[] = [
  'owner',
  'admin',
  'moderator',
  'track_lead',
  'volunteer',
  'attendee',
]

const MEMBER_SELECT = 'id, event_id, user_id, role, joined_at, vote_credits'

type Ctx = { params: Promise<{ slug: string; userId: string }> }

/**
 * Shared preamble: authenticate, resolve event, verify caller is owner/admin,
 * and load the target membership row.
 */
async function loadContext(request: NextRequest, slug: string, userId: string) {
  const user = await getUserFromRequest(request)
  if (!user) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const supabase = await createAdminClient()

  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('id')
    .eq('slug', slug)
    .single()

  if (eventError || !event) {
    return { error: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  }

  const { data: callerMembership } = await supabase
    .from('event_members')
    .select('role')
    .eq('event_id', event.id)
    .eq('user_id', user.id)
    .maybeSingle()

  const callerRole = callerMembership?.role as EventRoleName | undefined
  if (!callerRole || !['owner', 'admin'].includes(callerRole)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  const { data: target } = await supabase
    .from('event_members')
    .select(MEMBER_SELECT)
    .eq('event_id', event.id)
    .eq('user_id', userId)
    .maybeSingle()

  if (!target) {
    return { error: NextResponse.json({ error: 'Member not found' }, { status: 404 }) }
  }

  return { supabase, user, eventId: event.id, callerRole, target }
}

async function countOwners(
  supabase: Awaited<ReturnType<typeof createAdminClient>>,
  eventId: string
) {
  const { count } = await supabase
    .from('event_members')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', eventId)
    .eq('role', 'owner')
  return count ?? 0
}

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { slug, userId } = await params

  let body: { role?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const newRole = body.role
  if (typeof newRole !== 'string' || !VALID_ROLES.includes(newRole as EventRoleName)) {
    return NextResponse.json(
      { error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}` },
      { status: 400 }
    )
  }

  const ctx = await loadContext(request, slug, userId)
  if ('error' in ctx) return ctx.error
  const { supabase, eventId, callerRole, target } = ctx

  const targetIsOwner = target.role === 'owner'

  // Only owners may grant the owner role or touch an existing owner's row.
  if (callerRole !== 'owner' && (newRole === 'owner' || targetIsOwner)) {
    return NextResponse.json(
      { error: 'Only an event owner can assign or change the owner role' },
      { status: 403 }
    )
  }

  if (target.role === newRole) {
    return NextResponse.json({ member: target })
  }

  // Never leave the event without an owner.
  if (targetIsOwner && newRole !== 'owner') {
    const owners = await countOwners(supabase, eventId)
    if (owners <= 1) {
      return NextResponse.json(
        { error: 'Cannot demote the last owner. Assign another owner first.' },
        { status: 409 }
      )
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('event_members')
    .update({ role: newRole })
    .eq('id', target.id)
    .eq('event_id', eventId)
    .select(MEMBER_SELECT)
    .single()

  if (updateError || !updated) {
    console.error('Error updating member role:', updateError)
    return NextResponse.json({ error: 'Failed to update member role' }, { status: 500 })
  }

  return NextResponse.json({ member: updated })
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { slug, userId } = await params

  const ctx = await loadContext(request, slug, userId)
  if ('error' in ctx) return ctx.error
  const { supabase, eventId, callerRole, target } = ctx

  if (target.role === 'owner') {
    if (callerRole !== 'owner') {
      return NextResponse.json(
        { error: 'Only an event owner can remove another owner' },
        { status: 403 }
      )
    }
    const owners = await countOwners(supabase, eventId)
    if (owners <= 1) {
      return NextResponse.json(
        { error: 'Cannot remove the last owner. Assign another owner first.' },
        { status: 409 }
      )
    }
  }

  // Votes are intentionally preserved as event history; only the membership goes.
  const { error: deleteError } = await supabase
    .from('event_members')
    .delete()
    .eq('id', target.id)
    .eq('event_id', eventId)

  if (deleteError) {
    console.error('Error removing member:', deleteError)
    return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 })
  }

  return NextResponse.json({ success: true, member: target })
}
