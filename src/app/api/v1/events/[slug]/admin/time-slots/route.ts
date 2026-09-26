/**
 * Time slots (room availability) of an event.
 *   GET  /api/v1/events/[slug]/admin/time-slots
 *   POST /api/v1/events/[slug]/admin/time-slots   { slots: SlotBody[] } or one SlotBody
 *
 * SlotBody = { venue_id, day_date: 'YYYY-MM-DD', start: 'HH:mm', end: 'HH:mm', label?, slot_type? }
 * with wall-clock times in the event's timezone. A bulk generate is one transaction: every
 * slot is saved or none is. Slots in the same room may not overlap each other or existing
 * availability; the rooms are locked for the duration so concurrent saves cannot race.
 */
import { asAccount, sql } from '@/lib/db'
import {
  InputError,
  errorResponse,
  fail,
  json,
  readBody,
  requireOrganizer,
  rolesWith,
  rolesWithAny,
} from '@/lib/scheduling/admin-api'
import { parseSlot } from '@/lib/scheduling/inputs'
import { assertNoOverlap } from '@/lib/scheduling/slots'
import { loadEvent, selectTimeSlots, syncProgramRecords } from '@/lib/scheduling/program'
import { MAX_SLOTS_PER_SAVE } from '@/lib/scheduling/slot-blocks'

export const dynamic = 'force-dynamic'

const READ_ROLES = rolesWithAny('manageVenues', 'manageSchedule', 'approveProposals')
const WRITE_ROLES = rolesWith('manageVenues')
// One number, shared with the editor that builds these bodies (src/lib/scheduling/slot-blocks.ts).
const MAX_SLOTS = MAX_SLOTS_PER_SAVE

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, READ_ROLES)
  if (ctx instanceof Response) return ctx
  try {
    return json({ timeSlots: await selectTimeSlots(sql, ctx.event.id) })
  } catch (e) {
    return errorResponse(e, 'list time slots')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, WRITE_ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  try {
    const event = await loadEvent(ctx.event.id)
    // A bulk save names the offending slot in `field` (`slots.3.start`): one impossible time in
    // two thousand — a wall clock the timezone skips on the morning the clocks go forward, say —
    // must say which one, not just that the batch was refused.
    const bulk = Array.isArray(body.slots)
    const rawSlots = bulk ? (body.slots as unknown[]) : [body]
    if (rawSlots.length === 0) return fail(400, 'Add at least one time slot')
    if (rawSlots.length > MAX_SLOTS) return fail(400, `At most ${MAX_SLOTS} slots can be saved at once`)
    const slots = rawSlots.map((raw, i) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new InputError(`Slot ${i + 1} is not an object`, bulk ? `slots.${i}` : 'slots')
      }
      return parseSlot(raw as Record<string, unknown>, event, bulk ? `slots.${i}.` : '')
    })

    const created = await asAccount(ctx.viewer.accountId, async (tx) => {
      await assertNoOverlap(tx, ctx.event.id, slots)
      const rows = await tx<{ id: string }[]>`
        insert into time_slots ${tx(slots.map((s) => ({ ...s, event_id: ctx.event.id })))}
        returning id
      `
      return selectTimeSlots(tx, ctx.event.id, rows.map((r) => r.id))
    })
    const network = await syncProgramRecords('slot-grids', event, ctx.viewer.accountId)
    return json({ timeSlots: created, network }, { status: 201 })
  } catch (e) {
    return errorResponse(e, 'create time slots')
  }
}
