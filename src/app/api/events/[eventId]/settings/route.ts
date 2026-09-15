import { NextResponse } from 'next/server'
import type postgres from 'postgres'
import { sql, dbErrorResponse } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { canRolePerform } from '@/lib/permissions'
import { canDelete, isValidTransition } from '@/lib/events/lifecycle'
import { formatInEventTimezone, parseTimeInTimezone } from '@/lib/events/timezone'
import { readPolicyThresholds, validatePolicyThresholds } from '@/lib/events/policy'
import { deleteGatheringIdentity, GatheringIdentityError } from '@/lib/events/identity'
import { evictGatheringActor, mintGatheringActor } from '@/lib/atproto/actors'
import { forgetGatheringHost } from '@/lib/events/hosts'
import { publishGatheringRecords, publishPolicyRecord, type NetworkWrite } from '@/lib/events/network'
import { isHiddenEvent, type EventRecord } from '@/lib/events'
import { notify } from '@/lib/notifications'
import { openRound } from '@/lib/voting/rounds'
import { isVotingError } from '@/lib/voting/errors'
import type { EventRoleName, EventStatus, EventTheme } from '@/types/event'

/**
 * PATCH /api/events/[eventId]/settings
 *
 * Partial update of every organizer-editable event column (owner/admin). Only the keys
 * present in the body are validated and written, so each settings section saves on its
 * own. Validation failures return `{ error, field }` with 400.
 *
 * Lifecycle (spec §8, plan §7.2), in this order:
 *   - leaving `draft` needs the gathering's identity; a missing one is minted first
 *   - one transaction: the row update (optimistic on the status we read), the voting
 *     round opened on entering `voting_open` (package C), and `voting_opened` /
 *     `voting_closed` notifications to members (package E's `notify`)
 *   - after commit, best-effort network writes (package F): `publishGathering` when the
 *     gathering leaves draft or a published gathering's public fields or phase change,
 *     `publishPolicy` when only its rules change. Outcomes are on the response as `network`.
 *   Closing and tallying a round is the close job's work (package C), not this route's.
 *
 * DELETE /api/events/[eventId]/settings
 *
 * Owner-only hard delete of a draft that never published anything. Every child table
 * cascades from events(id); the gathering's PDS account and credential go with it.
 */

const KNOWN_FORMATS = ['talk', 'workshop', 'panel', 'discussion', 'demo', 'fireside', 'ceremony'] as const
const STATUSES: EventStatus[] = ['draft', 'published', 'proposals_open', 'voting_open', 'scheduling', 'live', 'completed', 'archived']
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_STORE = { 'Cache-Control': 'private, no-store' }

type Body = Record<string, unknown>
type EventUpdate = Record<string, unknown>

class ValidationError extends Error {
  constructor(message: string, public field: string, public status = 400, public code?: string) { super(message) }
}
const fail = (message: string, field: string): never => { throw new ValidationError(message, field) }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isDateString = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const isValidTimezone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

function optionalText(body: Body, key: string, max: number, required = false): string | null | undefined {
  if (!(key in body)) return undefined
  const value = body[key]
  if (value === null && !required) return null
  if (typeof value !== 'string') fail(`${key.replace(/_/g, ' ')} must be text.`, key)
  const trimmed = (value as string).trim()
  if (required && !trimmed) fail('Enter an event name.', key)
  if (trimmed.length > max) fail(`Keep ${key.replace(/_/g, ' ')} under ${max} characters.`, key)
  return trimmed || null
}

/** An image is either one of our uploads (`/uploads/…`) or an absolute http(s) URL. */
function optionalImageUrl(body: Body, key: string): string | null | undefined {
  if (!(key in body)) return undefined
  const value = body[key]
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 2048) return fail('Enter a valid image URL.', key)
  if (/^\/uploads\/[a-z0-9/_.-]+$/i.test(value) && !value.includes('..')) return value
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
  } catch { fail('Image URLs must start with http:// or https://.', key) }
  return value
}

/** Deadlines arrive as ISO instants or datetime-local strings on the event's clock. */
function optionalInstant(body: Body, key: string, timezone: string, label: string): string | null | undefined {
  if (!(key in body)) return undefined
  const value = body[key]
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(`Choose a valid ${label} time.`, key)
  const text = value as string
  if (LOCAL_DATETIME.test(text)) {
    try { return parseTimeInTimezone(text.slice(11), text.slice(0, 10), timezone).toISOString() }
    catch { return fail(`The ${label} time falls in a clock change. Choose another time.`, key) }
  }
  return new Date(text).toISOString()
}

