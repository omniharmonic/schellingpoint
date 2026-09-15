/**
 * Email templates for notifications.
 *
 * `renderNotificationEmail` renders any outbox row (src/lib/notifications/dispatch.ts): the
 * title and body the emitting code wrote for the in-app feed become the email, with a
 * per-type subject and call to action. The specific builders below are used directly by
 * organizer tools (session emails, invitations).
 *
 * Every builder returns `{ subject, html, text }`; pass all three to `sendMail`.
 * Values a person typed are escaped (see ./escape).
 */

import { appUrl, buildBaseEmail, buildPlainText, PRODUCT_NAME, type BaseEmailParams } from './base-template'
import { escapeHtml, textToHtml } from './escape'

export interface EmailContent {
  subject: string
  html: string
  text: string
}

// Common event info interface
export interface EventInfo {
  name: string
  slug: string
  logoUrl?: string
  dateRange?: string
  location?: string
}

function eventParams(event: EventInfo): Pick<BaseEmailParams, 'eventName' | 'eventLogoUrl' | 'eventDateRange' | 'eventLocation'> {
  return {
    eventName: event.name,
    eventLogoUrl: event.logoUrl,
    eventDateRange: event.dateRange,
    eventLocation: event.location,
  }
}

function subjectFor(text: string, event: EventInfo): string {
  // Subjects are plain text; strip line breaks so a title cannot inject headers.
  return `${text} — ${event.name}`.replace(/[\r\n]+/g, ' ')
}

// =============================================================================
// SESSION STATUS EMAILS
// =============================================================================

interface SessionStatusEmailParams {
  event: EventInfo
  hostName: string
  sessionTitle: string
  sessionId: string
}

export function buildSessionApprovedEmail(params: SessionStatusEmailParams): EmailContent {
  const { event, hostName, sessionTitle, sessionId } = params
  const ctaUrl = `${appUrl()}/e/${encodeURIComponent(event.slug)}/sessions/${encodeURIComponent(sessionId)}`

  const html = buildBaseEmail({
    ...eventParams(event),
    previewText: `Your session "${sessionTitle}" has been approved!`,
    heading: 'Session Approved!',
    bodyHtml: `
      <p style="margin: 0 0 16px 0;">Hey ${escapeHtml(hostName)},</p>
      <p style="margin: 0 0 16px 0;">Great news! Your session has been approved and is now visible to attendees:</p>
      <p style="margin: 0 0 16px 0; font-weight: 600; font-size: 17px; color: #ffffff;">"${escapeHtml(sessionTitle)}"</p>
      <p style="margin: 0;">Share it with others to gather support.</p>
    `,
    ctaUrl,
    ctaText: 'View Your Session',
    footerNote: 'You can edit your session details or invite co-hosts from the session page.',
  })

  return {
    subject: subjectFor(`Your session "${sessionTitle}" has been approved`, event),
    html,
    text: buildPlainText({
      heading: 'Session approved',
      paragraphs: [
        `Hey ${hostName},`,
        `Your session "${sessionTitle}" has been approved and is now visible to attendees.`,
      ],
      ctaUrl,
      ctaText: 'View your session',
      eventName: event.name,
    }),
  }
}

export function buildSessionRejectedEmail(params: SessionStatusEmailParams & { reason?: string }): EmailContent {
  const { event, hostName, sessionTitle, reason } = params

  const reasonHtml = reason
    ? `<p style="margin: 16px 0; padding: 12px 16px; background-color: #161b22; border-radius: 8px; border-left: 3px solid #8b949e; font-size: 14px; color: #8b949e;">${escapeHtml(reason)}</p>`
    : ''

  const html = buildBaseEmail({
    ...eventParams(event),
    previewText: `Update on your session "${sessionTitle}"`,
    heading: 'Session Update',
    bodyHtml: `
      <p style="margin: 0 0 16px 0;">Hey ${escapeHtml(hostName)},</p>
      <p style="margin: 0 0 16px 0;">Thank you for submitting a session proposal for ${escapeHtml(event.name)}.</p>
      <p style="margin: 0 0 8px 0;">Unfortunately, we weren't able to include your session in the program:</p>
      <p style="margin: 0 0 16px 0; font-weight: 500; color: #ffffff;">"${escapeHtml(sessionTitle)}"</p>
      ${reasonHtml}
      <p style="margin: 0;">We received many great submissions and had to make difficult choices. We hope to see you at the event!</p>
    `,
    footerNote: 'Feel free to reach out to the organizers if you have questions.',
  })

  return {
    subject: subjectFor('Update on your session submission', event),
    html,
    text: buildPlainText({
      heading: 'Session update',
      paragraphs: [
        `Hey ${hostName},`,
        `Thank you for submitting "${sessionTitle}" to ${event.name}. Unfortunately, we weren't able to include it in the program.`,
        reason ? `Reason: ${reason}` : null,
      ],
      eventName: event.name,
    }),
  }
}

// =============================================================================
// EVENT INVITATION EMAIL
// =============================================================================

