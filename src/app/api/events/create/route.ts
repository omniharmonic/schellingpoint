import { NextResponse } from 'next/server'
import { validateWizardState } from '@/lib/events/validate-creation'
import { sql, pgErrorCode } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { suggestAlternativeSlugs } from '@/lib/utils/slug'
import { parseTimeInTimezone } from '@/lib/events/timezone'
import { DEFAULT_POLICY_THRESHOLDS, validatePolicyThresholds } from '@/lib/events/policy'
import { GatheringIdentityError, slugLabelProblem } from '@/lib/events/identity'
import { mintGatheringActor } from '@/lib/atproto/actors'
import { forgetGatheringHost } from '@/lib/events/hosts'
import type { WizardState, WizardVenue, WizardTrack, WizardTimeSlot } from '@/app/create/useWizardState'
import type { EventTheme } from '@/types/event'

/**
 * POST /api/events/create  { wizardState }
 *
 * 1. same-origin + signed-in viewer (plan §3.4)
 * 2. validate the untrusted wizard payload (shared with the review step)
 * 3. refuse slugs that are taken as events, reserved labels or member handles
 * 4. one transaction: `create_event_with_program` (event, rooms, tracks, slots, owner
 *    membership) + the policy thresholds
 * 5. after commit: mint the gathering's DID on our PDS (spec §8). A minting failure does
 *    not undo the event — it stays a draft with `identity.status: 'pending'`, and the
 *    organizer retries from Event settings (`POST /api/events/[eventId]/identity`).
 *
 * → 201 { success, event: {id, slug, name}, eventSlug, identity: {status, did?, handle?, error?} }
 */

interface CreateEventResponse {
  success: boolean
  event?: { id: string; slug: string; name: string }
  eventSlug?: string
  identity?: { status: 'created' | 'pending'; did?: string; handle?: string; error?: string }
  error?: string
  field?: string
  code?: string
  suggestions?: string[]
}

type Json = Record<string, unknown>

const slugify = (value: string, fallback: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback

/** datetime-local values are the event's wall clock, never the server's timezone. */
function instantInEventZone(value: string | null, timezone: string): string | null {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    return parseTimeInTimezone(value.slice(11), value.slice(0, 10), timezone).toISOString()
  }
  return new Date(value).toISOString()
}

function eventInsert(state: WizardState, accountId: string): Json {
  const tz = state.dates.timezone
  const theme: EventTheme = {
    colors: {
      primary: state.branding.theme.primary,
      secondary: state.branding.theme.secondary,
      accent: state.branding.theme.accent,
    },
    mode: state.branding.theme.mode,
    social: {
      twitter: state.branding.social.twitter || undefined,
      telegram: state.branding.social.telegram || undefined,
      discord: state.branding.social.discord || undefined,
      website: state.branding.social.website || undefined,
    },
  }
  return {
    slug: state.basics.slug,
    name: state.basics.name.trim(),
    tagline: state.basics.tagline?.trim() || null,
    description: state.basics.description?.trim() || null,
    start_date: state.dates.startDate,
    end_date: state.dates.endDate,
    timezone: tz,
    location_name: state.dates.locationName || null,
    location_address: state.dates.locationAddress || null,
    vote_credits_per_user: state.voting.credits,
    voting_mechanism: state.voting.mechanism,
    voting_opens_at: instantInEventZone(state.voting.votingOpensAt, tz),
    voting_closes_at: instantInEventZone(state.voting.votingClosesAt, tz),
    proposals_open_at: instantInEventZone(state.voting.proposalsOpenAt, tz),
    proposals_close_at: instantInEventZone(state.voting.proposalsCloseAt, tz),
    allowed_formats: state.voting.allowedFormats,
    allowed_durations: state.voting.allowedDurations,
    max_proposals_per_user: state.voting.maxProposalsPerUser,
    // Defaults open (spec §3): review is on only when the organizer turned it on.
    require_proposal_approval: state.voting.requireProposalApproval === true,
    theme,
    logo_url: state.branding.logoUrl || null,
    banner_url: state.branding.bannerUrl || null,
    // The creator is always the signed-in viewer; never taken from the request body.
    created_by: accountId,
    visibility: state.basics.visibility,
    suggested_topics: Array.isArray(state.suggestedTopics) && state.suggestedTopics.length > 0 ? state.suggestedTopics : null,
  }
}

