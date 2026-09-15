import 'server-only'
/**
 * Recurring gatherings (spec §4.1, plan item 31): a monthly unconference is one gathering whose
 * own `community.lexicon.calendar.event` recurs.
 *
 *   createGatheringSeries `freeschool.draft.series` in the GATHERING's repo, anchored on the
 *                         gathering's published calendar event (the first occurrence)
 *   materializeSeries     for every rule instant inside the look-ahead window: an ordinary
 *                         calendar event copied from the first event, its `coop.lexicon.event.config`
 *                         CARRYING THE ROUTING TAGS (the Free School materializer bug not to
 *                         re-introduce: untagged occurrences vanish from tag-routing peers), and a
 *                         `freeschool.draft.occurrence` back-pointer with both strongRefs
 *
 * Only the gathering materializes its own series (peers list, never copy). Idempotent: deterministic
 * rkeys from (series, original start) and the `at_occurrences` unique key; a re-run writes nothing new.
 */
import { sql } from '@/lib/db'
import { NSID } from './nsids'
import { attempt, loadPublishContext, putWithCas, type PublishDeps, type PublishResult } from './publish'
import { expandRecurrence } from './recurrence'
import { buildEventConfig, buildOccurrenceRecord, buildSeriesRecord, rruleFor } from './records'
import { deterministicRkey } from './rkey'
import type { CalendarEventRecord, SeriesFreq, StrongRef, WeekdayCode } from './types'

export class SeriesError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly field?: string,
  ) {
    super(message)
    this.name = 'SeriesError'
  }
}

export interface CreateSeriesInput {
  eventId: string
  callerUserId: string
  freq: SeriesFreq
  interval?: number
  byDay?: WeekdayCode[]
  count?: number
  until?: string
  exdates?: string[]
  materializeAheadDays?: number
}

const FREQS: SeriesFreq[] = ['daily', 'weekly', 'monthly', 'yearly']
const DAYS: WeekdayCode[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']

function validate(input: CreateSeriesInput): void {
  if (!FREQS.includes(input.freq)) throw new SeriesError('freq must be daily, weekly, monthly or yearly', 400, 'freq')
  if (input.interval !== undefined && (!Number.isInteger(input.interval) || input.interval < 1 || input.interval > 52)) throw new SeriesError('interval must be 1..52', 400, 'interval')
  if (input.byDay && (input.freq !== 'weekly' || input.byDay.some((d) => !DAYS.includes(d)))) throw new SeriesError('byDay applies to weekly series only (MO..SU)', 400, 'byDay')
  if (input.count !== undefined && input.until !== undefined) throw new SeriesError('set count or until, not both', 400, 'count')
  if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 2 || input.count > 500)) throw new SeriesError('count must be 2..500', 400, 'count')
  if (input.until !== undefined && Number.isNaN(new Date(input.until).getTime())) throw new SeriesError('until must be an ISO 8601 instant', 400, 'until')
  if (input.materializeAheadDays !== undefined && (!Number.isInteger(input.materializeAheadDays) || input.materializeAheadDays < 1 || input.materializeAheadDays > 730)) {
    throw new SeriesError('materializeAheadDays must be 1..730', 400, 'materializeAheadDays')
  }
}

interface SeriesRow {
  id: string
  event_id: string
  rrule: string
  freq: SeriesFreq
  interval: number
  by_day: WeekdayCode[]
  count: number | null
  until: string | null
  exdates: string[]
  timezone: string
  duration_minutes: number
  materialize_ahead_days: number
  first_event_uri: string | null
  first_event_cid: string | null
  record_uri: string | null
  record_cid: string | null
}

