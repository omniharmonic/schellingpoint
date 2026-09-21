import { asAccount, dbErrorResponse, sql } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { validateApiKey } from '@/lib/api/auth'
import { notify, type NotificationType } from '@/lib/notifications'
import { validateSkillUris } from '@/lib/atproto/skills'
import { flagProposalWithdrawn } from '@/lib/atproto/drift'
import { apiSuccess, unauthorized, badRequest, notFound, methodNotAllowed, isValidUUID } from '@/lib/api/response'
import {
  canSeeSession,
  json,
  jsonError,
  loadSessionEventAccess,
  readJsonObject,
  sessionRelation,
} from '../_lib/access'
import { getSession } from '../_lib/read'
import {
  CONTENT_COLUMNS,
  CURATION_COLUMNS,
  FieldError,
  LOGISTICS_COLUMNS,
  RECORD_FIELDS,
  parseSessionFields,
  parseTimePreference,
} from '../_lib/validate'
import { publishProposalFor, withdrawProposalFor, type AtprotoOutcome } from '../_lib/atproto'
import { reconcileTimePreference, saveTimePreference } from '../_lib/time-preference'
import { partnerSessions } from '../_lib/partner'

type Params = { params: Promise<{ id: string }> }

/** GET /api/v1/sessions/[id] — partner read API (x-api-key); public/unlisted non-draft events only. */
export async function GET(request: Request, { params }: Params) {
  if (!validateApiKey(request)) return unauthorized()
  const { id } = await params
  if (!isValidUUID(id)) return badRequest('Invalid session ID format. Expected a UUID.')

  const url = new URL(request.url)
  const requestedSlug = url.searchParams.get('event')?.trim() || null
  const events = await sql<{ id: string; slug: string }[]>`
    select e.id, e.slug from events e join sessions s on s.event_id = e.id
    where s.id = ${id} and e.visibility in ('public', 'unlisted') and e.status <> 'draft'
  `
  const event = events[0]
  if (!event || (requestedSlug && requestedSlug !== event.slug)) return notFound('Session')

  const [session] = await partnerSessions({
    eventId: event.id,
    statuses: ['approved', 'scheduled'],
    includes: ['host', 'track', 'venue', 'timeslot', 'cohosts'],
    sessionId: id,
  })
  if (!session) return notFound('Session')
  return apiSuccess(session)
}

function normalize(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return value.length ? JSON.stringify(value) : 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value))) {
    return JSON.stringify(new Date(value).toISOString())
  }
  return JSON.stringify(value)
}

function sameValue(a: unknown, b: unknown): boolean {
  return normalize(a) === normalize(b)
}

/**
 * Who may change which columns (spec §4.2: the proposal lives in the proposer's repo and nobody
 * else edits it or writes into that repo on their behalf):
 *   - proposal content (+ availability): the author only; on a host-less session, organizers
 *   - track: the author (their suggestion) or organizers (curation)
 *   - Telegram group: the session's hosts, co-hosts and organizers
 *   - status / venue / slot / type: sent through, so the database guard decides
 */
function authorizeFields(
  keys: string[],
  hasTimePreference: boolean,
  rel: { isHost: boolean; isCohost: boolean; host_id: string | null },
  isOrganizer: boolean,
): Response | null {
  const authored = !!rel.host_id
  const contentEditor = authored ? rel.isHost : isOrganizer
  for (const key of keys) {
    if (CONTENT_COLUMNS.has(key) && !contentEditor) {
      return jsonError(403, authored
        ? 'Only the proposer can change their proposal. Ask them to update it instead.'
        : 'Only organizers can change this session’s content', { field: key === 'skill_uris' ? 'skills' : key, code: 'author_only' })
    }
    if (CURATION_COLUMNS.has(key) && !(rel.isHost || isOrganizer)) {
      return jsonError(403, 'Only the proposer or an organizer can set the track', { field: key })
    }
    if (LOGISTICS_COLUMNS.has(key) && !(rel.isHost || rel.isCohost || isOrganizer)) {
      return jsonError(403, 'Only this session’s hosts and organizers can change attendee details', { field: key })
    }
  }
  if (hasTimePreference && !rel.isHost) {
    return jsonError(403, 'Only the proposer sets their own availability', { field: 'time_preference' })
  }
  return null
}

