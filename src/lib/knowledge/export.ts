import 'server-only'
/**
 * Corpus export (design §10.2): a zip with `corpus.jsonl` (one chunk per line), `sessions.json`,
 * `README.md` (schema + embedding recipe) and the transcripts as Markdown. Organizers only; the
 * download is logged (`knowledge_exports`). Hosts appear by display name only — this is a
 * members-only artifact, never published.
 */
import { strToU8, zipSync } from 'fflate'
import { sql } from '@/lib/db'
import { CHUNK_OVERLAP_RATIO, CHUNK_TARGET_CHARS, firstMarker } from './chunk'
import { markerLabel } from './normalize'

export const CORPUS_SCHEMA_VERSION = 1

export interface CorpusLine {
  id: string
  session_id: string
  title: string
  hosts: string[]
  track: string | null
  day: string | null
  start: string | null
  venue: string | null
  chunk_index: number
  text: string
  tags: string[]
  /** Not in the spec's list, added for citations: the first `[mm:ss]` marker of the chunk. */
  marker: string | null
}

export interface CorpusExport {
  zip: Uint8Array
  sessionCount: number
  chunkCount: number
}

export interface SessionRow {
  id: string
  title: string
  description: string | null
  format: string | null
  duration: number | null
  topic_tags: string[] | null
  hosts: string[]
  track: string | null
  day: string | null
  start: string | null
  end: string | null
  venue: string | null
  transcript_id: string
  transcript_format: string
  language: string | null
  char_count: number
  summary: string | null
  content: string
}

interface ChunkRow {
  id: string
  session_id: string
  chunk_index: number
  text: string
}

function slugify(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session'
}

function readme(gathering: { name: string; slug: string }, chunkCount: number, sessionCount: number): string {
  return `# ${gathering.name} — transcript corpus

Exported from unconference.events (gathering \`${gathering.slug}\`) on ${new Date().toISOString()}.
${sessionCount} sessions with a transcript, ${chunkCount} chunks. **Members-only material: do not publish.**
Transcripts were attached by hosts and organizers who confirmed that everyone in the room was told
the session was being recorded or transcribed.

## Files

- \`corpus.jsonl\` — one JSON object per line, one chunk each (see schema below)
- \`sessions.json\` — the gathering and its sessions with transcript metadata and any summary
- \`transcripts/*.md\` — the normalized transcript of each session, with \`[mm:ss]\` markers when the
  source was a caption file

## corpus.jsonl schema (version ${CORPUS_SCHEMA_VERSION})

| field | type | meaning |
| --- | --- | --- |
| id | string | stable chunk id |
| session_id | string | the session the chunk belongs to |
| title | string | session title |
| hosts | string[] | host and co-host display names (may be empty) |
| track | string or null | track name |
| day | string or null | ISO date of the scheduled day |
| start | string or null | ISO timestamp of the scheduled start |
| venue | string or null | venue name |
| chunk_index | number | position of the chunk in its transcript, from 0 |
| text | string | the chunk text |
| tags | string[] | topic tags of the session |
| marker | string or null | the first \`mm:ss\` moment in the chunk |

Chunking: about ${CHUNK_TARGET_CHARS} characters (~800 tokens) on paragraph boundaries with
${Math.round(CHUNK_OVERLAP_RATIO * 100)}% overlap between consecutive chunks.

## Suggested embedding recipe

\`\`\`python
import json
lines = [json.loads(l) for l in open("corpus.jsonl")]
texts = [f"{l['title']}\\n\\n{l['text']}" for l in lines]
# Any embedding model works; keep the model name with the vectors so queries use the same one.
# e.g. voyage-3 / text-embedding-3-small, batches of 32, cosine similarity, top 8 chunks per question.
# Cite answers as "[title · marker]" so readers can find the moment in the transcript.
\`\`\`
`
}

function transcriptMarkdown(s: SessionRow): string {
  const meta = [
    `# ${s.title}`,
    '',
    s.hosts.length ? `- Hosts: ${s.hosts.join(', ')}` : null,
    s.track ? `- Track: ${s.track}` : null,
    s.start ? `- When: ${s.start}` : null,
    s.venue ? `- Where: ${s.venue}` : null,
    s.language ? `- Language: ${s.language}` : null,
    `- Source format: ${s.transcript_format}`,
    '',
    s.summary ? `## Summary\n\n${s.summary}\n` : null,
    '## Transcript',
    '',
    s.content,
    '',
  ].filter((l): l is string => l !== null)
  return meta.join('\n')
}

interface GatheringRow {
  name: string
  slug: string
  timezone: string
  start_date: string
  end_date: string
}

/** The corpus itself: the gathering, its transcribed sessions and one line per chunk. */
export interface CorpusRows {
  gathering: GatheringRow
  sessions: SessionRow[]
  lines: CorpusLine[]
}

/**
 * Read the corpus. Shared by the zip export and the MCP `export_corpus` tool, so both serve
 * exactly the same rows under exactly the same rules (hosts by display name only, ready and
 * un-replaced transcripts only). Organizer-gated by every caller.
 */
