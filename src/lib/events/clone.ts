import 'server-only'
/**
 * Clone a gathering (MT §11.3).
 *
 * What is copied: the shape of the thing — its settings, venues, tracks and the pattern of its
 * slot grid, re-dated onto the new gathering's days.
 *
 * What is **not** copied, and this is the whole point: anything about people. No members, no
 * invitations, no proposals, no votes, no tickets, no check-ins, no RSVPs, no feed history. A
 * roster is per-gathering and never travels (spec §8); copying one would hand a new gathering
 * a list of people who never agreed to be in it. The network identity is not copied either —
 * the clone is a draft with no DID until its organizer mints one, because a DID is minted for
 * a gathering, not inherited from a different one.
 *
 * The clone starts as a `draft`: it is a working copy, not a live announcement.
 */
import { sql, tx } from '@/lib/db'
import { slugLabelProblem } from '@/lib/events/identity'
import { isValidSlugFormat } from '@/lib/utils/slug'

/**
 * Columns worth carrying: how the gathering runs, not who was in it or what it published.
 * Written out in full in the statement below rather than interpolated — a column list is
 * structure, not a value, and this way the copy's shape is readable in one place.
 */

export interface CloneInput {
  sourceEventId: string
  createdBy: string
  name: string
  slug: string
  /** First day of the clone, 'YYYY-MM-DD'. The grid is shifted by the same number of days. */
  startDate: string
}

export interface CloneResult {
  id: string
  slug: string
  name: string
  venues: number
  tracks: number
  timeSlots: number
}

export class CloneError extends Error {
  constructor(message: string, readonly status = 400, readonly field: string | null = null) {
    super(message)
    this.name = 'CloneError'
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Check the slug across all three namespaces the creation wizard checks (events, labels, handles). */
export async function assertSlugFree(slug: string): Promise<void> {
  const format = isValidSlugFormat(slug)
  if (!format.valid) throw new CloneError(format.error ?? 'That web address will not work.', 400, 'slug')
  const [taken] = await sql`select 1 from events where slug = ${slug} limit 1`
  if (taken) throw new CloneError('That web address is already taken.', 409, 'slug')
  const problem = await slugLabelProblem(slug)
  if (problem) throw new CloneError(problem.error, problem.code === 'InvalidLabel' ? 400 : 409, 'slug')
}

export async function cloneGathering(input: CloneInput): Promise<CloneResult> {
  const name = input.name.trim()
  if (!name || name.length > 160) throw new CloneError('Give the new gathering a name.', 400, 'name')
  if (!DATE_RE.test(input.startDate)) throw new CloneError('Choose a start date.', 400, 'startDate')
  await assertSlugFree(input.slug)

  const [source] = await sql<{ start_date: string; end_date: string }[]>`
    select start_date, end_date from events where id = ${input.sourceEventId}
  `
  if (!source) throw new CloneError('That gathering no longer exists.', 404)

  // The clone keeps the original's length; the grid moves by the same number of days, so a
  // three-day shape stays a three-day shape and "day 2, 10:15, Workshop Room" still means that.
  const dayMs = 86_400_000
  const shiftDays = Math.round(
    (Date.parse(`${input.startDate}T00:00:00Z`) - Date.parse(`${source.start_date.slice(0, 10)}T00:00:00Z`)) / dayMs,
  )
  const length = Math.round(
    (Date.parse(`${source.end_date.slice(0, 10)}T00:00:00Z`) - Date.parse(`${source.start_date.slice(0, 10)}T00:00:00Z`)) / dayMs,
  )
  const endDate = new Date(Date.parse(`${input.startDate}T00:00:00Z`) + length * dayMs).toISOString().slice(0, 10)

  return tx(async (t) => {
    const [created] = await t<{ id: string }[]>`
      insert into events (
        slug, name, start_date, end_date, status, created_by,
        tagline, description, location_name, location_address, timezone, visibility,
        vote_credits_per_user, voting_mechanism, allowed_formats, allowed_durations,
        max_proposals_per_user, require_proposal_approval, suggested_topics, theme,
        logo_url, banner_url, favicon_url, policy_thresholds, transcripts_enabled,
        transcripts_visibility, attendance_voting_enabled, attendance_credits,
        code_of_conduct_url, require_conduct_acceptance, checkin_gates_voting
      )
      select ${input.slug}, ${name}, ${input.startDate}::date, ${endDate}::date, 'draft', ${input.createdBy},
        tagline, description, location_name, location_address, timezone, visibility,
        vote_credits_per_user, voting_mechanism, allowed_formats, allowed_durations,
        max_proposals_per_user, require_proposal_approval, suggested_topics, theme,
        logo_url, banner_url, favicon_url, policy_thresholds, transcripts_enabled,
        transcripts_visibility, attendance_voting_enabled, attendance_credits,
        code_of_conduct_url, require_conduct_acceptance, checkin_gates_voting
      from events where id = ${input.sourceEventId}
      returning id
    `
    if (!created) throw new CloneError('The gathering could not be copied.', 500)

    const venues = await t<{ id: string }[]>`
      insert into venues (event_id, name, slug, capacity, features, style, address, notes, is_primary,
                          locality, region, postal_code, country, is_private_residence, allowed_formats,
                          latitude, longitude)
      select ${created.id}, v.name, v.slug, v.capacity, v.features, v.style, v.address, v.notes, v.is_primary,
             v.locality, v.region, v.postal_code, v.country, v.is_private_residence, v.allowed_formats,
             v.latitude, v.longitude
      from venues v where v.event_id = ${input.sourceEventId}
      returning id
    `

    const tracks = await t`
      insert into tracks (event_id, name, slug, description, color, is_active, max_sessions, display_order, skill_uris)
      select ${created.id}, t2.name, t2.slug, t2.description, t2.color, t2.is_active, t2.max_sessions, t2.display_order, t2.skill_uris
      from tracks t2 where t2.event_id = ${input.sourceEventId}
    `

    // Slots are matched to their new venue by (name, slug), which is exactly how the copy above
    // produced them; a venue that somehow finds no twin drops its slots rather than inventing one.
    const slots = await t`
      insert into time_slots (event_id, venue_id, day_date, start_time, end_time, label, is_break, slot_type)
      select ${created.id}, nv.id, ts.day_date + ${shiftDays}::int,
             ts.start_time + (${shiftDays}::int || ' days')::interval,
             ts.end_time + (${shiftDays}::int || ' days')::interval,
             ts.label, ts.is_break, ts.slot_type
      from time_slots ts
      join venues ov on ov.id = ts.venue_id
      join venues nv on nv.event_id = ${created.id} and nv.name = ov.name and nv.slug is not distinct from ov.slug
      where ts.event_id = ${input.sourceEventId}
    `

    // The person doing the copying owns the copy. Nobody else comes across.
    await t`insert into event_members (event_id, user_id, role) values (${created.id}, ${input.createdBy}, 'owner')`

    return {
      id: created.id,
      slug: input.slug,
      name,
      venues: venues.length,
      tracks: tracks.count,
      timeSlots: slots.count,
    }
  })
}