function mergeTheme(existing: EventTheme | null, incoming: unknown): EventTheme {
  if (!isRecord(incoming)) fail('Theme must be an object.', 'theme')
  const patch = incoming as Record<string, unknown>
  const base: EventTheme = existing && typeof existing === 'object' ? existing : {}
  const next: EventTheme = { ...base }
  if ('colors' in patch) {
    if (!isRecord(patch.colors)) fail('Theme colors must be an object.', 'theme')
    const colors: Record<string, string> = { ...(base.colors as Record<string, string> | undefined) }
    for (const [name, color] of Object.entries(patch.colors as Record<string, unknown>)) {
      if (color === null || color === '') { delete colors[name]; continue }
      if (typeof color !== 'string' || !HEX_COLOR.test(color)) fail(`Choose a valid hex color for ${name}.`, 'theme')
      colors[name] = color as string
    }
    next.colors = colors
  }
  if ('mode' in patch) {
    if (!['light', 'dark', 'system'].includes(patch.mode as string)) fail('Choose light, dark, or system appearance.', 'theme')
    next.mode = patch.mode as EventTheme['mode']
  }
  if ('social' in patch) {
    if (!isRecord(patch.social)) fail('Social links must be an object.', 'theme')
    const social: Record<string, string> = { ...(base.social as Record<string, string> | undefined) }
    for (const [network, link] of Object.entries(patch.social as Record<string, unknown>)) {
      if (!['twitter', 'telegram', 'discord', 'website'].includes(network)) continue
      if (link === null || link === '' || link === undefined) { delete social[network]; continue }
      if (typeof link !== 'string' || (link as string).length > 300) fail(`Keep the ${network} link under 300 characters.`, 'theme')
      social[network] = (link as string).trim()
    }
    next.social = social
  }
  return next
}

const ALLOWED_KEYS = new Set([
  'name', 'tagline', 'description', 'location_name', 'location_address', 'visibility', 'status',
  'start_date', 'end_date', 'timezone', 'vote_credits_per_user', 'voting_mechanism',
  'voting_opens_at', 'voting_closes_at', 'proposals_open_at', 'proposals_close_at',
  'allowed_formats', 'allowed_durations', 'max_proposals_per_user', 'require_proposal_approval',
  'suggested_topics', 'theme', 'logo_url', 'banner_url', 'policy_thresholds',
])

