/**
 * The report vocabulary. Safe for the browser: no server imports.
 *
 * Reasons are an enum, not free text, for the reason spec §9 gives for the moderation queue:
 * only the enum-only projection is ever anything but organizer-private. The free text a
 * reporter adds is `details`, and it never leaves the queue.
 */

export const REPORT_REASONS = [
  'harassment',
  'hate',
  'spam',
  'sexual_content',
  'violence',
  'impersonation',
  'code_of_conduct',
  'off_topic',
  'other',
] as const

export type ReportReason = (typeof REPORT_REASONS)[number]

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: 'Harassment or bullying',
  hate: 'Hate speech',
  spam: 'Spam or scam',
  sexual_content: 'Sexual content',
  violence: 'Violence or threats',
  impersonation: 'Impersonation',
  code_of_conduct: 'Breaks the code of conduct',
  off_topic: 'Not what this gathering is for',
  other: 'Something else',
}

export const REPORT_SUBJECT_KINDS = ['session', 'profile', 'comment'] as const
export type ReportSubjectKind = (typeof REPORT_SUBJECT_KINDS)[number]

export const REPORT_SUBJECT_LABELS: Record<ReportSubjectKind, string> = {
  session: 'Session',
  profile: 'Person',
  comment: 'Comment',
}

export const MODERATION_ACTIONS = ['dismiss', 'hide_session', 'remove_member', 'note'] as const
export type ModerationAction = (typeof MODERATION_ACTIONS)[number]

export const MODERATION_ACTION_LABELS: Record<ModerationAction, string> = {
  dismiss: 'Dismissed',
  hide_session: 'Session hidden',
  remove_member: 'Removed from the gathering',
  note: 'Noted',
}

/** What the reporter is told. Never the organizer's note, never the subject's identity. */
export const MODERATION_OUTCOME_SENTENCE: Record<ModerationAction, string> = {
  dismiss: 'The organizers looked at your report and decided no action was needed.',
  hide_session: 'The organizers looked at your report and removed that session from the listings.',
  remove_member: 'The organizers looked at your report and removed that person from the gathering.',
  note: 'The organizers have your report and have noted it. Nothing is being changed right now.',
}

export const MAX_REPORT_DETAILS = 2000

export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value)
}

export function isReportSubjectKind(value: unknown): value is ReportSubjectKind {
  return typeof value === 'string' && (REPORT_SUBJECT_KINDS as readonly string[]).includes(value)
}

export function isModerationAction(value: unknown): value is ModerationAction {
  return typeof value === 'string' && (MODERATION_ACTIONS as readonly string[]).includes(value)
}
