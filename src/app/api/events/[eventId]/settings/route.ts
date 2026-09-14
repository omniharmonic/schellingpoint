import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { createAdminClient } from '@/lib/supabase/server'
import { canRolePerform } from '@/lib/permissions'
import { canDelete, isValidTransition } from '@/lib/events/lifecycle'
import { formatInEventTimezone, parseTimeInTimezone } from '@/lib/events/timezone'
import type { EventRow, EventStatus, EventTheme } from '@/types/event'

/**
 * PATCH /api/events/[eventId]/settings
 *
 * Partial update of every organizer-editable event column. Only the keys
 * present in the body are validated and written, so each settings section can
 * save independently. Validation failures return `{ error, field }` with 400.
 *
 * DELETE /api/events/[eventId]/settings
 *
 * Owner-only hard delete, allowed only while the event is still a draft.
 * Every child table references events(id) ON DELETE CASCADE.
 */

const KNOWN_FORMATS = ['talk', 'workshop', 'panel', 'discussion', 'demo', 'fireside', 'ceremony'] as const
const STATUSES: EventStatus[] = ['draft', 'published', 'proposals_open', 'voting_open', 'scheduling', 'live', 'completed', 'archived']
const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const HEX_COLOR = /^#(?:[\da-f]{3}|[\da-f]{6})$/i

type Body = Record<string, unknown>
type EventUpdate = Partial<Omit<EventRow, 'id' | 'created_at' | 'location_geo'>>

class ValidationError extends Error {
  constructor(message: string, public field: string) { super(message) }
}
const fail = (message: string, field: string): never => { throw new ValidationError(message, field) }

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const isDateString = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const isValidTimezone = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value) return false
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false }
}

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

function optionalUrl(body: Body, key: string): string | null | undefined {
  if (!(key in body)) return undefined
  const value = body[key]
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 2048) fail('Enter a valid image URL.', key)
  try {
    const url = new URL(value as string)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
  } catch { fail('Image URLs must start with http:// or https://.', key) }
  return value as string
}

/**
 * Deadlines arrive either as ISO instants or as datetime-local strings, which
 * represent the event's clock (same convention as event creation).
 */
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

/** Build the column update from the untrusted body, validating against the current row. */
function buildUpdate(body: Body, current: EventRow): EventUpdate {
  const update: EventUpdate = {}
  const name = optionalText(body, 'name', 160, true); if (name !== undefined) update.name = name as string
  for (const [key, max] of [['tagline', 240], ['description', 10000], ['location_name', 200], ['location_address', 500]] as const) {
    const value = optionalText(body, key, max); if (value !== undefined) update[key] = value
  }
  if ('visibility' in body) {
    if (!['public', 'unlisted', 'private'].includes(body.visibility as string)) fail('Choose a valid visibility.', 'visibility')
    update.visibility = body.visibility as EventRow['visibility']
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status as EventStatus)) fail('Choose a valid event phase.', 'status')
    update.status = body.status as EventStatus
  }

  // Dates & timezone (validated against the merged values)
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

  // Voting config
  if ('vote_credits_per_user' in body) {
    const credits = body.vote_credits_per_user
    if (!Number.isInteger(credits) || (credits as number) <= 0 || (credits as number) > 2147483647) fail('Vote credits must be a positive whole number.', 'vote_credits_per_user')
    update.vote_credits_per_user = credits as number
  }
  if ('voting_mechanism' in body) {
    if (!['quadratic', 'linear', 'approval'].includes(body.voting_mechanism as string)) fail('Choose a voting method.', 'voting_mechanism')
    update.voting_mechanism = body.voting_mechanism as EventRow['voting_mechanism']
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

  // Proposal config
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
    update.max_proposals_per_user = max as number
  }
  if ('require_proposal_approval' in body) {
    if (typeof body.require_proposal_approval !== 'boolean') fail('Proposal approval must be on or off.', 'require_proposal_approval')
    update.require_proposal_approval = body.require_proposal_approval as boolean
  }
  if ('suggested_topics' in body) {
    const topics = body.suggested_topics
    if (topics !== null && (!Array.isArray(topics) || topics.some(t => typeof t !== 'string' || t.length > 80))) fail('Topics must be a list of short names.', 'suggested_topics')
    const cleaned = Array.from(new Set(((topics || []) as string[]).map(t => t.trim()).filter(Boolean))).slice(0, 50)
    update.suggested_topics = cleaned.length ? cleaned : null
  }

  // Branding
  if ('theme' in body) update.theme = mergeTheme(current.theme, body.theme)
  const logo = optionalUrl(body, 'logo_url'); if (logo !== undefined) update.logo_url = logo
  const banner = optionalUrl(body, 'banner_url'); if (banner !== undefined) update.banner_url = banner

  return update
}

async function loadMembership(eventId: string, userId: string) {
  const db = await createAdminClient()
  const { data: member, error } = await db.from('event_members').select('role').eq('event_id', eventId).eq('user_id', userId).maybeSingle()
  return { db, member, error }
}

