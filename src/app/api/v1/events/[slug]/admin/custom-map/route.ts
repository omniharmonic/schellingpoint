/**
 * The gathering's indoor / hand-drawn map (design §1.5).
 *
 *   GET    /api/v1/events/[slug]/admin/custom-map   → { custom_map, can_upload, image_max_bytes }
 *   PUT    /api/v1/events/[slug]/admin/custom-map   { custom_map: { image, corners|null, opacity, basemap } }
 *   DELETE /api/v1/events/[slug]/admin/custom-map   removes it
 *
 * Owners and admins only (`editEventSettings`), same-origin, scoped to the resolved event.
 *
 * `image` must be a path the app itself stored (`/uploads/<aa>/<sha256>.<ext>`, PNG/JPEG/WebP,
 * ≤ 8 MB) — the route refuses anything else, so a floor plan can never be an off-site URL the page
 * then fetches. `/uploads` is content-addressed and unguessable but NOT access-controlled: a floor
 * plan is a public asset, exactly like the gathering's logo, and the UI says so where it is chosen.
 *
 * A gathering whose every room is a private residence gets no custom map (409): a floor plan of a
 * home, on a public path, is the address the spec keeps out of everything (§8.1).
 *
 * `events.custom_map` is app-side only. It is never published; the privacy audit's `geo` check
 * fails if a `custom_map` value ever appears in a record.
 */
import { sql } from '@/lib/db'
import { errorResponse, fail, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { CustomMapError, CUSTOM_MAP_MAX_BYTES, parseCustomMap, readCustomMap } from '@/lib/geo/custom-map'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('editEventSettings')

type Params = { params: Promise<{ slug: string }> }

/** Rooms that are not private residences, and how many rooms there are at all. */
async function roomCounts(eventId: string): Promise<{ total: number; publicRooms: number }> {
  const [row] = await sql<{ total: number; public_rooms: number }[]>`
    select count(*)::int as total,
           count(*) filter (where coalesce(is_private_residence, false) = false)::int as public_rooms
    from venues where event_id = ${eventId}
  `
  return { total: row?.total ?? 0, publicRooms: row?.public_rooms ?? 0 }
}

export async function GET(request: Request, { params }: Params) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    const [row] = await sql<{ custom_map: unknown }[]>`select custom_map from events where id = ${ctx.event.id}`
    const rooms = await roomCounts(ctx.event.id)
    return json({
      custom_map: readCustomMap(row?.custom_map),
      can_upload: rooms.total === 0 || rooms.publicRooms > 0,
      image_max_bytes: CUSTOM_MAP_MAX_BYTES,
    })
  } catch (e) {
    return errorResponse(e, 'read custom map')
  }
}

export async function PUT(request: Request, { params }: Params) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body

  let customMap: ReturnType<typeof parseCustomMap>
  try {
    customMap = parseCustomMap('custom_map' in body ? body.custom_map : body)
  } catch (e) {
    if (e instanceof CustomMapError) return fail(400, e.message, { field: e.field })
    return errorResponse(e, 'save custom map')
  }

  try {
    if (customMap) {
      const rooms = await roomCounts(ctx.event.id)
      if (rooms.total > 0 && rooms.publicRooms === 0) {
        return fail(409, 'Every room here is a private residence, so there is no map to publish a floor plan on. Add a public room first.', {
          code: 'PrivateResidencesOnly',
        })
      }
    }
    await sql`
      update events set custom_map = ${customMap === null ? null : sql.json(customMap as never)}, updated_at = now()
      where id = ${ctx.event.id}
    `
    return json({ custom_map: customMap })
  } catch (e) {
    return errorResponse(e, 'save custom map')
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  try {
    await sql`update events set custom_map = null, updated_at = now() where id = ${ctx.event.id}`
    return json({ custom_map: null })
  } catch (e) {
    return errorResponse(e, 'remove custom map')
  }
}