export async function buildCorpusRows(eventId: string): Promise<CorpusRows> {
  const [gathering] = await sql<GatheringRow[]>`
    select name, slug, timezone, start_date, end_date from events where id = ${eventId}
  `
  if (!gathering) throw new Error('gathering not found')
  const sessions = await sql<SessionRow[]>`
    select s.id, s.title, s.description, s.format, s.duration, s.topic_tags,
           (select coalesce(array_agg(name order by ord), '{}'::text[]) from (
              select p.display_name as name, 0 as ord from profiles p where p.id = s.host_id and p.display_name is not null
              union all
              select cp.display_name, 1 + coalesce(c.display_order, 0) from session_cohosts c
                join profiles cp on cp.id = c.user_id
                where c.session_id = s.id and c.cohost_inactive_at is null and cp.display_name is not null
           ) names) as hosts,
           tr.name as track, ts.day_date::text as day, ts.start_time as start, ts.end_time as "end", v.name as venue,
           t.id as transcript_id, t.format as transcript_format, t.language, t.char_count, t.summary, t.content
    from session_transcripts t
    join sessions s on s.id = t.session_id
    left join tracks tr on tr.id = s.track_id
    left join time_slots ts on ts.id = s.time_slot_id
    left join venues v on v.id = s.venue_id
    where t.event_id = ${eventId} and t.replaced_at is null and t.status = 'ready'
    order by ts.start_time asc nulls last, s.title asc
  `
  const chunks = sessions.length
    ? await sql<ChunkRow[]>`
        select c.id, c.session_id, c.chunk_index, c.text from transcript_chunks c
        where c.transcript_id in ${sql(sessions.map((s) => s.transcript_id))}
        order by c.session_id, c.chunk_index
      `
    : []
  const bySession = new Map(sessions.map((s) => [s.id, s]))
  const lines = chunks
    .map((c): CorpusLine | null => {
      const s = bySession.get(c.session_id)
      if (!s) return null
      return {
        id: c.id,
        session_id: c.session_id,
        title: s.title,
        hosts: s.hosts,
        track: s.track,
        day: s.day,
        start: s.start,
        venue: s.venue,
        chunk_index: c.chunk_index,
        text: c.text,
        tags: s.topic_tags ?? [],
        marker: markerLabel(firstMarker(c.text)),
      }
    })
    .filter((l): l is CorpusLine => l !== null)
  return { gathering, sessions, lines }
}

export async function buildCorpusExport(eventId: string): Promise<CorpusExport> {
  const { gathering, sessions, lines } = await buildCorpusRows(eventId)

  const sessionsJson = {
    schema_version: CORPUS_SCHEMA_VERSION,
    exported_at: new Date().toISOString(),
    gathering: { name: gathering.name, slug: gathering.slug, timezone: gathering.timezone, start_date: gathering.start_date, end_date: gathering.end_date },
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      format: s.format,
      duration: s.duration,
      hosts: s.hosts,
      track: s.track,
      day: s.day,
      start: s.start,
      end: s.end,
      venue: s.venue,
      tags: s.topic_tags ?? [],
      transcript: {
        id: s.transcript_id,
        format: s.transcript_format,
        language: s.language,
        char_count: s.char_count,
        chunks: lines.filter((l) => l.session_id === s.id).length,
        summary: s.summary,
        file: `transcripts/${slugify(s.title)}-${s.id.slice(0, 8)}.md`,
      },
    })),
  }

  const files: Record<string, Uint8Array> = {
    'README.md': strToU8(readme(gathering, lines.length, sessions.length)),
    'corpus.jsonl': strToU8(lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')),
    'sessions.json': strToU8(JSON.stringify(sessionsJson, null, 2)),
  }
  for (const s of sessions) files[`transcripts/${slugify(s.title)}-${s.id.slice(0, 8)}.md`] = strToU8(transcriptMarkdown(s))
  const zip = zipSync(files, { level: 6 })
  return { zip, sessionCount: sessions.length, chunkCount: lines.length }
}

/**
 * Log that the corpus left the server (a plain server log line plus a `knowledge_exports` row).
 * `via` distinguishes the zip download from a page handed to a member's own AI assistant over MCP.
 */
export async function logCorpusAccess(
  eventId: string,
  accountId: string,
  stats: { sessionCount: number; chunkCount: number; bytes: number },
  via: 'download' | 'mcp' = 'download',
): Promise<void> {
  console.info(`[knowledge:export] gathering ${eventId} exported by ${accountId} (${via}): ${stats.sessionCount} sessions, ${stats.chunkCount} chunks, ${stats.bytes} bytes`)
  await sql`
    insert into knowledge_exports (event_id, exported_by, session_count, chunk_count, bytes)
    values (${eventId}, ${accountId}, ${stats.sessionCount}, ${stats.chunkCount}, ${stats.bytes})
  `
}

/** Log a zip download. */
export async function logExport(eventId: string, accountId: string, result: CorpusExport): Promise<void> {
  await logCorpusAccess(eventId, accountId, { sessionCount: result.sessionCount, chunkCount: result.chunkCount, bytes: result.zip.byteLength }, 'download')
}