const STATUS_NOTIFICATIONS: Record<string, { type: NotificationType; title: string }> = {
  approved: { type: 'session_approved', title: 'Your session was approved' },
  rejected: { type: 'session_rejected', title: 'Your session was not selected' },
  scheduled: { type: 'session_scheduled', title: 'Your session is on the schedule' },
}

/**
 * PATCH /api/v1/sessions/[id] — edit a session.
 *
 * Field authority is in `authorizeFields`: proposal content is the author's alone (organizers
 * edit only host-less sessions); organizers curate track and status; co-hosts manage attendee
 * logistics. Organizer-only columns (`status`, `venue_id`, `time_slot_id`, `session_type`,
 * `is_votable`, `rejection_reason`) go through as the editor, so RLS and
 * `enforce_session_update_rules` decide: a host who sends `status` gets the database's 403.
 * A published session is moved or cancelled through the schedule builder, not here (409).
 *
 * After commit, only when the AUTHOR changed a field of their proposal record, their
 * `schellingpoint.draft.proposal` is rewritten in their repository with CAS (F).
 * `time_preference` (the proposer only) is stored app-side and published only on opt-in.
 */
export async function PATCH(request: Request, { params }: Params) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { id } = await params

  const access = await loadSessionEventAccess(request, id)
  if (access instanceof Response) return access
  const rel = await sessionRelation(sql, id, access.event.id, viewer.accountId)
  if (!rel || !canSeeSession(rel, access)) return jsonError(404, 'Session not found')

  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  if ('host_id' in body || 'host_name' in body) {
    return jsonError(400, 'Hosts are not assigned by editing a session. Invite co-hosts; they accept themselves.', { field: 'host_id' })
  }

  let fields: Record<string, unknown>
  let timePreference: ReturnType<typeof parseTimePreference>
  try {
    fields = parseSessionFields(body, false)
    timePreference = parseTimePreference(body.time_preference)
  } catch (e) {
    if (e instanceof FieldError) return jsonError(400, e.message, { field: e.field })
    throw e
  }
  if (Object.keys(fields).length === 0 && !timePreference) return jsonError(400, 'Nothing to update')

  // Only columns whose value actually changes are written, so an unchanged save neither trips
  // the organizer guard on a column it did not touch nor rewrites the public record.
  if (Object.keys(fields).length) {
    const [current] = await sql<Record<string, unknown>[]>`
      select ${sql(Object.keys(fields))} from sessions where id = ${id} and event_id = ${access.event.id}
    `
    for (const key of Object.keys(fields)) {
      if (current && sameValue(current[key], fields[key])) delete fields[key]
    }
  }

  if (!rel.isHost && !rel.isCohost && !access.isOrganizer) {
    return jsonError(403, 'Only this session’s hosts and the event’s organizers can edit it')
  }
  const refusal = authorizeFields(Object.keys(fields), !!timePreference, rel, access.isOrganizer)
  if (refusal) return refusal
  const movesSchedule = 'venue_id' in fields || 'time_slot_id' in fields || ('status' in fields && fields.status !== rel.status)
  if (access.isOrganizer && movesSchedule && rel.calendar_event_uri) {
    return jsonError(409, 'This session is on the published schedule. Move or cancel it from the schedule builder.', { code: 'published_session' })
  }
  if (Array.isArray(fields.skill_uris) && fields.skill_uris.length) {
    const checked = await validateSkillUris(fields.skill_uris)
    if (!checked.ok) return jsonError(400, checked.error, { field: 'skills' })
  }
  if (fields.track_id) {
    const tracks = await sql`select 1 from tracks where id = ${fields.track_id as string} and event_id = ${access.event.id}`
    if (!tracks.length) return jsonError(400, 'Choose one of this event’s tracks', { field: 'track_id' })
  }

  const statusChanged = typeof fields.status === 'string' && fields.status !== rel.status
  let updated: { host_id: string | null; title: string; status: string } | null
  try {
    updated = await asAccount(viewer.accountId, async (t) => {
      let row: { host_id: string | null; title: string; status: string } | null = { host_id: rel.host_id, title: rel.title, status: rel.status }
      const keys = Object.keys(fields)
      if (keys.length) {
        if (fields.public_geo) fields.public_geo = sql.json(fields.public_geo as never)
        const rows = await t<{ host_id: string | null; title: string; status: string }[]>`
          update sessions set ${t(fields as Record<string, string>, keys as never)}, updated_at = now()
          where id = ${id} and event_id = ${access.event.id}
          returning host_id, title, status
        `
        row = rows[0] ?? null
        if (!row) return null
      }
      // time_preferences and notifications are service-side tables; the person-scoped write is done.
      await t`reset role`
      if (timePreference) {
        await saveTimePreference(t, { eventId: access.event.id, sessionId: id, accountId: viewer.accountId, input: timePreference })
      }
      if (statusChanged && STATUS_NOTIFICATIONS[row.status]) {
        const cohosts = await t<{ user_id: string }[]>`select user_id from session_cohosts where session_id = ${id}`
        const note = STATUS_NOTIFICATIONS[row.status]
        await notify(t, {
          eventId: access.event.id,
          userIds: [row.host_id, ...cohosts.map((c) => c.user_id)].filter((u) => u !== viewer.accountId),
          type: note.type,
          title: note.title,
          body: `"${row.title}"`,
          actionUrl: `/e/${access.event.slug}/sessions/${id}`,
          data: { session_id: id, session_title: row.title },
        })
      }
      return row
    })
  } catch (e) {
    const mapped = dbErrorResponse(e)
    if (mapped) return mapped
    throw e
  }
  if (!updated) return jsonError(403, 'You do not have permission to edit this session')

  // Only the author's own edit rewrites their record; organizer curation (track, status, type)
  // stays app-side and never touches the proposer's repository.
  let atproto: AtprotoOutcome | undefined
  const recordChanged = Object.keys(fields).some((k) => RECORD_FIELDS.has(k))
  if (recordChanged && rel.isHost && updated.host_id === viewer.accountId) {
    atproto = await publishProposalFor(id, viewer.accountId)
  }
  let timeOutcome: AtprotoOutcome | undefined
  if (timePreference) {
    timeOutcome = await reconcileTimePreference(id, viewer.accountId, timePreference)
  }

  const session = await getSession(access, id)
  return json({ session, ...(atproto ? { atproto } : {}), ...(timeOutcome ? { time_preference: timeOutcome } : {}) })
}