/** Organiser (owner/admin): declare the gathering recurring and write the series record. */
export async function createGatheringSeries(input: CreateSeriesInput, deps?: PublishDeps): Promise<{ seriesId: string; uri: string; cid: string; results: PublishResult[] }> {
  validate(input)
  const ctx = await loadPublishContext({ eventId: input.eventId, callerUserId: input.callerUserId }, deps)
  const first = ctx.event.calendar_event_uri && ctx.event.calendar_event_cid ? { uri: ctx.event.calendar_event_uri, cid: ctx.event.calendar_event_cid } : null
  if (!first) throw new SeriesError('Publish the gathering first: a series is anchored on its calendar event', 409)
  const live = await ctx.deps.getRecord<CalendarEventRecord>(ctx.actorDid, NSID.event, first.uri.slice(first.uri.lastIndexOf('/') + 1))
  if (!live?.value.startsAt) throw new SeriesError('The gathering’s calendar event has no start time', 409)
  const starts = new Date(live.value.startsAt)
  const ends = live.value.endsAt ? new Date(live.value.endsAt) : new Date(starts.getTime() + 60 * 60 * 1000)
  const durationMinutes = Math.max(1, Math.round((ends.getTime() - starts.getTime()) / 60_000))
  const anchor: StrongRef = { uri: live.uri, cid: live.cid }

  const [row] = await sql<{ id: string }[]>`
    insert into at_series (event_id, rrule, freq, "interval", by_day, count, until, exdates, timezone, duration_minutes, materialize_ahead_days, first_event_uri, first_event_cid, created_by)
    values (
      ${ctx.event.id}, ${rruleFor(input)}, ${input.freq}, ${input.interval ?? 1}, ${input.byDay ?? []}, ${input.count ?? null},
      ${input.until ?? null}, ${input.exdates ?? []}::timestamptz[], ${ctx.event.timezone}, ${durationMinutes}, ${input.materializeAheadDays ?? 90},
      ${anchor.uri}, ${anchor.cid}, ${input.callerUserId}
    )
    returning id
  `
  const results: PublishResult[] = []
  const ref = await attempt(results, 'series', row!.id, () =>
    putWithCas(ctx, {
      action: 'publish-series',
      collection: NSID.series,
      rkey: deterministicRkey('series', row!.id),
      record: buildSeriesRecord({
        firstEvent: anchor,
        freq: input.freq,
        interval: input.interval,
        byDay: input.byDay,
        count: input.count,
        until: input.until,
        exdates: input.exdates,
        timezone: ctx.event.timezone,
        materializeAhead: input.materializeAheadDays ?? 90,
        createdAt: new Date(),
      }),
      reason: `declare "${ctx.event.name}" recurring (${rruleFor(input)})`,
    }),
  )
  if (!ref) {
    await sql`delete from at_series where id = ${row!.id}`
    throw new SeriesError(`The series record could not be written: ${results.at(-1)?.error ?? 'unknown error'}`, 502)
  }
  await sql`update at_series set record_uri = ${ref.uri}, record_cid = ${ref.cid} where id = ${row!.id}`
  return { seriesId: row!.id, uri: ref.uri, cid: ref.cid, results }
}

/**
 * Write every occurrence inside the look-ahead window that is not written yet. `callerUserId`
 * null = the scheduler. Returns per-record results; occurrences already materialized are skipped.
 */
