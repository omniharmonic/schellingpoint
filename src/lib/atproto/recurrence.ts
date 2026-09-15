/**
 * Recurrence expansion for `freeschool.draft.series` (spec §4.1, item 31). Pure and isomorphic.
 *
 * A series is anchored on a real first event (its `startsAt` is occurrence #1). Occurrences keep
 * the first event's WALL-CLOCK time in the series timezone, so "every Tuesday at 18:00" survives a
 * DST transition — the reason the lexicon makes `timezone` required. Supports the structured
 * fields the lexicon denormalises: freq daily/weekly/monthly/yearly, interval, byDay (weekly),
 * count XOR until, exdates. A local time a clock change skips is skipped, never shifted.
 */
import { parseTimeInTimezone } from '@/lib/events/timezone'
import type { SeriesFreq, WeekdayCode } from './types'

export interface RecurrenceRule {
  freq: SeriesFreq
  interval?: number | null
  byDay?: WeekdayCode[] | null
  count?: number | null
  until?: string | Date | null
  exdates?: Array<string | Date> | null
  timezone: string
}

export interface Occurrence {
  /** 1-based position in the series (the first event is 1). */
  sequence: number
  /** The instant the rule produces (RFC 5545 RECURRENCE-ID). */
  startsAt: string
}

const WEEKDAYS: WeekdayCode[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const HARD_CAP = 1000

function localParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(instant)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
    weekday: WEEKDAYS[['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'))]!,
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T12:00:00Z`).getTime() - new Date(`${a}T12:00:00Z`).getTime()) / 86_400_000)
}

function weekdayOf(date: string): WeekdayCode {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!
}

/**
 * Occurrences of the series whose start falls in `[first, horizon]`, in order, excluding exdates.
 * `sequence` counts every instant the rule produces (exdates included), so a skipped holiday does
 * not renumber the rest.
 */
export function expandRecurrence(firstStartsAt: string | Date, rule: RecurrenceRule, horizon: string | Date): Occurrence[] {
  if (rule.count && rule.until) throw new Error('a series may set count or until, not both (RFC 5545)')
  const first = new Date(firstStartsAt)
  const end = new Date(horizon)
  const until = rule.until ? new Date(rule.until) : null
  const interval = Math.max(1, Math.trunc(rule.interval ?? 1))
  const exdates = new Set((rule.exdates ?? []).map((d) => new Date(d).toISOString()))
  const { date: firstDate, time, weekday: firstWeekday } = localParts(first, rule.timezone)
  const byDay = rule.freq === 'weekly' && rule.byDay?.length ? new Set(rule.byDay) : new Set([firstWeekday])
  const [fy, fm, fd] = firstDate.split('-').map(Number) as [number, number, number]

  const out: Occurrence[] = []
  let produced = 0
  const push = (date: string): boolean => {
    let instant: Date
    try {
      instant = parseTimeInTimezone(time, date, rule.timezone)
    } catch {
      return true // the wall-clock time does not exist that day (clock change): skip it
    }
    if (instant < first) return true
    if (until && instant > until) return false
    if (instant > end) return false
    produced++
    if (rule.count && produced > rule.count) return false
    const iso = instant.toISOString()
    if (!exdates.has(iso)) out.push({ sequence: produced, startsAt: iso })
    return produced < HARD_CAP
  }

  if (rule.freq === 'daily') {
    for (let i = 0; ; i += interval) if (!push(addDays(firstDate, i))) break
  } else if (rule.freq === 'weekly') {
    // Weeks counted from the first event's week (Monday-based), `interval` weeks apart.
    const mondayOffset = (new Date(`${firstDate}T12:00:00Z`).getUTCDay() + 6) % 7
    const weekStart = addDays(firstDate, -mondayOffset)
    outer: for (let w = 0; ; w += interval) {
      for (let d = 0; d < 7; d++) {
        const date = addDays(weekStart, w * 7 + d)
        if (daysBetween(firstDate, date) < 0 || !byDay.has(weekdayOf(date))) continue
        if (!push(date)) break outer
      }
    }
  } else if (rule.freq === 'monthly') {
    for (let m = 0; m < HARD_CAP * interval; m += interval) {
      const y = fy + Math.floor((fm - 1 + m) / 12)
      const month = ((fm - 1 + m) % 12) + 1
      const days = new Date(Date.UTC(y, month, 0)).getUTCDate()
      if (fd > days) continue // no 31 February: RFC 5545 skips the month
      if (!push(`${y}-${String(month).padStart(2, '0')}-${String(fd).padStart(2, '0')}`)) break
    }
  } else {
    for (let n = 0; n < HARD_CAP * interval; n += interval) {
      const y = fy + n
      const days = new Date(Date.UTC(y, fm, 0)).getUTCDate()
      if (fd > days) continue
      if (!push(`${y}-${String(fm).padStart(2, '0')}-${String(fd).padStart(2, '0')}`)) break
    }
  }
  return out
}