interface EventInvitationEmailParams {
  event: EventInfo
  inviteeEmail: string
  inviterName: string
  role: string
  inviteToken: string
  expiresAt: string
}

export function buildEventInvitationEmail(params: EventInvitationEmailParams): EmailContent {
  const { event, inviteeEmail, inviterName, role, inviteToken, expiresAt } = params

  const expiresText = new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
  const roleDisplay = role.charAt(0).toUpperCase() + role.slice(1)
  const ctaUrl = `${appUrl()}/invite/e/${encodeURIComponent(inviteToken)}`

  const html = buildBaseEmail({
    ...eventParams(event),
    previewText: `${inviterName} invited you to join ${event.name}`,
    heading: `You're invited!`,
    bodyHtml: `
      <p style="margin: 0 0 16px 0;">Hey there,</p>
      <p style="margin: 0 0 16px 0;"><strong style="color: #ffffff;">${escapeHtml(inviterName)}</strong> has invited you to join <strong style="color: #ffffff;">${escapeHtml(event.name)}</strong> as a <strong style="color: #ffffff;">${escapeHtml(roleDisplay)}</strong>.</p>
      <p style="margin: 0 0 16px 0;">Click the button below to accept your invitation and join the event.</p>
    `,
    ctaUrl,
    ctaText: 'Accept Invitation',
    footerNote: `This invitation was sent to ${inviteeEmail} and expires on ${expiresText}.`,
  })

  return {
    subject: `You're invited to join ${event.name}`.replace(/[\r\n]+/g, ' '),
    html,
    text: buildPlainText({
      heading: `You're invited to ${event.name}`,
      paragraphs: [`${inviterName} has invited you to join ${event.name} as a ${roleDisplay}.`],
      ctaUrl,
      ctaText: 'Accept the invitation',
      footerNote: `This invitation was sent to ${inviteeEmail} and expires on ${expiresText}.`,
      eventName: event.name,
    }),
  }
}

// =============================================================================
// OUTBOX NOTIFICATIONS
// =============================================================================

/** Call-to-action label per notification type (the link is the row's action_url). */
const CTA_TEXT: Record<string, string> = {
  session_submitted: 'View your session',
  session_approved: 'View your session',
  session_rejected: 'View your session',
  session_scheduled: 'View your session',
  session_rescheduled: 'See the new time',
  session_cancelled: 'View the schedule',
  cohost_invited: 'View invitation',
  cohost_accepted: 'View session',
  cohost_declined: 'View session',
  voting_opened: 'Start voting',
  voting_closed: 'See the sessions',
  schedule_published: 'View schedule',
  event_reminder: 'View event',
  admin_announcement: 'Read more',
  new_proposal: 'Review proposals',
  proposal_needs_review: 'Review proposals',
  proposal_changed: 'Review and re-publish',
  approval_requested: 'Review request',
  event_invitation: 'View invitation',
  ticket_confirmed: 'View your ticket',
}

export interface NotificationEmailInput {
  type: string
  title: string
  body: string | null
  /** App-relative (`/e/slug/...`) or absolute on the app origin; anything else is dropped. */
  actionUrl: string | null
  recipientName: string | null
  event: EventInfo | null
}

/**
 * Absolute link for an action URL, only if it points into this app. Notifications are
 * written by our own code, but a link in an email is exactly what phishing borrows, so
 * foreign origins are refused rather than trusted.
 */
export function notificationLink(actionUrl: string | null): string | null {
  if (!actionUrl) return null
  const origin = appUrl()
  if (actionUrl.startsWith('/') && !actionUrl.startsWith('//')) return `${origin}${actionUrl}`
  try {
    const url = new URL(actionUrl)
    return url.origin === new URL(origin).origin ? url.toString() : null
  } catch {
    return null
  }
}

export function renderNotificationEmail(input: NotificationEmailInput): EmailContent {
  const event: EventInfo = input.event ?? { name: PRODUCT_NAME, slug: '' }
  const greeting = input.recipientName ? `Hey ${input.recipientName},` : 'Hey there,'
  const ctaUrl = notificationLink(input.actionUrl)
  const ctaText = CTA_TEXT[input.type] ?? 'Open'
  const body = input.body?.trim() || null

  const html = buildBaseEmail({
    ...eventParams(event),
    previewText: body ? body.slice(0, 140) : input.title,
    heading: input.title,
    bodyHtml: `
      <p style="margin: 0 0 16px 0;">${escapeHtml(greeting)}</p>
      ${body ? textToHtml(body) : ''}
    `,
    ctaUrl: ctaUrl ?? undefined,
    ctaText: ctaUrl ? ctaText : undefined,
    footerNote: 'You can change which emails you get in the notification settings for this event.',
  })

  return {
    subject: subjectFor(input.title, event),
    html,
    text: buildPlainText({
      heading: input.title,
      paragraphs: [greeting, body],
      ctaUrl,
      ctaText,
      footerNote: 'You can change which emails you get in the notification settings for this event.',
      eventName: event.name,
    }),
  }
}
