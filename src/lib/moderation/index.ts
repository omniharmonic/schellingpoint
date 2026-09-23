import 'server-only'
/**
 * Reports and the organizer moderation queue (MT §12.5, spec §9 `sp_moderation_queue`).
 *
 * The rules this module exists to keep:
 *
 *   · A report is **private to the organizers of the gathering it is about**. It is never
 *     shown to the person reported, never published, and never readable across gatherings —
 *     another gathering's organizers are the public (spec §8).
 *   · A report names its subject by account id. No DID, no handle, no email is written into
 *     the row, so a leaked case file cannot be joined to the network.
 *   · Moderation acts **app-side only**. Hiding a session sets a flag on our row; the
 *     author's proposal record stays exactly where it is, in their repo, untouched. There is
 *     no world in which this app edits or deletes somebody else's record (spec §4.2).
 *   · The reporter is told the outcome, in an enum's worth of detail. The organizer's note
 *     stays in the queue.
 */
import { sql, tx, type Sql } from '@/lib/db'
import { notify } from '@/lib/notifications'
import { leaveGatheringIn, retractAfterLeave } from '@/lib/members/leave'
import type { EventRoleName } from '@/types/event'
import {
  MODERATION_OUTCOME_SENTENCE,
  type ModerationAction,
  type ReportReason,
  type ReportSubjectKind,
} from './reasons'

export * from './reasons'

/* ───────────────────────────── rate limits ───────────────────────────── */

/**
 * Reporting is free and anonymous-to-the-subject, which is exactly the shape of thing that
 * gets used as a weapon. The caps are per account across every gathering, because the abuse
 * is one person filing everywhere, not one person filing here.
 */
export const REPORT_LIMITS = { perHour: 10, perDay: 30 } as const

export class ReportRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('You have filed a lot of reports just now. Give the organizers a moment to read them.')
    this.name = 'ReportRateLimitedError'
  }
}

async function assertUnderLimit(db: Sql, accountId: string): Promise<void> {
  const [row] = await db<{ last_hour: number; last_day: number; oldest_in_hour: string | null }[]>`
    select
      count(*) filter (where created_at > now() - interval '1 hour')::int as last_hour,
      count(*) filter (where created_at > now() - interval '1 day')::int as last_day,
      min(created_at) filter (where created_at > now() - interval '1 hour') as oldest_in_hour
    from moderation_reports
    where reporter_account_id = ${accountId}
  `
  const hour = row?.last_hour ?? 0
  const day = row?.last_day ?? 0
  if (hour < REPORT_LIMITS.perHour && day < REPORT_LIMITS.perDay) return
  const oldest = row?.oldest_in_hour ? Date.parse(row.oldest_in_hour) : Date.now()
  const retry = hour >= REPORT_LIMITS.perHour
    ? Math.max(60, Math.ceil((oldest + 3_600_000 - Date.now()) / 1000))
    : 3_600
  throw new ReportRateLimitedError(retry)
}

/* ───────────────────────────── filing ───────────────────────────── */

export class ReportError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'BadRequest') {
    super(message)
    this.name = 'ReportError'
  }
}

export interface FileReportInput {
  eventId: string
  reporterAccountId: string
  subjectKind: ReportSubjectKind
  /** For `session`. Must belong to this gathering. */
  sessionId?: string | null
  /** For `profile`. An account id — never a DID (spec §9). */
  accountId?: string | null
  /** For `comment`: the app-side id of the item (a resource row, a feedback entry). */
  ref?: string | null
  reason: ReportReason
  details?: string | null
}

export interface FiledReport {
  id: string
  status: 'open'
  createdAt: string
  /** True when an identical open report by this person already existed; nothing was filed twice. */
  duplicate: boolean
}

/**
 * File a report. Validates the subject against *this* gathering, so a member cannot use one
 * gathering's report form to name a session or a person in another.
 */
