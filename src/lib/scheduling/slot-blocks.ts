/**
 * Bulk session blocks (design 2026-09-25 §4): one pattern per room per day, turned into slots.
 *
 * No `server-only` here on purpose: the editor in the browser, the slot-templates route and the
 * tests all generate from the same functions, so what the preview grid shows is exactly what the
 * POST carries. Everything is wall-clock time ("HH:MM") on an event day ("YYYY-MM-DD") in the
 * gathering's timezone — the route turns those into instants (`parseSlot`), as it always has.
 *
 * The uniform case (every room in lockstep, one pattern, every day) produces exactly the set of
 * slots the previous single-pattern generator produced; `generateSlots` is the only walker.
 */

/** One room's day: its hours, its slot length, the gap between slots, or closed. */
export interface RoomPattern {
  venueId: string
  /** 'HH:MM', wall clock in the gathering's timezone. */
  start: string
  end: string
  slotMinutes: number
  /** 0 = back-to-back slots. A break is only inserted when a further slot still fits. */
  breakMinutes: number
  closed: boolean
  /** Editor-only: this row follows the first room until it is unticked. Never sent anywhere. */
  sameAsFirst: boolean
}

export interface DayPlan {
  dayDate: string
  rooms: RoomPattern[]
}

/** What the POST carries, and what the preview grid draws. */
export interface GeneratedSlot {
  venueId: string
  dayDate: string
  startTime: string
  endTime: string
  label: string
  isBreak: boolean
}

export const SLOT_LENGTH_OPTIONS = [15, 20, 30, 45, 60, 90, 120] as const
export const BREAK_LENGTH_OPTIONS = [0, 5, 10, 15, 20, 30] as const

/** Editor defaults: 9am–5pm, hour-long slots, no break — the old generator's defaults. */
export const DEFAULT_PATTERN = { start: '09:00', end: '17:00', slotMinutes: 60, breakMinutes: 0 } as const

export const MAX_SLOTS_PER_SAVE = 2000

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/

export function timeToMinutes(time: string): number {
  const m = CLOCK.exec(time)
  if (!m) return NaN
  return Number(m[1]) * 60 + Number(m[2])
}