/**
 * DELETE /api/v1/sessions/[id] — the proposer withdraws their proposal.
 *
 * The proposal record is deleted from the proposer's repository first (F). A session that
 * is not on the schedule is then removed; a scheduled one stays for the organizers to
 * decide on (spec §6: withdrawal is surfaced, the schedule is never changed automatically).
 * Organizers decline proposals by status instead; they never delete a person's proposal.
 */
export async function DELETE(request: Request, { params }: Params) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { id } = await params

  const access = await loadSessionEventAccess(request, id)
  if (access instanceof Response) return access
  const rel = await sessionRelation(sql, id, access.event.id, viewer.accountId)
  if (!rel || !canSeeSession(rel, access)) return jsonError(404, 'Session not found')
  if (!rel.isHost) {
    return jsonError(403, access.isOrganizer
      ? 'Organizers decline a proposal instead of deleting it'
      : 'Only the proposer can withdraw a proposal')
  }

  const atproto: AtprotoOutcome = rel.proposal_uri ? await withdrawProposalFor(id, viewer.accountId) : { skipped: 'nothing_to_withdraw' }
  if (atproto.error) {
    return jsonError(502, 'Your proposal could not be removed from your repository. Try again.', { atproto })
  }

  const keep = rel.status === 'scheduled' || !!rel.calendar_event_uri
  if (keep) {
    // The schedule is the organizers' to change; flag it for them (F notifies once, whether
    // the flag comes from here or from ingest seeing the record disappear).
    if (!atproto.uri) await flagProposalWithdrawn({ sessionId: id })
  } else {
    try {
      const removed = await asAccount(viewer.accountId, async (t) => {
        const rows = await t`delete from sessions where id = ${id} and event_id = ${access.event.id} and host_id = ${viewer.accountId} returning id`
        return rows.length
      })
      if (!removed) return jsonError(403, 'You do not have permission to remove this session')
    } catch (e) {
      const mapped = dbErrorResponse(e)
      if (mapped) return mapped
      throw e
    }
  }
  return json({ withdrawn: true, deleted: !keep, atproto })
}

export async function POST() { return methodNotAllowed() }
export async function PUT() { return methodNotAllowed() }
