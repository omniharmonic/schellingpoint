import 'server-only'
import type { Sql } from '@/lib/db'
import { InputError } from './admin-api'
import type { SlotInput } from './inputs'

function overlaps(a: Pick<SlotInput, 'start_time' | 'end_time'>, b: Pick<SlotInput, 'start_time' | 'end_time'>): boolean {
  return Date.parse(a.start_time) < Date.parse(b.end_time) && Date.parse(b.start_time) < Date.parse(a.end_time)
}

/**
 * Lock the rooms, then refuse any slot that overlaps another in the same room (existing rows,
 * excluding `ignoreSlotId`, and earlier slots of the same batch).
 */
export async function assertNoOverlap(tx: Sql, eventId: string, slots: SlotInput[], ignoreSlotId?: string): Promise<void> {
  const venueIds = [...new Set(slots.map((s) => s.venue_id))]
  const rooms = await tx<{ id: string; name: string }[]>`
    select id, name from venues where event_id = ${eventId} and id in ${tx(venueIds)} order by id for update
  `
  if (rooms.length !== venueIds.length) throw new InputError('A chosen room does not belong to this event', 'venue_id')
  const names = new Map(rooms.map((r) => [r.id, r.name]))
  const existing = await tx<{ id: string; venue_id: string; start_time: string; end_time: string }[]>`
    select id, venue_id, start_time, end_time from time_slots
    where event_id = ${eventId} and venue_id in ${tx(venueIds)}
  `
  slots.forEach((slot, index) => {
    const clash =
      existing.find((e) => e.id !== ignoreSlotId && e.venue_id === slot.venue_id && overlaps(e, slot)) ??
      slots.slice(0, index).find((other) => other.venue_id === slot.venue_id && overlaps(other, slot))
    if (clash) {
      throw new InputError(
        `${names.get(slot.venue_id) ?? 'This room'} already has availability overlapping ${slot.day_date}. Adjust the times before saving.`,
        'start',
        409,
        'SlotOverlap',
      )
    }
  })
}
