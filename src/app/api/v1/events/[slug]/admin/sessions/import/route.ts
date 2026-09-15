/**
 * POST /api/v1/events/[slug]/admin/sessions/import — CSV import of curated sessions.
 *
 * Body: { rows: [{ title, description?, host_name?, format?, duration?, track? (name) | track_id?, status? }] }
 * (the browser parses the CSV; the server validates every row again).
 *
 * All rows run in one organizer transaction with a savepoint per row, so one bad row is
 * reported without losing the others. Named speakers become "listed as" names on host-less
 * sessions (R9): stored organizer-only, never published.
 */
import { asAccount } from '@/lib/db'
import { InputError, errorResponse, fail, json, readBody, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { insertCuratedSession, parseCuratedSession } from '@/lib/scheduling/sessions'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')
const MAX_ROWS = 500

interface RowResult {
  row: number
  title: string
  ok: boolean
  id?: string
  error?: string
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx
  const body = await readBody(request)
  if (body instanceof Response) return body
  const rows = body.rows
  if (!Array.isArray(rows) || rows.length === 0) return fail(400, 'Add at least one row to import', { field: 'rows' })
  if (rows.length > MAX_ROWS) return fail(400, `At most ${MAX_ROWS} rows can be imported at once`, { field: 'rows' })

  try {
    const results = await asAccount(ctx.viewer.accountId, async (tx) => {
      const tracks = await tx<{ id: string; name: string }[]>`select id, name from tracks where event_id = ${ctx.event.id}`
      const trackByName = new Map(tracks.map((t) => [t.name.trim().toLowerCase(), t.id]))
      const out: RowResult[] = []
      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i]
        const title = raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).title === 'string'
          ? String((raw as Record<string, unknown>).title).trim()
          : ''
        try {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InputError('Row is not an object')
          const record = { ...(raw as Record<string, unknown>) }
          if (typeof record.format === 'string') record.format = record.format.trim().toLowerCase() || undefined
          if (typeof record.status === 'string') record.status = record.status.trim().toLowerCase() || undefined
          if (record.status === 'scheduled') throw new InputError('Imported sessions cannot be scheduled; place them in the schedule builder')
          if (!record.track_id && typeof record.track === 'string' && record.track.trim()) {
            const trackId = trackByName.get(record.track.trim().toLowerCase())
            if (!trackId) throw new InputError(`Unknown track "${record.track.trim()}"`)
            record.track_id = trackId
          }
          const input = parseCuratedSession(record)
          const id = await tx.savepoint((sp) => insertCuratedSession(sp, ctx.event.id, ctx.viewer.accountId, input, { importedFrom: 'csv' }))
          out.push({ row: i + 1, title: input.title, ok: true, id })
        } catch (e) {
          if (e instanceof InputError) {
            out.push({ row: i + 1, title, ok: false, error: e.message })
            continue
          }
          const code = (e as { code?: string })?.code
          if (code === '23514' || code === 'P0001' || code === '23505' || code === '23503' || code === '22P02') {
            out.push({ row: i + 1, title, ok: false, error: e instanceof Error ? e.message : 'Rejected by the database' })
            continue
          }
          throw e
        }
      }
      return out
    })
    const created = results.filter((r) => r.ok).length
    return json({ created, failed: results.length - created, results }, { status: created > 0 ? 201 : 200 })
  } catch (e) {
    return errorResponse(e, 'import sessions')
  }
}
