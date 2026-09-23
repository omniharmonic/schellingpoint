import 'server-only'
/**
 * Ranking without pgvector (design §10.3, decision 5): the gathering's embedded chunks are loaded
 * once per question and scored by cosine similarity in the app. A gathering's corpus is small
 * (hundreds to a few thousand chunks); revisit with a purpose-built Postgres image past ~50k.
 */
import { sql } from '@/lib/db'
import { firstMarker } from './chunk'

/** The viewer's reading tier (see `readTier` in ./store): organizers see every transcript. */
export type ReadTier = 'organizers' | 'members'

/**
 * SQL predicate mirroring `canReadTranscript`: a member sees a chunk only when both the
 * gathering's setting and the transcript's own tier are 'members'. Aliases: t = the transcript,
 * e = the gathering.
 */
export function tierPredicate(tier: ReadTier) {
  return tier === 'organizers' ? sql`` : sql`and t.visibility = 'members' and e.transcripts_visibility = 'members'`
}

/** Below this cosine score a chunk is not offered as a source (`KNOWLEDGE_MIN_SCORE` overrides). */
export const DEFAULT_MIN_SCORE = 0.3
export const DEFAULT_TOP_K = 8

export function minScore(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.KNOWLEDGE_MIN_SCORE)
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : DEFAULT_MIN_SCORE
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export interface RankedChunk {
  id: string
  session_id: string
  session_title: string
  chunk_index: number
  text: string
  marker: string | null
  score: number
}

interface ChunkRow {
  id: string
  session_id: string
  session_title: string
  chunk_index: number
  text: string
  embedding: number[] | null
}

/** Top `limit` chunks of the gathering embedded with `model` that `tier` may read, best first, above `threshold`. */
export async function rankEventChunks(
  eventId: string,
  query: readonly number[],
  options: { model: string; tier: ReadTier; limit?: number; threshold?: number },
): Promise<RankedChunk[]> {
  const limit = options.limit ?? DEFAULT_TOP_K
  const threshold = options.threshold ?? minScore()
  const rows = await sql<ChunkRow[]>`
    select c.id, c.session_id, s.title as session_title, c.chunk_index, c.text, c.embedding
    from transcript_chunks c
    join session_transcripts t on t.id = c.transcript_id and t.replaced_at is null and t.status = 'ready'
    join sessions s on s.id = c.session_id
    join events e on e.id = c.event_id
    where c.event_id = ${eventId} and c.embedding is not null and c.embedding_model = ${options.model}
      -- A session hidden by moderation is out of search too, including the MCP server's
      -- (migration 0033): hiding a session that must not be read and then answering questions
      -- out of its transcript would defeat the hiding.
      and not coalesce(s.hidden_by_moderation, false)
      ${tierPredicate(options.tier)}
  `
  const scored: RankedChunk[] = []
  for (const row of rows) {
    if (!row.embedding || row.embedding.length !== query.length) continue
    const score = cosine(query, row.embedding)
    if (score < threshold) continue
    scored.push({
      id: row.id,
      session_id: row.session_id,
      session_title: row.session_title,
      chunk_index: row.chunk_index,
      text: row.text,
      marker: firstMarker(row.text),
      score,
    })
  }
  scored.sort((a, b) => b.score - a.score || a.session_id.localeCompare(b.session_id) || a.chunk_index - b.chunk_index)
  return scored.slice(0, limit)
}