/** Fan out a lifecycle notification to every member. Never fails the request. */
async function notifyMembers(db: Awaited<ReturnType<typeof createAdminClient>>, event: Pick<EventRow, 'id' | 'slug' | 'name' | 'timezone' | 'voting_closes_at'>): Promise<number> {
  try {
    const { data: members, error } = await db.from('event_members').select('user_id').eq('event_id', event.id)
    if (error || !members?.length) return 0
    const votingEndsAt = event.voting_closes_at ? formatInEventTimezone(new Date(event.voting_closes_at), event.timezone, 'full') : undefined
    const rows = members.map(member => ({
      user_id: member.user_id,
      event_id: event.id,
      type: 'voting_opened',
      title: `Voting is open for ${event.name}`,
      body: votingEndsAt ? `Spend your credits on the sessions you want to see. Voting closes ${votingEndsAt}.` : 'Spend your credits on the sessions you want to see.',
      action_url: `/e/${event.slug}/sessions`,
      data: { voting_ends_at: votingEndsAt ?? null },
    }))
    const { error: insertError } = await db.from('notifications').insert(rows)
    if (insertError) { console.error('[settings] voting_opened notifications failed:', insertError); return 0 }
    return rows.length
  } catch (err) {
    console.error('[settings] voting_opened notifications failed:', err)
    return 0
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Sign in to manage this event.' }, { status: 401 })
  const { db, member, error: memberError } = await loadMembership(eventId, user.id)
  if (memberError) return NextResponse.json({ error: 'Could not verify your event access. Try again.' }, { status: 500 })
  if (!member || !canRolePerform(member.role, 'editEventSettings')) return NextResponse.json({ error: 'Only this event’s organizers can change its settings.' }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!isRecord(body) || !Object.keys(body).length) return NextResponse.json({ error: 'Send at least one setting to update.', field: null }, { status: 400 })

  const { data: event, error } = await db.from('events').select('*').eq('id', eventId).single()
  if (error || !event) return NextResponse.json({ error: 'Could not load this event.' }, { status: 404 })
  const current = event as EventRow

  let update: EventUpdate
  try { update = buildUpdate(body, current) }
  catch (err) {
    if (err instanceof ValidationError) return NextResponse.json({ error: err.message, field: err.field }, { status: 400 })
    throw err
  }

  const nextStatus = update.status ?? current.status
  if (nextStatus !== current.status && !isValidTransition(current.status, nextStatus)) {
    return NextResponse.json({ error: 'That phase change is no longer available. Refresh the page and try again.', field: 'status' }, { status: 409 })
  }

  // Optimistic concurrency on status: the row must still be in the phase we
  // read, otherwise another organizer moved it and this save is stale.
  const { data: saved, error: saveError } = await db.from('events')
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq('id', eventId).eq('status', current.status)
    .select('*').maybeSingle()
  if (saveError) {
    console.error('[settings] save failed:', saveError)
    return NextResponse.json({ error: 'Could not save event settings. Your changes are still in the form.' }, { status: 500 })
  }
  if (!saved) return NextResponse.json({ error: 'Another organizer changed the event phase. Refresh before saving.', field: 'status' }, { status: 409 })

  let notified = 0
  if (nextStatus === 'voting_open' && current.status !== 'voting_open') notified = await notifyMembers(db, saved as EventRow)

  return NextResponse.json({ success: true, event: saved, notified })
}

export async function DELETE(request: Request, { params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params
  const user = await getUserFromRequest(request)
  if (!user) return NextResponse.json({ error: 'Sign in to manage this event.' }, { status: 401 })
  const { db, member, error: memberError } = await loadMembership(eventId, user.id)
  if (memberError) return NextResponse.json({ error: 'Could not verify your event access. Try again.' }, { status: 500 })
  if (!member || !canRolePerform(member.role, 'deleteEvent')) return NextResponse.json({ error: 'Only the event owner can delete it.' }, { status: 403 })

  const { data: event, error } = await db.from('events').select('id, status').eq('id', eventId).single()
  if (error || !event) return NextResponse.json({ error: 'Could not load this event.' }, { status: 404 })
  if (!canDelete(event.status as EventStatus)) return NextResponse.json({ error: 'Only draft gatherings can be deleted. Archive this one instead.' }, { status: 409 })

  // Children (sessions, votes, members, tickets, notifications, …) cascade from events(id).
  const { data: deleted, error: deleteError } = await db.from('events').delete().eq('id', eventId).eq('status', 'draft').select('id').maybeSingle()
  if (deleteError) {
    console.error('[settings] delete failed:', deleteError)
    return NextResponse.json({ error: 'Could not delete this event. Try again.' }, { status: 500 })
  }
  if (!deleted) return NextResponse.json({ error: 'This event was published or removed by another organizer. Refresh the page.' }, { status: 409 })
  return NextResponse.json({ success: true })
}
