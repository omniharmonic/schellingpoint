import { after } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { jsonError } from '@/app/api/v1/sessions/_lib/access'
import { json } from '@/app/api/v1/sessions/_lib/access'
import { resolveChatConfig } from '@/lib/knowledge/chat-provider'
import { enqueueKnowledgeJob, runDueKnowledgeJobs } from '@/lib/knowledge/jobs'
import { ORGANIZER_ROLES } from '@/lib/knowledge/store'

/**
 * POST /api/v1/events/[slug]/knowledge/summaries  (design §10.3, organizers)
 *
 * Queue the summaries job: a summary for every transcript without one, then the gathering's
 * themes. Stored members-only, never records. Without `ANTHROPIC_API_KEY` this is a clean no-op:
 * 200 `{ configured: false, queued: false }`.
 *
 * PATCH /api/v1/events/[slug]/knowledge/summaries  { themes: [{ title, summary, sessions? }] }
 *
 * Organizers edit what was generated (design §10.3): the themes members read are these, and
 * `themes_edited_at/_by` record who stands behind them. `themes: []` clears them. Sessions are
 * kept only when they belong to this gathering — a theme never points outside it.
 */

export const runtime = 'nodejs'

type RouteParams = { params: Promise<{ slug: string }> }

export async function POST(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const gate = await requireEventRole(request, slug, ORGANIZER_ROLES)
  if (gate instanceof Response) return gate
  const cfg = await resolveChatConfig(gate.event.id)
  if (!cfg) {
    return json({
      configured: false,
      queued: false,
      message: 'No answer model is configured. Add this gathering’s own key under Answers, or ask the operator to set one for the server.',
    })
  }
  const job = await enqueueKnowledgeJob(sql, gate.event.id, 'summaries', gate.viewer.accountId)
  if (job.created) after(() => runDueKnowledgeJobs({ jobId: job.id, timeBudgetMs: 240_000 }).then(() => undefined).catch(() => undefined))
  return json({ configured: true, queued: job.created, job_id: job.id, model: cfg.model })
}

const MAX_THEMES = 12
const MAX_TITLE = 120
const MAX_SUMMARY = 2_000

export async function PATCH(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const gate = await requireEventRole(request, slug, ORGANIZER_ROLES)
  if (gate instanceof Response) return gate

  let body: { themes?: unknown }
  try {
    body = (await request.json()) as { themes?: unknown }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  if (!Array.isArray(body.themes)) return jsonError(400, 'Send the themes as an array', { field: 'themes' })
  if (body.themes.length > MAX_THEMES) return jsonError(400, `At most ${MAX_THEMES} themes`, { field: 'themes' })

  const known = new Set(
    (await sql<{ id: string }[]>`select id from sessions where event_id = ${gate.event.id}`).map((r) => r.id),
  )
  const themes: Array<{ title: string; summary: string; sessions: string[] }> = []
  for (const raw of body.themes) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Record<string, unknown>
    const title = typeof t.title === 'string' ? t.title.trim().slice(0, MAX_TITLE) : ''
    const summary = typeof t.summary === 'string' ? t.summary.trim().slice(0, MAX_SUMMARY) : ''
    if (!title || !summary) continue
    const sessions = Array.isArray(t.sessions) ? t.sessions.filter((id): id is string => typeof id === 'string' && known.has(id)) : []
    themes.push({ title, summary, sessions: [...new Set(sessions)] })
  }

  const [existing] = await sql<{ themes: { generated_at?: string; model?: string } | null }[]>`
    select themes from events where id = ${gate.event.id}
  `
  const value = themes.length
    ? {
        generated_at: existing?.themes?.generated_at ?? new Date().toISOString(),
        model: existing?.themes?.model ?? 'edited',
        themes,
      }
    : null
  await sql`
    update events set
      themes = ${value ? sql.json(value as never) : null},
      themes_edited_at = ${value ? sql`now()` : null},
      themes_edited_by = ${value ? gate.viewer.accountId : null}
    where id = ${gate.event.id}
  `
  return json({ themes: value, edited: true })
}