export async function fileReport(input: FileReportInput): Promise<FiledReport> {
  await assertUnderLimit(sql, input.reporterAccountId)

  let sessionId: string | null = null
  let accountId: string | null = null
  let ref: string | null = null

  if (input.subjectKind === 'session') {
    if (!input.sessionId) throw new ReportError('Say which session you are reporting.')
    const [row] = await sql<{ id: string }[]>`
      select id from sessions where id = ${input.sessionId} and event_id = ${input.eventId}
    `
    if (!row) throw new ReportError('That session is not part of this gathering.', 404, 'NotFound')
    sessionId = row.id
  } else if (input.subjectKind === 'profile') {
    if (!input.accountId) throw new ReportError('Say who you are reporting.')
    if (input.accountId === input.reporterAccountId) throw new ReportError('You cannot report yourself.')
    const [row] = await sql<{ user_id: string }[]>`
      select user_id from event_members where event_id = ${input.eventId} and user_id = ${input.accountId}
    `
    if (!row) throw new ReportError('That person is not part of this gathering.', 404, 'NotFound')
    accountId = row.user_id
  } else {
    ref = (input.ref ?? '').trim().slice(0, 200)
    if (!ref) throw new ReportError('Say which comment you are reporting.')
  }

  const details = (input.details ?? '').trim().slice(0, 2000) || null

  const [row] = await sql<{ id: string; created_at: string }[]>`
    insert into moderation_reports (event_id, reporter_account_id, subject_kind, subject_session_id, subject_account_id, subject_ref, reason, details)
    values (${input.eventId}, ${input.reporterAccountId}, ${input.subjectKind}, ${sessionId}, ${accountId}, ${ref}, ${input.reason}, ${details})
    on conflict do nothing
    returning id, created_at
  `
  if (row) return { id: row.id, status: 'open', createdAt: row.created_at, duplicate: false }

  // The partial unique index refused it: this person already has an open report on this
  // subject. Return the standing one rather than telling them nothing happened.
  const [existing] = await sql<{ id: string; created_at: string }[]>`
    select id, created_at from moderation_reports
    where event_id = ${input.eventId} and reporter_account_id = ${input.reporterAccountId}
      and subject_kind = ${input.subjectKind} and status = 'open'
      and subject_session_id is not distinct from ${sessionId}
      and subject_account_id is not distinct from ${accountId}
      and subject_ref is not distinct from ${ref}
    limit 1
  `
  if (!existing) throw new ReportError('Your report could not be filed. Try again.', 500, 'NotFiled')
  return { id: existing.id, status: 'open', createdAt: existing.created_at, duplicate: true }
}

/* ───────────────────────────── the queue ───────────────────────────── */

export interface QueuedReport {
  id: string
  status: 'open' | 'dismissed' | 'actioned'
  reason: ReportReason
  subjectKind: ReportSubjectKind
  details: string | null
  createdAt: string
  /** The reporter's display name, for organizers only. Never leaves this queue. */
  reporter: { accountId: string; name: string } | null
  subject: {
    sessionId: string | null
    sessionTitle: string | null
    sessionHidden: boolean
    accountId: string | null
    name: string | null
    ref: string | null
  }
  resolution: { action: ModerationAction | null; note: string | null; at: string | null; by: string | null } | null
}

interface QueueRow {
  id: string
  status: QueuedReport['status']
  reason: ReportReason
  subject_kind: ReportSubjectKind
  details: string | null
  created_at: string
  reporter_id: string | null
  reporter_name: string | null
  subject_session_id: string | null
  session_title: string | null
  session_hidden: boolean | null
  subject_account_id: string | null
  subject_name: string | null
  subject_ref: string | null
  action: ModerationAction | null
  note: string | null
  resolved_at: string | null
  resolver_name: string | null
}

/** The organizer queue for one gathering. `status: 'open'` by default. */
export async function listReports(
  eventId: string,
  opts: { status?: 'open' | 'resolved' | 'all'; limit?: number } = {},
): Promise<QueuedReport[]> {
  const status = opts.status ?? 'open'
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500)
  const rows = await sql<QueueRow[]>`
    select r.id, r.status, r.reason, r.subject_kind, r.details, r.created_at,
           r.reporter_account_id as reporter_id, rp.display_name as reporter_name,
           r.subject_session_id, s.title as session_title, s.hidden_by_moderation as session_hidden,
           r.subject_account_id, sp.display_name as subject_name, r.subject_ref,
           r.action, r.note, r.resolved_at, vp.display_name as resolver_name
    from moderation_reports r
    left join profiles rp on rp.id = r.reporter_account_id
    left join profiles sp on sp.id = r.subject_account_id
    left join profiles vp on vp.id = r.resolved_by
    left join sessions s on s.id = r.subject_session_id
    where r.event_id = ${eventId}
      ${status === 'open' ? sql`and r.status = 'open'` : status === 'resolved' ? sql`and r.status <> 'open'` : sql``}
    order by (r.status = 'open') desc, r.created_at desc
    limit ${limit}
  `
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    reason: row.reason,
    subjectKind: row.subject_kind,
    details: row.details,
    createdAt: row.created_at,
    reporter: row.reporter_id ? { accountId: row.reporter_id, name: row.reporter_name?.trim() || 'A member' } : null,
    subject: {
      sessionId: row.subject_session_id,
      sessionTitle: row.session_title,
      sessionHidden: row.session_hidden ?? false,
      accountId: row.subject_account_id,
      name: row.subject_name?.trim() || null,
      ref: row.subject_ref,
    },
    resolution: row.status === 'open'
      ? null
      : { action: row.action, note: row.note, at: row.resolved_at, by: row.resolver_name?.trim() || null },
  }))
}

