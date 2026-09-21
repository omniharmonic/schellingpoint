import 'server-only'
/**
 * Session summaries and gathering themes (design §10.3): generated on demand by organizers,
 * stored (`session_transcripts.summary`, `events.themes`), members-only, never records. Only
 * what the transcripts say goes in; the prompts forbid inventing content.
 */
import { sql } from '@/lib/db'
import { chatConfig, completeText, type ChatConfig } from './anthropic'

/** Longest transcript slice sent for a summary (≈ 100k tokens). */
const SUMMARY_INPUT_CHARS = 400_000
/** Per-session input to the themes pass when a session has no summary yet. */
const THEME_EXCERPT_CHARS = 1_500
const MAX_THEMES = 8

const SUMMARY_SYSTEM = `You write short summaries of unconference session transcripts for the people who attended the gathering.
Use only what the transcript says. Never invent names, numbers, quotes, decisions or details that are not in it; if the transcript is thin or unclear, say so briefly.
Write in the transcript's language. Plain prose with light Markdown: one paragraph of 100–180 words, then a "Key points" list of 3–6 short bullets, then — only if the transcript contains any — a "Decisions or next steps" list.`

const THEMES_SYSTEM = `You identify the themes that ran across the sessions of an unconference, for its members.
Use only the session summaries and excerpts you are given. Never invent content, and attribute a theme only to sessions whose text supports it.
Answer with JSON only, no prose around it, in this shape:
{"themes":[{"title":"short theme name","summary":"two or three sentences grounded in the sessions","sessions":["<session id>", "..."]}]}
Return between 3 and ${MAX_THEMES} themes, most prominent first.`

export interface ThemeEntry {
  title: string
  summary: string
  sessions: string[]
}

export interface EventThemes {
  generated_at: string
  model: string
  themes: ThemeEntry[]
}

export async function generateSessionSummary(cfg: ChatConfig, transcriptId: string): Promise<string | null> {
  const [row] = await sql<{ content: string; title: string }[]>`
    select t.content, s.title from session_transcripts t join sessions s on s.id = t.session_id where t.id = ${transcriptId}
  `
  if (!row || !row.content.trim()) return null
  const truncated = row.content.length > SUMMARY_INPUT_CHARS
  const body = truncated ? row.content.slice(0, SUMMARY_INPUT_CHARS) : row.content
  const user = `Session title: ${row.title}\n\nTRANSCRIPT${truncated ? ' (first part only; it was cut for length)' : ''}:\n\n${body}`
  const { text } = await completeText(cfg, { system: SUMMARY_SYSTEM, user, maxTokens: 1024 })
  const summary = text.trim()
  if (!summary) return null
  await sql`update session_transcripts set summary = ${summary}, summary_generated_at = now() where id = ${transcriptId}`
  return summary
}

function parseThemes(text: string, knownIds: Set<string>): ThemeEntry[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: { themes?: unknown }
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed.themes)) return []
  const themes: ThemeEntry[] = []
  for (const raw of parsed.themes.slice(0, MAX_THEMES)) {
    if (!raw || typeof raw !== 'object') continue
    const t = raw as Record<string, unknown>
    const title = typeof t.title === 'string' ? t.title.trim().slice(0, 120) : ''
    const summary = typeof t.summary === 'string' ? t.summary.trim().slice(0, 1200) : ''
    if (!title || !summary) continue
    const sessions = Array.isArray(t.sessions) ? t.sessions.filter((id): id is string => typeof id === 'string' && knownIds.has(id)) : []
    themes.push({ title, summary, sessions: [...new Set(sessions)] })
  }
  return themes
}

export async function generateEventThemes(cfg: ChatConfig, eventId: string): Promise<EventThemes | null> {
  const rows = await sql<{ session_id: string; title: string; summary: string | null; excerpt: string }[]>`
    select t.session_id, s.title, t.summary, left(t.content, ${THEME_EXCERPT_CHARS}) as excerpt
    from session_transcripts t join sessions s on s.id = t.session_id
    where t.event_id = ${eventId} and t.replaced_at is null and t.status = 'ready'
    order by s.title
  `
  if (!rows.length) return null
  const user = rows
    .map((r) => `SESSION ${r.session_id}\nTitle: ${r.title}\n${r.summary ? `Summary:\n${r.summary}` : `Excerpt:\n${r.excerpt}`}`)
    .join('\n\n---\n\n')
  const { text } = await completeText(cfg, { system: THEMES_SYSTEM, user, maxTokens: 2048 })
  const themes = parseThemes(text, new Set(rows.map((r) => r.session_id)))
  if (!themes.length) return null
  const result: EventThemes = { generated_at: new Date().toISOString(), model: cfg.model, themes }
  await sql`update events set themes = ${sql.json(result as unknown as Parameters<typeof sql.json>[0])}::jsonb where id = ${eventId}`
  return result
}

/**
 * The `summaries` job body: summarize every current transcript that has none, then refresh the
 * gathering's themes. Returns `done: false` when the deadline passed with work left.
 */
export async function runSummaries(eventId: string, deadline: number): Promise<{ done: boolean; processed: number }> {
  const cfg = chatConfig()
  if (!cfg) return { done: true, processed: 0 } // no answer model: a clean no-op
  let processed = 0
  const pending = await sql<{ id: string }[]>`
    select id from session_transcripts
    where event_id = ${eventId} and replaced_at is null and status = 'ready' and summary is null
    order by created_at
  `
  for (const row of pending) {
    if (Date.now() >= deadline) return { done: false, processed }
    await generateSessionSummary(cfg, row.id)
    processed += 1
  }
  if (Date.now() >= deadline) return { done: false, processed }
  await generateEventThemes(cfg, eventId)
  return { done: true, processed: processed + 1 }
}
