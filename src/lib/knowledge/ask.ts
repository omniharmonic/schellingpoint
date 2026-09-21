import 'server-only'
/**
 * "Ask the gathering" (design §10.3): question → embed → top-8 chunks of this gathering →
 * streamed answer with citations `[Session title · mm:ss]`. Answers come only from the
 * gathering's own chunks; when nothing scores above the threshold the answer says so instead.
 * Everything stays inside the members boundary: the provider sees the question and the chunks.
 */
import { sql } from '@/lib/db'
import { chatConfig, streamText, type StreamEvent } from './anthropic'
import { embedTexts, embeddingsConfig } from './embeddings'
import { markerLabel } from './normalize'
import { rankEventChunks, tierPredicate, type RankedChunk, type ReadTier } from './rank'

export const MAX_QUESTION_CHARS = 1000
const EXCERPT_CHARS = 240

export type AskUnavailableReason = 'chat' | 'embeddings' | 'no-transcripts' | 'no-embeddings'

export interface AskAvailability {
  available: boolean
  reason: AskUnavailableReason | null
  ready_transcripts: number
  embedded_chunks: number
}

/** Whether the viewer (at `tier`) can ask right now, and why not otherwise. Counts only what the tier may read. */
export async function askAvailability(eventId: string, tier: ReadTier): Promise<AskAvailability> {
  const chat = chatConfig()
  const embeddings = embeddingsConfig()
  const [counts] = await sql<{ transcripts: number; embedded: number }[]>`
    select (select count(*) from session_transcripts t join events e on e.id = t.event_id
              where t.event_id = ${eventId} and t.replaced_at is null and t.status = 'ready' ${tierPredicate(tier)}) as transcripts,
           (select count(*) from transcript_chunks c
              join session_transcripts t on t.id = c.transcript_id and t.replaced_at is null
              join events e on e.id = c.event_id
              where c.event_id = ${eventId} and c.embedding is not null and c.embedding_model = ${embeddings?.model ?? null} ${tierPredicate(tier)}) as embedded
  `
  const base = { ready_transcripts: counts?.transcripts ?? 0, embedded_chunks: counts?.embedded ?? 0 }
  if (!chat) return { available: false, reason: 'chat', ...base }
  if (!embeddings) return { available: false, reason: 'embeddings', ...base }
  if (!base.ready_transcripts) return { available: false, reason: 'no-transcripts', ...base }
  if (!base.embedded_chunks) return { available: false, reason: 'no-embeddings', ...base }
  return { available: true, reason: null, ...base }
}

export interface AskSource {
  n: number
  chunk_id: string
  session_id: string
  title: string
  /** `12:30`, when the chunk carries a marker. */
  marker: string | null
  /** The citation label the answer uses: `Session title · 12:30`. */
  label: string
  score: number
  excerpt: string
  href: string
}

export function citationLabel(title: string, marker: string | null): string {
  return marker ? `${title} · ${marker}` : title
}

function toSource(chunk: RankedChunk, n: number, slug: string): AskSource {
  const marker = markerLabel(chunk.marker)
  const text = chunk.text.replace(/\s+/g, ' ').trim()
  return {
    n,
    chunk_id: chunk.id,
    session_id: chunk.session_id,
    title: chunk.session_title,
    marker,
    label: citationLabel(chunk.session_title, marker),
    score: Math.round(chunk.score * 1000) / 1000,
    excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS).trimEnd()}…` : text,
    href: `/e/${slug}/sessions/${chunk.session_id}#transcript`,
  }
}

const ANSWER_SYSTEM = (gathering: string) => `You answer questions from members of the gathering "${gathering}" using ONLY the numbered SOURCES below, which are excerpts of session transcripts from that gathering.
Rules:
- Every claim must come from the sources. Never invent content, names, numbers, quotes or decisions that are not in them. Do not use outside knowledge about the topic.
- Cite as you go, using the exact citation label given for each source in square brackets, e.g. [${'Session title · 12:30'}]. Cite at least one source per paragraph.
- If the sources do not answer the question, or only partly, say so plainly and point to what they do cover. Do not guess.
- Be concise: a short answer, a few paragraphs at most. Answer in the language of the question.`

export type PreparedAsk =
  | { status: 'unavailable'; reason: AskUnavailableReason }
  | { status: 'no-sources'; sources: [] }
  | { status: 'ready'; sources: AskSource[]; run: (signal?: AbortSignal) => AsyncGenerator<StreamEvent> }

export function validateQuestion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const q = value.replace(/\s+/g, ' ').trim()
  if (q.length < 3 || q.length > MAX_QUESTION_CHARS) return null
  return q
}

/** Rank the sources the viewer's `tier` may read; `run` streams the answer over them. */
export async function prepareAsk(event: { id: string; name: string; slug: string }, question: string, tier: ReadTier): Promise<PreparedAsk> {
  const chat = chatConfig()
  const embeddings = embeddingsConfig()
  if (!chat) return { status: 'unavailable', reason: 'chat' }
  if (!embeddings) return { status: 'unavailable', reason: 'embeddings' }
  const [vector] = await embedTexts([question], 'query', embeddings)
  if (!vector) return { status: 'unavailable', reason: 'embeddings' }
  const ranked = await rankEventChunks(event.id, vector, { model: embeddings.model, tier })
  if (!ranked.length) return { status: 'no-sources', sources: [] }
  const sources = ranked.map((chunk, i) => toSource(chunk, i + 1, event.slug))
  const user = [
    'SOURCES:',
    ...ranked.map((chunk, i) => `[${i + 1}] citation label: "${sources[i].label}"\n${chunk.text}`),
    `QUESTION: ${question}`,
  ].join('\n\n')
  return {
    status: 'ready',
    sources,
    run: (signal) => streamText(chat, { system: ANSWER_SYSTEM(event.name), user, maxTokens: 2048 }, signal),
  }
}

/** One server-sent event frame for the client stream. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