export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  return `${String(h).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

/** "9:00 AM" — the generator's own display format, kept out of the timezone machinery. */
export function formatClock(time: string): string {
  const total = timeToMinutes(time)
  if (Number.isNaN(total)) return time
  const hours = Math.floor(total / 60)
  const period = hours >= 12 ? 'PM' : 'AM'
  return `${hours % 12 || 12}:${String(total % 60).padStart(2, '0')} ${period}`
}

export function newRoomPattern(venueId: string, index = 0): RoomPattern {
  return { venueId, ...DEFAULT_PATTERN, closed: false, sameAsFirst: index > 0 }
}

/** A fresh plan: every day, every room, the default pattern, every row but the first in lockstep. */
export function newPlan(dayDates: readonly string[], venueIds: readonly string[]): DayPlan[] {
  return dayDates.map((dayDate) => ({ dayDate, rooms: venueIds.map((id, i) => newRoomPattern(id, i)) }))
}

/**
 * One room's slots for one day. A break is written only when another session still fits after
 * it, so a day never ends on a break.
 */
export function slotsForRoom(pattern: RoomPattern, dayDate: string): GeneratedSlot[] {
  if (pattern.closed) return []
  const start = timeToMinutes(pattern.start)
  const end = timeToMinutes(pattern.end)
  const length = Math.round(pattern.slotMinutes)
  const gap = Math.max(0, Math.round(pattern.breakMinutes))
  if (Number.isNaN(start) || Number.isNaN(end) || !Number.isFinite(length) || length <= 0 || end <= start) return []
  const out: GeneratedSlot[] = []
  let cursor = start
  while (cursor + length <= end) {
    const slotEnd = cursor + length
    out.push({ venueId: pattern.venueId, dayDate, startTime: minutesToTime(cursor), endTime: minutesToTime(slotEnd), label: '', isBreak: false })
    cursor = slotEnd
    if (gap > 0 && cursor + gap + length <= end) {
      const breakEnd = cursor + gap
      out.push({ venueId: pattern.venueId, dayDate, startTime: minutesToTime(cursor), endTime: minutesToTime(breakEnd), label: 'Break', isBreak: true })
      cursor = breakEnd
    }
    if (out.length > MAX_SLOTS_PER_SAVE) break
  }
  return out
}

/** Every slot the plan asks for, day by day, room by room. */
export function generateSlots(days: readonly DayPlan[]): GeneratedSlot[] {
  return days.flatMap((day) => day.rooms.flatMap((room) => slotsForRoom(room, day.dayDate)))
}

/** Sessions and breaks counted apart, for the preview's summary line. */
export function countSlots(slots: readonly GeneratedSlot[]): { sessions: number; breaks: number; total: number } {
  const breaks = slots.filter((s) => s.isBreak).length
  return { sessions: slots.length - breaks, breaks, total: slots.length }
}

export type ExistingSlot = Pick<GeneratedSlot, 'venueId' | 'dayDate' | 'startTime' | 'endTime'>

export const slotKey = (s: ExistingSlot) => `${s.venueId}|${s.dayDate}|${s.startTime}`

/** Keys of the generated slots that overlap availability the gathering already has. */
export function conflictKeys(generated: readonly GeneratedSlot[], existing: readonly ExistingSlot[]): Set<string> {
  const out = new Set<string>()
  for (const slot of generated) {
    const clash = existing.some(
      (e) => e.venueId === slot.venueId && e.dayDate === slot.dayDate && e.startTime < slot.endTime && slot.startTime < e.endTime,
    )
    if (clash) out.add(slotKey(slot))
  }
  return out
}

/* ─────────────────────────── editor-side plan edits ─────────────────────────── */

const TIMING: Array<keyof RoomPattern> = ['start', 'end', 'slotMinutes', 'breakMinutes']

/**
 * Pull every row marked "same as first room" back into lockstep with row 0. `closed` is never
 * copied: a room can be shut for a day while its hours still follow the first room's.
 */
export function syncRooms(rooms: readonly RoomPattern[]): RoomPattern[] {
  const first = rooms[0]
  if (!first) return []
  return rooms.map((room, i) => {
    if (i === 0 || !room.sameAsFirst) return { ...room }
    return { ...room, start: first.start, end: first.end, slotMinutes: first.slotMinutes, breakMinutes: first.breakMinutes }
  })
}

/** The same hours in another day's rooms, matched room by room (`closed` travels with them). */
export function copyDayRooms(from: readonly RoomPattern[], to: readonly RoomPattern[]): RoomPattern[] {
  return to.map((room, i) => {
    const source = from[i] ?? from[from.length - 1]
    if (!source) return { ...room }
    return { ...room, start: source.start, end: source.end, slotMinutes: source.slotMinutes, breakMinutes: source.breakMinutes, closed: source.closed, sameAsFirst: source.sameAsFirst }
  })
}

/* ─────────────────────────────── templates ─────────────────────────────── */

/**
 * A saved configuration. Rooms are stored by position with their name for legibility, never by
 * id: a template is applied to another gathering's rooms (clone carries templates), where the
 * ids are different but "three rooms, these hours" is exactly what the organizer meant.
 */
export interface TemplateRoom {
  room: string | null
  start: string
  end: string
  slotMinutes: number
  breakMinutes: number
  closed: boolean
}

export interface SlotTemplate {
  name: string
  days: Array<{ rooms: TemplateRoom[] }>
}

export const MAX_TEMPLATES = 10
export const MAX_TEMPLATE_NAME = 60
export const MAX_TEMPLATE_DAYS = 31
export const MAX_TEMPLATE_ROOMS = 60

export function planToTemplate(name: string, days: readonly DayPlan[], venueName: (id: string) => string | null): SlotTemplate {
  return {
    name: name.trim().slice(0, MAX_TEMPLATE_NAME),
    days: days.map((day) => ({
      rooms: day.rooms.map((room) => ({
        room: venueName(room.venueId),
        start: room.start,
        end: room.end,
        slotMinutes: room.slotMinutes,
        breakMinutes: room.breakMinutes,
        closed: room.closed,
      })),
    })),
  }
}

/**
 * Fill a plan from a template. A day beyond the template's length repeats its last day; a room
 * beyond its width repeats the last room. A room whose name matches one in the template takes
 * that room's hours wherever it sits, so adding a room in the middle does not shuffle the rest.
 * `sameAsFirst` is derived: a row equal to the first room's hours stays in lockstep.
 */
export function applyTemplate(
  template: SlotTemplate,
  dayDates: readonly string[],
  venues: readonly { id: string; name: string }[],
): DayPlan[] {
  return dayDates.map((dayDate, dayIndex) => {
    const day = template.days[Math.min(dayIndex, template.days.length - 1)]
    const byName = new Map((day?.rooms ?? []).filter((r) => r.room).map((r) => [r.room as string, r]))
    const rooms = venues.map((venue, i) => {
      const source = byName.get(venue.name) ?? day?.rooms[Math.min(i, (day?.rooms.length ?? 1) - 1)]
      const base = newRoomPattern(venue.id, i)
      if (!source) return base
      return { ...base, start: source.start, end: source.end, slotMinutes: source.slotMinutes, breakMinutes: source.breakMinutes, closed: source.closed }
    })
    const first = rooms[0]
    return {
      dayDate,
      rooms: rooms.map((room, i) => ({
        ...room,
        sameAsFirst: i > 0 && !!first && TIMING.every((key) => room[key] === first[key]),
      })),
    }
  })
}

export type TemplateCheck = { ok: true; templates: SlotTemplate[] } | { ok: false; error: string }

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function checkRoom(raw: unknown, where: string): TemplateRoom | string {
  if (!isObject(raw)) return `${where} is not a room`
  const start = raw.start
  const end = raw.end
  if (typeof start !== 'string' || !CLOCK.test(start)) return `${where} has no start time (HH:MM)`
  if (typeof end !== 'string' || !CLOCK.test(end)) return `${where} has no end time (HH:MM)`
  const slotMinutes = raw.slotMinutes
  const breakMinutes = raw.breakMinutes ?? 0
  if (typeof slotMinutes !== 'number' || !Number.isInteger(slotMinutes) || slotMinutes < 5 || slotMinutes > 480) {
    return `${where} needs a slot length of 5 to 480 minutes`
  }
  if (typeof breakMinutes !== 'number' || !Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 240) {
    return `${where} needs a break of 0 to 240 minutes`
  }
  const room = raw.room
  if (room !== undefined && room !== null && (typeof room !== 'string' || room.length > 120)) return `${where} has an invalid room name`
  if (raw.closed !== undefined && typeof raw.closed !== 'boolean') return `${where} has an invalid closed flag`
  return { room: typeof room === 'string' ? room : null, start, end, slotMinutes, breakMinutes, closed: raw.closed === true }
}

/**
 * Validate a whole template list: shape, sizes and nothing else carried along. Returns the
 * normalized list (unknown keys dropped) so what is stored is only ever what this understands.
 */
export function checkTemplates(value: unknown): TemplateCheck {
  if (!Array.isArray(value)) return { ok: false, error: 'Templates must be a list' }
  if (value.length > MAX_TEMPLATES) return { ok: false, error: `Keep at most ${MAX_TEMPLATES} templates` }
  const templates: SlotTemplate[] = []
  const names = new Set<string>()
  for (const [i, raw] of value.entries()) {
    const at = `Template ${i + 1}`
    if (!isObject(raw)) return { ok: false, error: `${at} is not a template` }
    const name = typeof raw.name === 'string' ? raw.name.trim() : ''
    if (!name) return { ok: false, error: `${at} needs a name` }
    if (name.length > MAX_TEMPLATE_NAME) return { ok: false, error: `${at}: a name is at most ${MAX_TEMPLATE_NAME} characters` }
    if (names.has(name.toLowerCase())) return { ok: false, error: `Two templates are both called "${name}"` }
    names.add(name.toLowerCase())
    if (!Array.isArray(raw.days) || raw.days.length === 0) return { ok: false, error: `${at} has no days` }
    if (raw.days.length > MAX_TEMPLATE_DAYS) return { ok: false, error: `${at} has too many days` }
    const days: SlotTemplate['days'] = []
    for (const [d, rawDay] of raw.days.entries()) {
      if (!isObject(rawDay) || !Array.isArray(rawDay.rooms)) return { ok: false, error: `${at}, day ${d + 1} has no rooms` }
      if (rawDay.rooms.length > MAX_TEMPLATE_ROOMS) return { ok: false, error: `${at}, day ${d + 1} has too many rooms` }
      const rooms: TemplateRoom[] = []
      for (const [r, rawRoom] of rawDay.rooms.entries()) {
        const room = checkRoom(rawRoom, `${at}, day ${d + 1}, room ${r + 1}`)
        if (typeof room === 'string') return { ok: false, error: room }
        rooms.push(room)
      }
      days.push({ rooms })
    }
    templates.push({ name, days })
  }
  return { ok: true, templates }
}
