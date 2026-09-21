/**
 * Small copy helpers so every surface counts, elides and dates things the same way (spec §2.6).
 *
 *   plural(3, 'session')            → "3 sessions"
 *   plural(1, 'person', 'people')   → "1 person"
 *   formatDateRange(start, end, tz) → "Mar 3–5, 2026" · "Mar 30 – Apr 2, 2026" · "Dec 30, 2026 – Jan 2, 2027"
 *   `Loading${ELLIPSIS}`            → "Loading…"   (never "...")
 */

/** The typographic ellipsis. Use it instead of three periods. */
export const ELLIPSIS = '…'

/** En dash for ranges. */
export const EN_DASH = '–'

/** Middle dot separator: "Mar 3 · Room A". */
export const SEPARATOR = ' · '

/**
 * "1 session" / "3 sessions". Pass an explicit plural form for irregular words
 * (`plural(n, 'person', 'people')`). Formats the number with the viewer's locale.
 */
export function plural(n: number, word: string, pluralWord?: string): string {
  const form = n === 1 ? word : (pluralWord ?? defaultPlural(word))
  return `${n.toLocaleString()} ${form}`
}

function defaultPlural(word: string): string {
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`
  return `${word}s`
}

type DateInput = string | number | Date

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value)
}

function parts(date: Date, timeZone?: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
  const map: Record<string, string> = {}
  for (const p of fmt.formatToParts(date)) map[p.type] = p.value
  return { year: map.year, month: map.month, day: map.day }
}

/**
 * A compact, unambiguous date range. Handles the same day, same month, same year
 * and the cross-year branch:
 *
 *   same day        → "Mar 3, 2026"
 *   same month      → "Mar 3–5, 2026"
 *   same year       → "Mar 30 – Apr 2, 2026"
 *   different years → "Dec 30, 2026 – Jan 2, 2027"
 *
 * Missing/invalid `end` falls back to the single start date. `timeZone` should be the
 * gathering's timezone so day boundaries are the organizer's, not the viewer's.
 */
export function formatDateRange(start: DateInput, end?: DateInput | null, timeZone?: string): string {
  const s = toDate(start)
  if (Number.isNaN(s.getTime())) return ''
  const a = parts(s, timeZone)
  const single = `${a.month} ${a.day}, ${a.year}`
  if (end == null) return single
  const e = toDate(end)
  if (Number.isNaN(e.getTime())) return single
  const b = parts(e, timeZone)

  if (a.year !== b.year) return `${a.month} ${a.day}, ${a.year} ${EN_DASH} ${b.month} ${b.day}, ${b.year}`
  if (a.month !== b.month) return `${a.month} ${a.day} ${EN_DASH} ${b.month} ${b.day}, ${a.year}`
  if (a.day !== b.day) return `${a.month} ${a.day}${EN_DASH}${b.day}, ${a.year}`
  return single
}

/** Truncate to `max` characters with a real ellipsis; returns the input untouched when it fits. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`
}
