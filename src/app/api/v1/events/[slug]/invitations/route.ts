/**
 * Event Invitations API
 *
 * POST - Create invitation (email or shareable link)
 * GET - List pending invitations
 */

import { NextRequest, NextResponse } from 'next/server'
import { Resend } from 'resend'
import { createAdminClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { buildEventInvitationEmail } from '@/lib/email/notification-emails'

// Lazy-init Resend client so build/import doesn't require RESEND_API_KEY
let _resend: Resend | null = null
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY)
  return _resend
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params

  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createAdminClient()

  // Get event (include logo/dates/location for email branding)
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('id, name, slug, visibility, logo_url, start_date, end_date, location_name')
    .eq('slug', slug)
    .single()

  if (eventError || !event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  // Verify admin/owner role
  const { data: membership } = await supabase
    .from('event_members')
    .select('role')
    .eq('event_id', event.id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fetch inviter display name for email
  const { data: inviterProfile } = await supabase
    .from('profiles')
    .select('display_name, email')
    .eq('id', user.id)
    .maybeSingle()
  const inviterName = inviterProfile?.display_name || inviterProfile?.email || 'An event organizer'

  // Parse request
  let body: { emails?: string[]; role?: string; expiresInDays?: number; max_uses?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const role = body.role || 'attendee'
  if (!['attendee', 'volunteer', 'moderator', 'admin'].includes(role)) {
    return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
  }

  const isLinkInvite = !body.emails || body.emails.length === 0

  // max_uses: positive integer, or null/undefined for unlimited (link invites only)
  let maxUses: number | null = null
  if (body.max_uses !== undefined && body.max_uses !== null && body.max_uses !== '') {
    const n = typeof body.max_uses === 'string' ? Number(body.max_uses) : body.max_uses
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      return NextResponse.json({ error: 'max_uses must be a positive integer or null' }, { status: 400 })
    }
    maxUses = n
  }

  // Shareable links that grant elevated access must be bounded
  if (isLinkInvite && ['admin', 'owner'].includes(role) && maxUses === null) {
    return NextResponse.json(
      { error: 'Shareable links for the admin role must set a finite max_uses (for example 1)' },
      { status: 400 }
    )
  }

  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + (body.expiresInDays || 7))

  // Create invitations
  const invitations = []

  if (!isLinkInvite) {
    // Email invitations (single-use via accepted_at; max_uses not applicable)
    for (const email of body.emails!) {
      invitations.push({
        event_id: event.id,
        email: email.toLowerCase().trim(),
        role,
        expires_at: expiresAt.toISOString(),
        created_by: user.id,
      })
    }
  } else {
    // Shareable link (no email)
    invitations.push({
      event_id: event.id,
      email: null,
      role,
      expires_at: expiresAt.toISOString(),
      created_by: user.id,
      max_uses: maxUses,
    })
  }

  const { data: created, error: insertError } = await supabase
    .from('event_invitations')
    .insert(invitations)
    .select('id, token, email, role, expires_at, max_uses, use_count')

  if (insertError) {
    console.error('Error creating invitations:', insertError)
    return NextResponse.json({ error: 'Failed to create invitations' }, { status: 500 })
  }

  // Send invitation emails for any email-specific invitations
  const emailResults: { email: string; sent: boolean; error?: string }[] = []
  const toEmail = (created || []).filter((i) => !!i.email)

  if (toEmail.length > 0) {
    const fromEmail = process.env.RESEND_FROM_EMAIL || 'hello@schellingpoint.city'
    const fromName = event.name || 'Schelling Point'

    // Format event date range for footer
    let dateRange: string | undefined
    if (event.start_date && event.end_date) {
      const eventStart = new Date(event.start_date)
      const eventEnd = new Date(event.end_date)
      const startMonth = eventStart.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
      const endMonth = eventEnd.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })
      const startDay = eventStart.getUTCDate()
      const endDay = eventEnd.getUTCDate()
      const year = eventStart.getUTCFullYear()
      dateRange = startMonth === endMonth
        ? `${startMonth} ${startDay}-${endDay}, ${year}`
        : `${startMonth} ${startDay} - ${endMonth} ${endDay}, ${year}`
    }

    const eventInfo = {
      name: event.name,
      slug: event.slug,
      logoUrl: event.logo_url || undefined,
      dateRange,
      location: event.location_name || undefined,
    }

    for (const inv of toEmail) {
      try {
        const { subject, html } = buildEventInvitationEmail({
          event: eventInfo,
          inviteeEmail: inv.email!,
          inviterName,
          role: inv.role,
          inviteToken: inv.token,
          expiresAt: inv.expires_at,
        })

        const { error: sendError } = await getResend().emails.send({
          from: `${fromName} <${fromEmail}>`,
          to: inv.email!,
          subject,
          html,
        })

        if (sendError) {
          console.error(`Failed to send invitation email to ${inv.email}:`, sendError)
          emailResults.push({ email: inv.email!, sent: false, error: sendError.message })
        } else {
          emailResults.push({ email: inv.email!, sent: true })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        console.error(`Failed to send invitation email to ${inv.email}:`, err)
        emailResults.push({ email: inv.email!, sent: false, error: message })
      }
    }
  }

  return NextResponse.json({
    success: true,
    invitations: created,
    inviteUrl: created && created.length === 1 && !created[0].email
      ? `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'}/invite/e/${created[0].token}`
      : null,
    emailResults: emailResults.length > 0 ? emailResults : undefined,
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params

  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createAdminClient()

  // Get event
  const { data: event, error: eventError } = await supabase
    .from('events')
    .select('id')
    .eq('slug', slug)
    .single()

  if (eventError || !event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  // Verify admin/owner role
  const { data: membership } = await supabase
    .from('event_members')
    .select('role')
    .eq('event_id', event.id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Fetch pending invitations
  const { data: invitations, error: fetchError } = await supabase
    .from('event_invitations')
    .select('id, token, email, role, expires_at, accepted_at, revoked_at, created_at, max_uses, use_count')
    .eq('event_id', event.id)
    .is('revoked_at', null)
    .order('created_at', { ascending: false })

  if (fetchError) {
    console.error('Error fetching invitations:', fetchError)
    return NextResponse.json({ error: 'Failed to fetch invitations' }, { status: 500 })
  }

  return NextResponse.json({ invitations })
}
