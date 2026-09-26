/**
 * Saved bulk-block shapes of a gathering (design 2026-09-25 §4).
 *
 *   GET /api/v1/events/[slug]/admin/slot-templates            → { templates: SlotTemplate[] }
 *   PUT /api/v1/events/[slug]/admin/slot-templates  { templates } → { templates }
 *
 * PUT replaces the whole list — the editor holds all of it, "save as template" and "delete
 * template" are both a new list — so there is no per-entry route to get out of step with the
 * column's constraint. Same permission as the page that uses it (`manageVenues`: owner, admin),
 * same order as every other admin mutation: same-origin, then the role, then validation, then
 * one statement filtered by the resolved event id.
 *
 * Templates are organizer-authored shapes ("three rooms, 9–5, hour slots"). They are app-side
 * only: nothing here is published to a record, and the column is never returned to a member —
 * `transformEventRow` does not carry it.
 */
import { sql } from '@/lib/db'
import { errorResponse, fail, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { checkTemplates, MAX_TEMPLATES, type SlotTemplate } from '@/lib/scheduling/slot-blocks'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageVenues')

async function readTemplates(eventId: string): Promise<SlotTemplate[]> {
  const [row] = await sql<{ slot_templates: unknown }[]>`select slot_templates from events where id = ${eventId}`
  const checked = checkTemplates(row?.slot_templates ?? [])
  // A row that somehow holds something this version does not understand reads as empty rather
  // than breaking the editor; the next save replaces it with a list this code wrote.
  return checked.ok ? checked.templates : []
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    return json({ templates: await readTemplates(ctx.event.id) })
  } catch (e) {
    return errorResponse(e, 'list slot templates')
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  const checked = checkTemplates(body.templates)
  if (!checked.ok) return fail(400, checked.error, { field: 'templates' })
  if (checked.templates.length > MAX_TEMPLATES) return fail(400, `Keep at most ${MAX_TEMPLATES} templates`, { field: 'templates' })

  try {
    const [row] = await sql<{ slot_templates: unknown }[]>`
      update events set slot_templates = ${sql.json(checked.templates as never)}, updated_at = now()
      where id = ${ctx.event.id}
      returning slot_templates
    `
    const stored = checkTemplates(row?.slot_templates ?? [])
    return json({ templates: stored.ok ? stored.templates : checked.templates })
  } catch (e) {
    return errorResponse(e, 'save slot templates')
  }
}
