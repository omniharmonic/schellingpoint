/**
 * Shared vocabulary for proposing, editing and curating sessions (spec §3 "Propose / edit
 * session"). The propose page, the edit dialog and the organizer "Add a session" form all
 * read from here so a format or duration is described the same way everywhere.
 *
 * Formats and durations are the organizer-settings lists (`admin/settings/_components/
 * constants.ts`); this module only adds descriptions, time options and attendance bands.
 */

import { SESSION_FORMATS as FORMAT_OPTIONS, SESSION_DURATIONS } from '@/app/e/[slug]/admin/settings/_components/constants'

export interface SessionFormat {
  value: string
  label: string
  description: string
}

const FORMAT_DESCRIPTIONS: Record<string, string> = {
  talk: 'A presentation by one or more speakers',
  workshop: 'Hands-on and interactive',
  panel: 'Several speakers discuss a topic',
  discussion: 'An open group conversation',
  demo: 'A live demonstration',
  fireside: 'An interview-style conversation',
  ceremony: 'Opening, closing or ritual',
}

/** Every preset format with a one-line description. */
export const SESSION_FORMATS: SessionFormat[] = FORMAT_OPTIONS.map((f) => ({
  value: f.value,
  label: f.label,
  description: FORMAT_DESCRIPTIONS[f.value] ?? 'Custom format',
}))

export { SESSION_DURATIONS }

/** "fireside-chat" → "Fireside chat" for organizer-defined formats outside the preset list. */
export function humanizeFormat(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value
}

/** Display label for any format value: preset label or a humanized custom value. */
export function formatLabel(value: string | null | undefined): string {
  if (!value) return 'Session'
  return SESSION_FORMATS.find((f) => f.value === value)?.label ?? humanizeFormat(value)
}

/** One-line description of a format, or the generic fallback for custom values. */
export function formatDescription(value: string | null | undefined): string {
  return (value && FORMAT_DESCRIPTIONS[value]) || 'Custom format'
}

/** Formats an organizer allows, in preset order, with any custom values appended. */
export function allowedFormatOptions(allowed: string[], keep?: string | null): SessionFormat[] {
  const base = allowed.length === 0 ? SESSION_FORMATS : SESSION_FORMATS.filter((f) => allowed.includes(f.value))
  const custom = allowed
    .filter((v) => !SESSION_FORMATS.some((f) => f.value === v))
    .map((v) => ({ value: v, label: humanizeFormat(v), description: 'Custom format' }))
  const list = [...base, ...custom]
  if (keep && !list.some((f) => f.value === keep)) {
    list.push(SESSION_FORMATS.find((f) => f.value === keep) ?? { value: keep, label: humanizeFormat(keep), description: 'Custom format' })
  }
  return list
}

export function durationLabel(minutes: number): string {
  return `${minutes} min`
}

/** Durations an organizer allows (sorted), or the preset list. */
export function allowedDurationOptions(allowed: number[]): number[] {
  const list = allowed.length === 0 ? SESSION_DURATIONS : [...allowed]
  return [...new Set(list)].sort((a, b) => a - b)
}

export interface TimeOption {
  /** HH:MM, 24-hour. */
  value: string
  /** "9:30 AM". */
  label: string
}

/** Half-hour steps for the whole day (00:00–23:30), so early and late self-hosted sessions fit. */
export const TIME_OPTIONS: TimeOption[] = (() => {
  const out: TimeOption[] = []
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 30]) {
      const hh = String(h).padStart(2, '0')
      const mm = String(m).padStart(2, '0')
      const hour12 = h % 12 === 0 ? 12 : h % 12
      out.push({ value: `${hh}:${mm}`, label: `${hour12}:${mm} ${h < 12 ? 'AM' : 'PM'}` })
    }
  }
  return out
})()

export interface AttendanceBand {
  /** The number stored as `expected_attendance`; the label says exactly this. */
  value: number
  label: string
  description: string
}

/** Honest labels: each band names the number it stores. */
export const EXPECTED_ATTENDANCE: AttendanceBand[] = [
  { value: 10, label: 'Up to 10', description: 'An intimate conversation' },
  { value: 25, label: 'Up to 25', description: 'A typical session' },
  { value: 50, label: 'Up to 50', description: 'A popular topic' },
  { value: 100, label: 'Up to 100', description: 'A large room' },
  { value: 150, label: 'Up to 150', description: 'Keynote-sized' },
]

/** Neutral suggestions shown when the gathering has not set its own topics. */
export const DEFAULT_TAGS: string[] = [
  'community', 'education', 'design', 'research', 'tooling', 'organizing', 'art', 'wellbeing',
]

/** How many topic tags a session may carry. */
export const MAX_TAGS = 5

/**
 * "What the room needs" (PRD §4.2 step 4). The real vocabulary is the union of the
 * gathering's own `venues.features` (served by `GET /api/v1/events/[slug]/room-features`);
 * these four are offered only when no room has been described yet, so the field still works
 * during setup. A proposer may always add a word of their own.
 */
export const DEFAULT_ROOM_FEATURES: string[] = ['projector', 'whiteboard', 'audio', 'flexible seating']

/** How many required features a proposal may carry (mirrors the validator's limit). */
export const MAX_REQUIRED_FEATURES = 10
