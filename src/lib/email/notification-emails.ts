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
  /** Extra SMTP headers (RFC 8058 unsubscribe); pass straight to `sendMail`. */
  headers?: Record<string, string>
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
// CO-HOST INVITATION EMAIL
// =============================================================================

interface CohostInviteEmailParams {
  event: EventInfo
  /** The proposer, as they present themselves; null for an organizer-curated session. */
  inviterName: string | null
  sessionTitle: string
  inviteToken: string
  expiresAt: string
}

/**
 * The co-host invite link, delivered (inventory 4.3). The link still names nobody: it is
 * the same opaque token the clipboard button copies, and whoever opens it becomes a
 * co-host only by accepting it themselves (spec §4.2 double opt-in).
 */
export function buildCohostInviteEmail(params: CohostInviteEmailParams): EmailContent {
  const { event, inviterName, sessionTitle, inviteToken, expiresAt } = params
  const expiresText = new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  })
  const ctaUrl = `${appUrl()}/invite/${encodeURIComponent(inviteToken)}`
  const who = inviterName?.trim() || 'An organizer'

  const html = buildBaseEmail({
    ...eventParams(event),
    previewText: `${who} would like you to co-host "${sessionTitle}"`,
    heading: 'Co-host a session?',
    bodyHtml: `
      <p style="margin: 0 0 16px 0;">Hey there,</p>
      <p style="margin: 0 0 16px 0;"><strong style="color: #ffffff;">${escapeHtml(who)}</strong> would like you to co-host a session at <strong style="color: #ffffff;">${escapeHtml(event.name)}</strong>:</p>
      <p style="margin: 0 0 16px 0; font-weight: 600; font-size: 17px; color: #ffffff;">&ldquo;${escapeHtml(sessionTitle)}&rdquo;</p>
      <p style="margin: 0;">Nothing happens until you accept. Accepting writes a co-host record into your own repository; you can step down later, which deletes it.</p>
    `,
    ctaUrl,
    ctaText: 'See the invitation',
    footerNote: `This link can be accepted once and expires on ${expiresText}. If you were not expecting it, ignore it.`,
  })

  return {
    subject: `${who} invited you to co-host "${sessionTitle}"`.replace(/[\r\n]+/g, ' '),
    html,
    text: buildPlainText({
      heading: 'Co-host a session?',
      paragraphs: [
        `${who} would like you to co-host "${sessionTitle}" at ${event.name}.`,
        'Nothing happens until you accept.',
      ],
      ctaUrl,
      ctaText: 'See the invitation',
      footerNote: `This link can be accepted once and expires on ${expiresText}.`,
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
  event_published: 'Visit the gathering',
  proposals_open: 'Propose a session',
  rsvp_promoted: 'View your session',
}

export interface NotificationEmailInput {
  type: string
  title: string
  body: string | null
  /** App-relative (`/e/slug/...`) or absolute on the app origin; anything else is dropped. */
  actionUrl: string | null
  recipientName: string | null
  event: EventInfo | null
  /** Where "stop emails like this" goes; omitted only when no signing key is configured. */
  unsubscribeUrl?: string | null
  /** RFC 8058 headers for this recipient. */
  unsubscribeHeaders?: Record<string, string> | null
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
    unsubscribeUrl: input.unsubscribeUrl ?? undefined,
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
      unsubscribeUrl: input.unsubscribeUrl,
    }),
    ...(input.unsubscribeHeaders ? { headers: input.unsubscribeHeaders } : {}),
  }
}

// =============================================================================
// DIGEST
// =============================================================================

export interface DigestItem {
  type: string
  title: string
  body: string | null
  actionUrl: string | null
}

export interface DigestInput {
  items: readonly DigestItem[]
  recipientName: string | null
  event: EventInfo | null
  unsubscribeUrl?: string | null
  unsubscribeHeaders?: Record<string, string> | null
}

/**
 * One email for everything that piled up past a recipient's hourly limit (inventory P2-8).
 * Before this, mail over the limit was dropped after a day as `rate_limited`; a flood is a
 * reason to batch, not a reason to say nothing.
 */
export function renderDigestEmail(input: DigestInput): EmailContent {
  const event: EventInfo = input.event ?? { name: PRODUCT_NAME, slug: '' }
  const greeting = input.recipientName ? `Hey ${input.recipientName},` : 'Hey there,'
  const n = input.items.length
  const heading = `${n} update${n === 1 ? '' : 's'} from ${event.name}`

  const rows = input.items
    .map((item) => {
      const link = notificationLink(item.actionUrl)
      const label = escapeHtml(item.title)
      const line = link
        ? `<a href="${escapeHtml(link)}" style="color: #B2FF00; text-decoration: none;">${label}</a>`
        : label
      const detail = item.body?.trim() ? `<br><span style="color: #8b949e; font-size: 14px;">${escapeHtml(item.body.trim())}</span>` : ''
      return `<li style="margin: 0 0 12px 0;">${line}${detail}</li>`
    })
    .join('')

  const html = buildBaseEmail({
    ...eventParams(event),
    previewText: heading,
    heading,
    bodyHtml: `
      <p style="margin: 0 0 16px 0;">${escapeHtml(greeting)}</p>
      <p style="margin: 0 0 16px 0;">More happened than fits in one email an hour, so here it is together:</p>
      <ul style="margin: 0; padding-left: 20px;">${rows}</ul>
    `,
    ctaUrl: event.slug ? `${appUrl()}/e/${encodeURIComponent(event.slug)}` : undefined,
    ctaText: event.slug ? 'Open the gathering' : undefined,
    footerNote: 'You can change which emails you get in the notification settings for this event.',
    unsubscribeUrl: input.unsubscribeUrl ?? undefined,
  })

  return {
    subject: subjectFor(`${n} update${n === 1 ? '' : 's'}`, event),
    html,
    text: buildPlainText({
      heading,
      paragraphs: [greeting, ...input.items.map((i) => `• ${i.title}${i.body?.trim() ? ` — ${i.body.trim()}` : ''}`)],
      footerNote: 'You can change which emails you get in the notification settings for this event.',
      eventName: event.name,
      unsubscribeUrl: input.unsubscribeUrl,
    }),
    ...(input.unsubscribeHeaders ? { headers: input.unsubscribeHeaders } : {}),
  }
}