/** Build the column update from the untrusted body, validating against the current row. */
function buildUpdate(body: Body, current: EventRecord): EventUpdate {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(key)) fail(`${key.replace(/_/g, ' ')} cannot be changed here.`, key)
  }
  const update: EventUpdate = {}
  const name = optionalText(body, 'name', 160, true); if (name !== undefined) update.name = name
  for (const [key, max] of [['tagline', 240], ['description', 10000], ['location_name', 200], ['location_address', 500]] as const) {
    const value = optionalText(body, key, max); if (value !== undefined) update[key] = value
  }
  if ('visibility' in body) {
    if (!['public', 'unlisted', 'private'].includes(body.visibility as string)) fail('Choose a valid visibility.', 'visibility')
    update.visibility = body.visibility
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status as EventStatus)) fail('Choose a valid event phase.', 'status')
    update.status = body.status
  }

  if ('start_date' in body && !isDateString(body.start_date)) fail('Choose a valid start date.', 'start_date')
  if ('end_date' in body && !isDateString(body.end_date)) fail('Choose a valid end date.', 'end_date')
  const startDate = ('start_date' in body ? body.start_date : current.start_date) as string
  const endDate = ('end_date' in body ? body.end_date : current.end_date) as string
  if (endDate < startDate) fail('End date must be on or after the start date.', 'end_date' in body ? 'end_date' : 'start_date')
  if ('start_date' in body) update.start_date = startDate
  if ('end_date' in body) update.end_date = endDate
  if ('timezone' in body && !isValidTimezone(body.timezone)) fail('Choose a valid timezone.', 'timezone')
  const timezone = ('timezone' in body ? body.timezone : current.timezone) as string
  if ('timezone' in body) update.timezone = timezone

  if ('vote_credits_per_user' in body) {
    const credits = body.vote_credits_per_user
    if (!Number.isInteger(credits) || (credits as number) <= 0 || (credits as number) > 2147483647) fail('Vote credits must be a positive whole number.', 'vote_credits_per_user')
    update.vote_credits_per_user = credits
  }
  if ('voting_mechanism' in body) {
    if (!['quadratic', 'linear', 'approval'].includes(body.voting_mechanism as string)) fail('Choose a voting method.', 'voting_mechanism')
    update.voting_mechanism = body.voting_mechanism
  }
  const windows = [
    ['voting_opens_at', 'voting_closes_at', 'voting'],
    ['proposals_open_at', 'proposals_close_at', 'proposals'],
  ] as const
  for (const [openKey, closeKey, label] of windows) {
    const opens = optionalInstant(body, openKey, timezone, `${label} opening`)
    const closes = optionalInstant(body, closeKey, timezone, `${label} closing`)
    const mergedOpen = opens === undefined ? current[openKey] : opens
    const mergedClose = closes === undefined ? current[closeKey] : closes
    if (mergedOpen && mergedClose && Date.parse(mergedClose) <= Date.parse(mergedOpen)) fail(`The ${label} window must close after it opens.`, closes === undefined ? openKey : closeKey)
    if (opens !== undefined) update[openKey] = opens
    if (closes !== undefined) update[closeKey] = closes
  }

  if ('allowed_formats' in body) {
    const formats = body.allowed_formats
    if (!Array.isArray(formats) || !formats.length || formats.some(f => typeof f !== 'string' || !(KNOWN_FORMATS as readonly string[]).includes(f))) fail('Choose at least one supported session format.', 'allowed_formats')
    update.allowed_formats = Array.from(new Set(formats as string[]))
  }
  if ('allowed_durations' in body) {
    const durations = body.allowed_durations
    if (!Array.isArray(durations) || !durations.length || durations.some(d => !Number.isInteger(d) || d <= 0 || d > 1440)) fail('Choose positive whole-number session durations.', 'allowed_durations')
    update.allowed_durations = Array.from(new Set(durations as number[])).sort((a, b) => a - b)
  }
  if ('max_proposals_per_user' in body) {
    const max = body.max_proposals_per_user
    if (!Number.isInteger(max) || (max as number) < 0 || (max as number) > 1000) fail('Proposal limit must be a whole number; use 0 for unlimited.', 'max_proposals_per_user')
    update.max_proposals_per_user = max
  }
  if ('require_proposal_approval' in body) {
    if (typeof body.require_proposal_approval !== 'boolean') fail('Proposal approval must be on or off.', 'require_proposal_approval')
    update.require_proposal_approval = body.require_proposal_approval
  }
  if ('suggested_topics' in body) {
    const topics = body.suggested_topics
    if (topics !== null && (!Array.isArray(topics) || topics.some(t => typeof t !== 'string' || t.length > 80))) fail('Topics must be a list of short names.', 'suggested_topics')
    const cleaned = Array.from(new Set(((topics || []) as string[]).map(t => t.trim()).filter(Boolean))).slice(0, 50)
    update.suggested_topics = cleaned.length ? cleaned : null
  }
  if ('policy_thresholds' in body) {
    const result = validatePolicyThresholds(body.policy_thresholds, readPolicyThresholds(current.policy_thresholds))
    if (!result.ok) fail(result.error, result.field === 'policy_thresholds' ? 'policy_thresholds' : `policy_thresholds.${result.field}`)
    else update.policy_thresholds = result.value
  }

  if ('theme' in body) update.theme = mergeTheme(current.theme, body.theme)
  const logo = optionalImageUrl(body, 'logo_url'); if (logo !== undefined) update.logo_url = logo
  const banner = optionalImageUrl(body, 'banner_url'); if (banner !== undefined) update.banner_url = banner

  return update
}

/** Rules that live in the public `freeschool.draft.policy` record. */
const POLICY_KEYS = [
  'vote_credits_per_user', 'voting_mechanism', 'voting_opens_at', 'voting_closes_at',
  'proposals_open_at', 'proposals_close_at', 'allowed_formats', 'allowed_durations',
  'max_proposals_per_user', 'require_proposal_approval', 'policy_thresholds',
]
/** Fields of the public `gathering` record and the gathering's own calendar event. */
const GATHERING_KEYS = ['name', 'tagline', 'description', 'start_date', 'end_date', 'timezone', 'location_name', 'location_address', 'status']

