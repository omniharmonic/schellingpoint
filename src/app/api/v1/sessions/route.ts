import { sql, asAccount, dbErrorResponse, pgErrorCode, pgMessage } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { resolvePublicEvent } from '@/lib/api/auth'
import { notify } from '@/lib/notifications'
import { validateSkillUris } from '@/lib/atproto/skills'
import { badRequest, methodNotAllowed } from '@/lib/api/response'
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
import { DAY_REGEX, publicJson, publishedSessions } from '@/app/api/v1/schedule/public-read'
import { proposalLimitMessage, proposalQuota, quotaOf } from '@/lib/sessions/quota'

/**
 * GET /api/v1/sessions?event=<slug>[&day=YYYY-MM-DD][&track=<id>] — the gathering's published
 * sessions. PUBLIC and keyless: the shared-key partner API is gone (spec §2), and this endpoint
 * now answers from exactly the code path the public schedule serves (`publishedSessions`), so it
 * can never show more than the gathering has already written to the network.
 *
 *   { data: PublicSession[], count }   — see docs/api-guide.md and ../schedule/public-read.ts
 *
 * Public and unlisted gatherings only, never a draft; unknown or private slugs answer 404.
 */
export async function GET(request: Request) {
  const url = new URL(request.url)
  const day = url.searchParams.get('day')
  if (day && !DAY_REGEX.test(day)) return badRequest('Invalid day format. Expected YYYY-MM-DD.')
  const trackId = url.searchParams.get('track')?.trim() || null
  if (trackId && !isUuid(trackId)) return badRequest('Invalid track id. Expected a UUID.')

  const resolved = await resolvePublicEvent(request)
  if ('error' in resolved) return resolved.error
  const { event } = resolved

  const sessions = await publishedSessions(event.id, { actorDid: event.actor_did, day, trackId })
  return publicJson(sessions, sessions.length)
}

/**
 * POST /api/v1/sessions — propose a session.
 *
 * Body: `event_slug` (or `event_id`), `title`, `format`, `duration`, optional content fields,
 * `time_preference: { windows, blackouts, publish }`. No host name and no co-hosts: the host
 * is the signed-in proposer, and co-hosts accept invitations themselves (spec §4.2, R9).
 *
 * The insert runs as the proposer so `enforce_event_proposal_rules` applies (window, format,
 * duration, per-person limit, approval status). The per-person cap is checked here first so
 * the answer is a clear 409 `ProposalLimit` with the counts, not a bare 23514; the trigger
 * remains the authority and a race still lands on the same 409. Organizers are notified in
 * the same transaction. After commit the proposal is written to the proposer's own repository when
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
  const [{ max_proposals_per_user: cap }] = await sql<{ max_proposals_per_user: number | null }[]>`
    select max_proposals_per_user from events where id = ${access.event.id}
  `
  const quota = await proposalQuota(access.event.id, accountId, cap, access.role)
  if (quota.atLimit) {
    return jsonError(409, proposalLimitMessage(quota), { code: 'ProposalLimit', proposals: quota })
  }
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
      // The proposer's own receipt (inventory 8.3): what happens next depends on whether
      // this gathering reviews proposals before they appear.
      await notify(t, {
        eventId: access.event.id,
        userIds: [accountId],
        type: 'session_submitted',
        title: `Your proposal "${inserted.title}" was submitted`,
        body: inserted.status === 'pending'
          ? `It is with the organizers of ${access.event.name} for review. You can keep editing it until they look at it.`
          : `It is live on ${access.event.name}. You can edit it at any time, and invite a co-host.`,
        actionUrl: `/e/${access.event.slug}/sessions/${inserted.id}`,
        data: { session_id: inserted.id, session_title: inserted.title },
      })
      return inserted
    })
  } catch (e) {
    // The trigger is the authority; a concurrent submit that hits the cap answers the same 409.
    if (pgErrorCode(e) === '23514' && /proposal limit/i.test(pgMessage(e))) {
      const raced = quotaOf(quota.used + 1, cap, access.role)
      return jsonError(409, proposalLimitMessage(raced), { code: 'ProposalLimit', proposals: raced })
    }
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