function programInserts(state: WizardState) {
  const venueIds = new Map<string, string>()
  const venues = state.venues.map((venue: WizardVenue, index) => {
    const id = crypto.randomUUID()
    venueIds.set(venue.id, id)
    return {
      id,
      name: venue.name.trim(),
      capacity: venue.capacity,
      features: venue.features,
      address: venue.address || null,
      slug: `${slugify(venue.name, 'venue')}-${index + 1}`,
    }
  })
  const tracks = state.tracks.map((track: WizardTrack, index) => ({
    name: track.name.trim(),
    slug: `${slugify(track.name, 'track')}-${index + 1}`,
    description: track.description || null,
    color: track.color || null,
    display_order: index,
  }))
  const timeSlots = state.schedule.timeSlots.map((slot: WizardTimeSlot) => ({
    start_time: parseTimeInTimezone(slot.startTime, slot.dayDate, state.dates.timezone).toISOString(),
    end_time: parseTimeInTimezone(slot.endTime, slot.dayDate, state.dates.timezone).toISOString(),
    label: slot.label || null,
    is_break: slot.isBreak,
    venue_id: venueIds.get(slot.venueId) ?? null,
    day_date: slot.dayDate,
    slot_type: slot.isBreak ? 'break' : 'session',
  }))
  return { venues, tracks, timeSlots }
}

async function availableSuggestions(slug: string): Promise<string[]> {
  const candidates = suggestAlternativeSlugs(slug)
  if (!candidates.length) return []
  const taken = new Set((await sql<{ slug: string }[]>`select slug from events where slug in ${sql(candidates)}`).map((r) => r.slug))
  const free: string[] = []
  for (const candidate of candidates) {
    if (!taken.has(candidate) && !(await slugLabelProblem(candidate, { checkPds: false }))) free.push(candidate)
  }
  return free.slice(0, 3)
}

const json = (body: CreateEventResponse, status = 200) =>
  NextResponse.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })

export async function POST(request: Request): Promise<Response> {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400)
  }
  const wizardState = body && typeof body === 'object' ? (body as { wizardState?: unknown }).wizardState : undefined
  if (!wizardState) return json({ success: false, error: 'wizardState is required' }, 400)

  const validation = validateWizardState(wizardState)
  if (!validation.valid) return json({ success: false, error: validation.error }, 400)
  const state = wizardState as WizardState

  const thresholds = validatePolicyThresholds(state.voting.policyThresholds ?? {}, DEFAULT_POLICY_THRESHOLDS)
  if (!thresholds.ok) return json({ success: false, error: thresholds.error, field: thresholds.field }, 400)

  const slug = state.basics.slug
  try {
    const problem = await slugLabelProblem(slug)
    if (problem) {
      return json({ success: false, error: problem.error, code: problem.code, field: 'slug', suggestions: await availableSuggestions(slug) }, problem.code === 'InvalidLabel' ? 400 : 409)
    }
    const existing = await sql`select 1 from events where slug = ${slug} limit 1`
    if (existing.length > 0) {
      return json({ success: false, error: 'This event URL is already taken', field: 'slug', suggestions: await availableSuggestions(slug) }, 409)
    }
  } catch (error) {
    console.error('[events/create] slug check failed:', error)
    return json({ success: false, error: 'Failed to check slug availability' }, 500)
  }

  const { venues, tracks, timeSlots } = programInserts(state)
  let created: { id: string; slug: string; name: string }
  try {
    created = await sql.begin(async (t) => {
      // Service connection after authorization: the function is granted to service_role
      // only, and `created_by` is the verified viewer, never the request body.
      const [row] = await t<{ result: { id: string; slug: string; name: string } }[]>`
        select public.create_event_with_program(
          ${t.json(eventInsert(state, viewer.accountId) as never)}::jsonb,
          ${t.json(venues as never)}::jsonb,
          ${t.json(tracks as never)}::jsonb,
          ${t.json(timeSlots as never)}::jsonb
        ) as result
      `
      await t`update events set policy_thresholds = ${t.json(thresholds.value as never)}::jsonb,
        ticketing_enabled = ${state.basics.ticketingEnabled ?? false},
        platform_fee_percent = ${state.basics.platformFeePercent ?? 1} where id = ${row.result.id}`
      return row.result
    })
  } catch (error) {
    const code = pgErrorCode(error)
    if (code === '23505') {
      return json({ success: false, error: 'This event URL was just taken. Choose another URL and try again.', field: 'slug', suggestions: await availableSuggestions(slug).catch(() => []) }, 409)
    }
    if (code === '23514') {
      return json({ success: false, error: error instanceof Error ? error.message : 'Your event details were refused.' }, 400)
    }
    console.error('[events/create] transaction failed:', error)
    return json({ success: false, error: 'Your event could not be saved. Nothing was created; your draft is safe. Please try again.' }, 500)
  }

  forgetGatheringHost(created.slug)

  // Committed. The identity is minted outside the transaction: a PDS outage must never
  // lose the organizer's work, and the draft is useless to nobody but its organizers.
  let identity: CreateEventResponse['identity']
  try {
    const minted = await mintGatheringActor(created.id, viewer.accountId)
    identity = { status: 'created', did: minted.did, handle: minted.handle }
  } catch (error) {
    const message = error instanceof GatheringIdentityError ? error.message : 'The network identity could not be created.'
    console.error('[events/create] gathering identity mint failed:', error)
    identity = { status: 'pending', error: `${message} Your gathering was saved as a draft; retry from Event settings.` }
  }

  return json({ success: true, event: created, eventSlug: created.slug, identity }, 201)
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed. Use POST.' }, { status: 405 })
}