const JSON_COLUMNS = new Set(['theme', 'policy_thresholds'])

async function loadForViewer(eventId: string, accountId: string): Promise<{ event: EventRecord; role: EventRoleName | null } | null> {
  if (!UUID.test(eventId)) return null
  const [event] = await sql<EventRecord[]>`select * from events where id = ${eventId}`
  if (!event) return null
  const [member] = await sql<{ role: EventRoleName }[]>`select role from event_members where event_id = ${eventId} and user_id = ${accountId}`
  return { event, role: member?.role ?? null }
}

async function members(t: postgres.TransactionSql, eventId: string): Promise<string[]> {
  const rows = await t<{ user_id: string }[]>`select user_id from event_members where event_id = ${eventId}`
  return rows.map((r) => r.user_id)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { eventId } = await params

  const loaded = await loadForViewer(eventId, viewer.accountId)
  if (!loaded || (isHiddenEvent(loaded.event) && !loaded.role)) return json({ error: 'Event not found' }, 404)
  if (!loaded.role || !canRolePerform(loaded.role, 'editEventSettings')) {
    return json({ error: 'Only this event’s organizers can change its settings.' }, 403)
  }
  let current = loaded.event

  const body = await request.json().catch(() => null)
  if (!isRecord(body) || !Object.keys(body).length) return json({ error: 'Send at least one setting to update.', field: null }, 400)

  let update: EventUpdate
  try { update = buildUpdate(body, current) }
  catch (err) {
    if (err instanceof ValidationError) return json({ error: err.message, field: err.field }, err.status)
    throw err
  }

  const nextStatus = (update.status as EventStatus | undefined) ?? current.status
  const statusChanged = nextStatus !== current.status
  if (statusChanged && !isValidTransition(current.status, nextStatus)) {
    return json({ error: 'That phase change is no longer available. Refresh the page and try again.', field: 'status' }, 409)
  }
  const leavingDraft = statusChanged && current.status === 'draft'

  // A published gathering is a DID with records (spec §8): no identity, no publishing.
  if (leavingDraft && !current.actor_did) {
    try {
      const minted = await mintGatheringActor(current.id, viewer.accountId)
      current = { ...current, actor_did: minted.did, actor_handle: minted.handle }
    } catch (e) {
      const message = e instanceof GatheringIdentityError ? e.message : 'The network identity could not be created.'
      return json({ error: `${message} The gathering stays a draft; try again shortly.`, field: 'status', code: 'IdentityMissing' }, 503)
    }
  }

  const enteringVoting = statusChanged && nextStatus === 'voting_open'
  const leavingVoting = statusChanged && current.status === 'voting_open'

  let saved: EventRecord | undefined
  let notified = 0
  try {
    saved = await sql.begin(async (t) => {
      // Keys come from ALLOWED_KEYS only (buildUpdate refuses anything else).
      const values: Record<string, postgres.ParameterOrJSON<never>> = { updated_at: new Date().toISOString() }
      for (const [key, value] of Object.entries(update)) {
        values[key] = JSON_COLUMNS.has(key) ? t.json(value as never) : (value as postgres.ParameterOrJSON<never>)
      }
      // Optimistic concurrency on status: another organizer may have moved the phase.
      const [row] = await t<EventRecord[]>`
        update events set ${t(values, Object.keys(values))}
        where id = ${current.id} and status = ${current.status}
        returning *
      `
      if (!row) return undefined

      if (enteringVoting) {
        await openRound(current.id, {}, t)
        const votingEndsAt = row.voting_closes_at ? formatInEventTimezone(new Date(row.voting_closes_at), row.timezone, 'full') : null
        notified = await notify(t, {
          eventId: row.id,
          userIds: await members(t, row.id),
          type: 'voting_opened',
          title: `Voting is open for ${row.name}`,
          body: votingEndsAt
            ? `Spend your credits on the sessions you want to see. Voting closes ${votingEndsAt}.`
            : 'Spend your credits on the sessions you want to see.',
          actionUrl: `/e/${row.slug}/sessions`,
          data: { voting_ends_at: votingEndsAt },
        })
      } else if (leavingVoting) {
        notified = await notify(t, {
          eventId: row.id,
          userIds: await members(t, row.id),
          type: 'voting_closed',
          title: `Voting has closed for ${row.name}`,
          body: 'Thanks for shaping the program. The organizers are putting the schedule together.',
          actionUrl: `/e/${row.slug}`,
          data: {},
        })
      }
      return row
    })
  } catch (e) {
    if (isVotingError(e)) {
      const field = e.field === 'closesAt' ? 'voting_closes_at' : e.field === 'opensAt' ? 'voting_opens_at' : e.field ?? 'status'
      return json({ error: `Voting could not open: ${e.message}`, field, code: e.code }, e.status)
    }
    const mapped = dbErrorResponse(e)
    if (mapped) return mapped
    console.error('[settings] save failed:', e)
    return json({ error: 'Could not save event settings. Your changes are still in the form.' }, 500)
  }
  if (!saved) return json({ error: 'Another organizer changed the event phase. Refresh before saving.', field: 'status' }, 409)

  // Committed. Now the network, best-effort, never inside the transaction.
  const network: NetworkWrite[] = []
  if (saved.actor_did) {
    const alreadyPublished = Boolean(saved.atproto_published_at)
    const gatheringChanged = GATHERING_KEYS.some((key) => key in update)
    const policyChanged = POLICY_KEYS.some((key) => key in update)
    if (leavingDraft || (alreadyPublished && gatheringChanged)) {
      network.push(await publishGatheringRecords(saved.id, viewer.accountId))
    } else if (alreadyPublished && policyChanged) {
      network.push(await publishPolicyRecord(saved.id, viewer.accountId))
    }
  }

  // The publish step stamps uri/cid columns; answer with the row as it now stands.
  const [fresh] = network.length ? await sql<EventRecord[]>`select * from events where id = ${saved.id}` : [saved]
  return json({ success: true, event: fresh ?? saved, notified, network })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const { eventId } = await params

  const loaded = await loadForViewer(eventId, viewer.accountId)
  if (!loaded || (isHiddenEvent(loaded.event) && !loaded.role)) return json({ error: 'Event not found' }, 404)
  if (!loaded.role || !canRolePerform(loaded.role, 'deleteEvent')) return json({ error: 'Only the event owner can delete it.' }, 403)
  if (!canDelete(loaded.event.status as EventStatus)) {
    return json({ error: 'Only draft gatherings can be deleted. Archive this one instead.' }, 409)
  }
  if (loaded.event.atproto_published_at) {
    return json({ error: 'This gathering has published records on the network, so it can only be archived.', code: 'PublishedRecords' }, 409)
  }

  try {
    const outcome = await sql.begin(async (t) => {
      const [event] = await t<{ id: string; slug: string; name: string; status: string; actor_did: string | null; atproto_published_at: string | null }[]>`
        select id, slug, name, status, actor_did, atproto_published_at from events where id = ${eventId} for update
      `
      if (!event || event.status !== 'draft' || event.atproto_published_at) return 'conflict' as const
      if (event.actor_did) {
        await t`
          insert into at_audit (event_id, actor_did, caller_user_id, action, decision, reason)
          values (${event.id}, ${event.actor_did}, ${viewer.accountId}, 'delete-identity', 'allow',
                  ${`draft gathering "${event.name.slice(0, 80)}" deleted by its owner; it never published a record`})
        `
        // Inside the transaction on purpose: if the PDS refuses, the draft (and its row
        // pointing at the account) stays, so nothing is orphaned on either side.
        await deleteGatheringIdentity(event.actor_did)
      }
      // Children (sessions, members, tickets, notifications, …) cascade from events(id).
      await t`delete from events where id = ${event.id}`
      return event.slug
    })
    if (outcome === 'conflict') {
      return json({ error: 'This event was published or removed by another organizer. Refresh the page.' }, 409)
    }
    evictGatheringActor(eventId)
    forgetGatheringHost(outcome)
    return json({ success: true })
  } catch (e) {
    console.error('[settings] delete failed:', e)
    return json({ error: 'Could not delete this event and its network identity. Nothing was removed; try again.' }, 502)
  }
}