export async function countOpenReports(eventId: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from moderation_reports where event_id = ${eventId} and status = 'open'
  `
  return row?.n ?? 0
}

/* ───────────────────────────── resolving ───────────────────────────── */

export interface ResolveInput {
  eventId: string
  eventSlug: string
  reportId: string
  resolverAccountId: string
  /** The resolver's role in this gathering. Moderators may not remove organizers. */
  resolverRole: EventRoleName
  action: ModerationAction
  note?: string | null
}

/** What became of an already-published calendar event when its session was hidden. */
export type PublishedRecordOutcome =
  | 'not-published'
  | 'cancel-applied'
  | 'cancel-awaiting-approval'
  | 'needs-owner-or-admin'
  | 'cancel-failed'

export interface ResolveOutcome {
  id: string
  status: 'open' | 'dismissed' | 'actioned'
  action: ModerationAction
  /** Set when the action was `remove_member` and the removal could not happen. */
  blocked?: 'last-owner' | 'not-a-member' | 'no-subject'
  /** Set when the action was `hide_session`. */
  publishedRecord?: PublishedRecordOutcome
}

const PUBLISHED_RECORD_SENTENCE: Record<PublishedRecordOutcome, string> = {
  'not-published': 'Nothing of this session was on the network, so hiding it here is the whole of it.',
  'cancel-applied': 'The published calendar event has been cancelled on the network.',
  'cancel-awaiting-approval': 'A cancellation of the published calendar event has been requested and is waiting for another organizer to approve it.',
  'needs-owner-or-admin':
    'The published calendar event REMAINS on the network: hiding a session here changes only this app’s listings. An owner or admin must cancel it from the schedule, with the usual two-organizer approval.',
  'cancel-failed':
    'The published calendar event REMAINS on the network and the cancellation could not be requested. An owner or admin must cancel it from the schedule.',
}

/**
 * Resolve one report. `dismiss` closes it with nothing changed; `note` keeps it open with the
 * organizer's note attached (the case is being watched, not decided); `hide_session` and
 * `remove_member` act, then close it.
 *
 * Everything that touches the database happens in ONE transaction — the decision, the removal
 * and the reporter's notification together, so a rolled-back decision leaves neither a departed
 * member nor a notification behind (spec §9: emission at the action site, never from a trigger).
 * The network work runs afterwards, because a transaction held open across a call to a PDS is a
 * row lock held open across a call to a PDS.
 *
 * Two guards that are the point of the function:
 *   · a case is resolved once. A second click on a stale page is a 409, not a second removal.
 *   · a moderator may act on members, not on organizers. Removing an owner or an admin is an
 *     owner's decision, exactly as it is on the roster (`members/[userId]`), or the moderation
 *     queue becomes a way around the roster's own rules.
 */
export async function resolveReport(input: ResolveInput): Promise<ResolveOutcome> {
  const note = (input.note ?? '').trim().slice(0, 2000) || null

  const committed = await tx(async (t) => {
    const [report] = await t<{
      id: string
      status: 'open' | 'dismissed' | 'actioned'
      reason: ReportReason
      reporter_account_id: string | null
      subject_session_id: string | null
      subject_account_id: string | null
    }[]>`
      select id, status, reason, reporter_account_id, subject_session_id, subject_account_id
      from moderation_reports
      where id = ${input.reportId} and event_id = ${input.eventId}
      for update
    `
    if (!report) throw new ReportError('That report is not in this queue.', 404, 'NotFound')
    if (report.status !== 'open') {
      throw new ReportError('Another organizer has already dealt with this report.', 409, 'AlreadyResolved')
    }

    let blocked: ResolveOutcome['blocked']
    let leftUris: string[] = []
    let publishedRecord: PublishedRecordOutcome | undefined
    let cancelSessionId: string | null = null

    if (input.action === 'hide_session') {
      if (!report.subject_session_id) blocked = 'no-subject'
      else {
        const [hidden] = await t<{ calendar_event_uri: string | null }[]>`
          update sessions
          set hidden_by_moderation = true, hidden_at = now(), hidden_by = ${input.resolverAccountId}
          where id = ${report.subject_session_id} and event_id = ${input.eventId}
          returning calendar_event_uri
        `
        // Hiding is an app-side listing decision. A calendar event already published to the
        // network is a promise other people put in their calendars, and only the destructive
        // approval flow may withdraw it — so ask for that, and say plainly what happens if we
        // cannot. The author's proposal record is never touched either way.
        if (!hidden?.calendar_event_uri) publishedRecord = 'not-published'
        else if (input.resolverRole !== 'owner' && input.resolverRole !== 'admin') publishedRecord = 'needs-owner-or-admin'
        else cancelSessionId = report.subject_session_id
      }
    }

    if (input.action === 'remove_member') {
      if (!report.subject_account_id) blocked = 'no-subject'
      else {
        const [subject] = await t<{ role: EventRoleName }[]>`
          select role from event_members
          where event_id = ${input.eventId} and user_id = ${report.subject_account_id}
          for update
        `
        if (!subject) blocked = 'not-a-member'
        else if ((subject.role === 'owner' || subject.role === 'admin') && input.resolverRole !== 'owner') {
          throw new ReportError(
            'Only an owner of this gathering can remove one of its organizers.',
            403,
            'OwnerOnly',
          )
        } else {
          const left = await leaveGatheringIn(t, input.eventId, report.subject_account_id)
          if (!left.ok) blocked = left.reason
          else leftUris = left.publicRsvpUris
        }
      }
    }

    const closes = !blocked && input.action !== 'note'
    const status: ResolveOutcome['status'] = closes ? (input.action === 'dismiss' ? 'dismissed' : 'actioned') : 'open'
    const recorded = publishedRecord
      ? [note, `[published record] ${PUBLISHED_RECORD_SENTENCE[publishedRecord]}`].filter(Boolean).join('\n\n').slice(0, 2000)
      : note

    await t`
      update moderation_reports
      set status = ${status}, action = ${input.action}, note = ${recorded},
          resolved_by = ${closes ? input.resolverAccountId : null},
          resolved_at = ${closes ? new Date() : null}
      where id = ${report.id}
    `

    if (closes && report.reporter_account_id) {
      // `admin_announcement` carries it: there is no report-specific notification type, and
      // inventing one would mean touching the shared type CHECK for a single sentence.
      await notify(t, {
        eventId: input.eventId,
        userIds: [report.reporter_account_id],
        type: 'admin_announcement',
        title: 'Your report was reviewed',
        body: MODERATION_OUTCOME_SENTENCE[input.action],
        actionUrl: `/e/${input.eventSlug}`,
        data: { kind: 'moderation_outcome', action: input.action },
      })
    }

    return {
      outcome: { id: report.id, status, action: input.action, ...(blocked ? { blocked } : {}), ...(publishedRecord ? { publishedRecord } : {}) } as ResolveOutcome,
      removedAccountId: leftUris.length || (!blocked && input.action === 'remove_member') ? report.subject_account_id : null,
      leftUris,
      cancelSessionId,
      reason: report.reason,
    }
  })

  // ── after the commit: the network work ────────────────────────────────────
  if (committed.removedAccountId) {
    await retractAfterLeave(input.eventId, committed.removedAccountId, committed.leftUris)
  }

  if (committed.cancelSessionId) {
    let outcome: PublishedRecordOutcome = 'cancel-failed'
    try {
      const { requestSessionCancel } = await import('@/lib/atproto/approvals')
      const result = await requestSessionCancel({
        eventId: input.eventId,
        sessionId: committed.cancelSessionId,
        callerUserId: input.resolverAccountId,
        reason: `Hidden by moderation (${committed.reason}).`,
      })
      outcome = result.status === 'applied' ? 'cancel-applied' : 'cancel-awaiting-approval'
    } catch (e) {
      console.error('[moderation] cancel request for a hidden session failed:', e instanceof Error ? e.name : 'error')
    }
    await sql`
      update moderation_reports
      set note = left(coalesce(note, '') || ${`\n\n[published record] ${PUBLISHED_RECORD_SENTENCE[outcome]}`}, 2000)
      where id = ${input.reportId}
    `.catch(() => undefined)
    committed.outcome.publishedRecord = outcome
  }

  return committed.outcome
}

/** Un-hide a session an organizer hid (the queue's only reversal). */
export async function unhideSession(eventId: string, sessionId: string): Promise<boolean> {
  const rows = await sql`
    update sessions set hidden_by_moderation = false, hidden_at = null, hidden_by = null
    where id = ${sessionId} and event_id = ${eventId} and hidden_by_moderation
  `
  return rows.count > 0
}