export async function materializeSeries(
  input: { eventId: string; seriesId: string; callerUserId: string | null; now?: Date },
  deps?: PublishDeps,
): Promise<PublishResult[]> {
  const [series] = await sql<SeriesRow[]>`
    select id, event_id, rrule, freq, "interval", by_day, count, until, exdates, timezone, duration_minutes, materialize_ahead_days,
           first_event_uri, first_event_cid, record_uri, record_cid
    from at_series where id = ${input.seriesId} and event_id = ${input.eventId}
  `
  if (!series?.record_uri || !series.record_cid || !series.first_event_uri) throw new SeriesError('Series not found or not published', 404)
  const ctx = await loadPublishContext({ eventId: input.eventId, callerUserId: input.callerUserId }, deps)
  const firstRkey = series.first_event_uri.slice(series.first_event_uri.lastIndexOf('/') + 1)
  const template = await ctx.deps.getRecord<CalendarEventRecord>(ctx.actorDid, NSID.event, firstRkey)
  if (!template?.value.startsAt) throw new SeriesError('The first event of the series is gone', 409)

  const now = input.now ?? new Date()
  const horizon = new Date(now.getTime() + series.materialize_ahead_days * 86_400_000)
  const instants = expandRecurrence(
    template.value.startsAt,
    { freq: series.freq, interval: series.interval, byDay: series.by_day, count: series.count, until: series.until, exdates: series.exdates, timezone: series.timezone },
    horizon,
  ).filter((o) => o.sequence > 1) // occurrence #1 IS the first event

  const done = new Set(
    (await sql<{ original_starts_at: string }[]>`select original_starts_at from at_occurrences where series_id = ${series.id}`).map((r) => new Date(r.original_starts_at).toISOString()),
  )
  const seriesRef: StrongRef = { uri: series.record_uri, cid: series.record_cid }
  const results: PublishResult[] = []
  for (const occ of instants) {
    if (done.has(occ.startsAt)) continue
    const endsAt = new Date(new Date(occ.startsAt).getTime() + series.duration_minutes * 60_000).toISOString()
    const { $type: _type, ...copy } = template.value
    void _type
    const event = await attempt(results, 'occurrence', occ.startsAt, () =>
      putWithCas(ctx, {
        action: 'publish-occurrence',
        collection: NSID.event,
        rkey: deterministicRkey('occurrence-event', series.id, occ.startsAt),
        record: { ...copy, startsAt: occ.startsAt, endsAt, createdAt: new Date().toISOString() },
        reason: `materialize occurrence ${occ.sequence} of "${ctx.event.name}"`,
      }),
    )
    if (!event) continue
    await attempt(results, 'occurrence', `${occ.startsAt}:config`, () =>
      putWithCas(ctx, {
        action: 'publish-occurrence',
        collection: NSID.eventConfig,
        rkey: deterministicRkey('occurrence-config', series.id, occ.startsAt),
        record: buildEventConfig({
          event,
          timezone: series.timezone,
          capacity: ctx.event.max_attendees,
          gatheringDid: ctx.actorDid,
          tags: ctx.event.atproto_tags,
          createdAt: new Date(),
        }),
        reason: `materialize occurrence ${occ.sequence}: config with the gathering's routing tags`,
      }),
    )
    const back = await attempt(results, 'occurrence', `${occ.startsAt}:sidecar`, () =>
      putWithCas(ctx, {
        action: 'publish-occurrence',
        collection: NSID.occurrence,
        rkey: deterministicRkey('occurrence', series.id, occ.startsAt),
        record: buildOccurrenceRecord({ event, series: seriesRef, originalStartsAt: occ.startsAt, sequence: occ.sequence, createdAt: new Date() }),
        reason: `materialize occurrence ${occ.sequence}: back-pointer to the series`,
      }),
    )
    if (back && ctx.deps.persist) {
      await sql`
        insert into at_occurrences (event_id, series_id, original_starts_at, sequence, event_uri, event_cid, record_uri, record_cid)
        values (${ctx.event.id}, ${series.id}, ${occ.startsAt}, ${occ.sequence}, ${event.uri}, ${event.cid}, ${back.uri}, ${back.cid})
        on conflict (series_id, original_starts_at) do nothing
      `
    }
  }
  return results
}

/** Scheduler entry: materialize every series of every linked gathering. */
export async function materializeAllSeries(now?: Date): Promise<{ series: number; written: number; errors: number }> {
  const rows = await sql<{ id: string; event_id: string }[]>`
    select s.id, s.event_id from at_series s join events e on e.id = s.event_id
    where s.record_uri is not null and e.actor_did is not null and e.status not in ('draft', 'archived')
  `
  let written = 0
  let errors = 0
  for (const r of rows) {
    try {
      const results = await materializeSeries({ eventId: r.event_id, seriesId: r.id, callerUserId: null, now })
      written += results.filter((x) => !x.error).length
      errors += results.filter((x) => x.error).length
    } catch {
      errors++
    }
  }
  return { series: rows.length, written, errors }
}
