import { sql, asAccount, dbErrorResponse } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { validateApiKey } from '@/lib/api/auth'
import { notify } from '@/lib/notifications'
import { validateSkillUris } from '@/lib/atproto/skills'
import { apiSuccess, unauthorized, badRequest, notFound, methodNotAllowed, parseIncludes } from '@/lib/api/response'
import {
  ensurePublicMembership,
  isUuid,
  json,
  jsonError,
  loadEventAccess,
  readJsonObject,
  type EventAccess,
} from './_lib/access'
import { FieldError, parseSessionFields, parseTimePreference } from './_lib/validate'
import { publishProposalFor, type AtprotoOutcome } from './_lib/atproto'
import { reconcileTimePreference, saveTimePreference } from './_lib/time-preference'
import { partnerSessions } from './_lib/partner'

const VALID_INCLUDES = ['host', 'track', 'venue', 'timeslot', 'cohosts']
const VALID_STATUSES = ['pending', 'approved', 'rejected', 'scheduled']

/**
 * GET /api/v1/sessions?event=<slug> — partner read API (x-api-key). Public or unlisted,
 * non-draft events only; R9-filtered like every other read (no vote counts, no free-text
 * host names, no attendee-only details).
 */
export async function GET(request: Request) {
  if (!validateApiKey(request)) return unauthorized()

  const result = parseIncludes(request, VALID_INCLUDES)
  if ('error' in result) return result.error

  const url = new URL(request.url)
  const slug = url.searchParams.get('event')?.trim()
  if (!slug) return badRequest('event query parameter (event slug) is required')

  let statuses = ['approved', 'scheduled']
  const statusParam = url.searchParams.get('status')
  if (statusParam) {
    const requested = statusParam.split(',').map((s) => s.trim())
    const invalid = requested.filter((s) => !VALID_STATUSES.includes(s))
    if (invalid.length > 0) {
      return badRequest(`Invalid status(es): ${invalid.join(', ')}. Valid options: ${VALID_STATUSES.join(', ')}`)
    }
    statuses = requested
  }

  const events = await sql<{ id: string }[]>`
    select id from events
    where slug = ${slug} and visibility in ('public', 'unlisted') and status <> 'draft'
  `
  if (!events[0]) return notFound('Event')

  const data = await partnerSessions({ eventId: events[0].id, statuses, includes: result.includes })
  return apiSuccess(data, data.length)
}

/**
 * POST /api/v1/sessions — propose a session.
 *
 * Body: `event_slug` (or `event_id`), `title`, `format`, `duration`, optional content fields,
 * `time_preference: { windows, blackouts, publish }`. No host name and no co-hosts: the host
 * is the signed-in proposer, and co-hosts accept invitations themselves (spec §4.2, R9).
 *
 * The insert runs as the proposer so `enforce_event_proposal_rules` applies (window, format,
 * duration, per-person limit, approval status). Organizers are notified in the same
 * transaction. After commit the proposal is written to the proposer's own repository when
 * they are custodial or have confirmed public linkage (F).
 *
 * 201 `{ id, status, atproto }`.
 */
export async function POST(request: Request) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  let slug: string | null = typeof body.event_slug === 'string' ? body.event_slug.trim() : null
  if (!slug && isUuid(body.event_id)) {
    const rows = await sql<{ slug: string }[]>`select slug from events where id = ${body.event_id}`
    slug = rows[0]?.slug ?? null
  }
  if (!slug) return jsonError(400, 'event_slug is required', { field: 'event_slug' })

  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access

  let fields: Record<string, unknown>
  let timePreference: ReturnType<typeof parseTimePreference>
  try {
    fields = parseSessionFields(body, true)
    timePreference = parseTimePreference(body.time_preference)
  } catch (e) {
    if (e instanceof FieldError) return jsonError(400, e.message, { field: e.field })
    throw e
  }
  for (const organizerOnly of ['status', 'venue_id', 'time_slot_id', 'session_type', 'is_votable', 'rejection_reason']) {
    delete fields[organizerOnly]
  }
  if (fields.is_self_hosted === true && !fields.custom_location) {
    return jsonError(400, 'Tell attendees where a self-hosted session happens', { field: 'custom_location' })
  }

  if (Array.isArray(fields.skill_uris) && fields.skill_uris.length) {
    const checked = await validateSkillUris(fields.skill_uris)
    if (!checked.ok) return jsonError(400, checked.error, { field: 'skills' })
  }

  const trackError = await checkTrack(access, fields.track_id)
  if (trackError) return trackError

  const accountId = viewer.accountId
  let created: { id: string; status: string; title: string }
  try {
    created = await asAccount(accountId, async (t) => {
      const role = await ensurePublicMembership(t, { ...access, viewer })
      if (!role) {
        const err = new Error('Join this event before proposing a session') as Error & { code: string }
        err.code = '23514'
        throw err
      }
      const row = { ...fields, event_id: access.event.id, host_id: accountId }
      if ('public_geo' in row && row.public_geo) row.public_geo = sql.json(row.public_geo as never)
      const [inserted] = await t<{ id: string; status: string; title: string }[]>`
        insert into sessions ${t(row as Record<string, string>, Object.keys(row) as never)}
        returning id, status, title
      `
      // The person-scoped write is done; time_preferences and notifications are service-side tables.
      await t`reset role`
      if (timePreference) await saveTimePreference(t, { eventId: access.event.id, sessionId: inserted.id, accountId, input: timePreference })

      const organizers = await t<{ user_id: string }[]>`
        select user_id from event_members
        where event_id = ${access.event.id} and role in ('owner', 'admin') and user_id <> ${accountId}
      `
      const proposer = await t<{ display_name: string | null }[]>`select display_name from profiles where id = ${accountId}`
      const who = proposer[0]?.display_name?.trim() || 'A participant'
      await notify(t, {
        eventId: access.event.id,
        userIds: organizers.map((o) => o.user_id),
        type: 'new_proposal',
        title: inserted.status === 'pending' ? 'New proposal to review' : 'New session proposal',
        body: inserted.status === 'pending'
          ? `"${inserted.title}" by ${who} needs review.`
          : `${who} proposed "${inserted.title}".`,
        actionUrl: inserted.status === 'pending' ? `/e/${access.event.slug}/admin/sessions` : `/e/${access.event.slug}/sessions/${inserted.id}`,
        data: { session_id: inserted.id, session_title: inserted.title },
      })
      return inserted
    })
  } catch (e) {
    const mapped = dbErrorResponse(e)
    if (mapped) return mapped
    throw e
  }

  const atproto: AtprotoOutcome = await publishProposalFor(created.id, accountId)
  if (timePreference?.publish && atproto.uri) {
    // The time preference strongRefs the proposal, so it can only follow a published proposal.
    const outcome = await reconcileTimePreference(created.id, accountId, timePreference)
    return json({ id: created.id, status: created.status, atproto, time_preference: outcome }, { status: 201 })
  }
  return json({ id: created.id, status: created.status, atproto }, { status: 201 })
}

async function checkTrack(access: EventAccess, trackId: unknown): Promise<Response | null> {
  if (!trackId) return null
  const rows = await sql`select 1 from tracks where id = ${trackId as string} and event_id = ${access.event.id} and coalesce(is_active, true)`
  return rows.length ? null : jsonError(400, 'Choose one of this event’s tracks', { field: 'track_id' })
}

export async function PUT() { return methodNotAllowed() }
export async function PATCH() { return methodNotAllowed() }
export async function DELETE() { return methodNotAllowed() }
