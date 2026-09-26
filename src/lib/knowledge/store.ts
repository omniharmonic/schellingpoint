import 'server-only'
/**
 * Transcript storage and reading tiers (design §10.1). Transcripts are never records and never
 * public: the app serves them to members of the gathering, or to organizers only, per the
 * gathering's `transcripts_visibility` and the transcript's own `visibility`. The normalized text
 * lives in the row (`content`) so it is deleted with the session or the gathering.
 */
import { sql, tx, type Sql } from '@/lib/db'
import type { EventRoleName } from '@/types/event'
import { chunkParagraphs } from './chunk'
import type { NormalizedTranscript, TranscriptFormat } from './normalize'
import { embeddingsConfig, localModelState, type EmbeddingsConfig } from './embeddings'
import { resolveChatConfig, type ChatConfig } from './chat-provider'
import { enqueueKnowledgeJob } from './jobs'

export const ORGANIZER_ROLES: readonly EventRoleName[] = ['owner', 'admin', 'moderator']
export type TranscriptVisibility = 'members' | 'organizers'
export type ReadTier = 'organizers' | 'members'

export interface TranscriptRow {
  id: string
  event_id: string
  session_id: string
  uploaded_by: string | null
  source: 'upload' | 'paste'
  format: TranscriptFormat
  char_count: number
  language: string | null
  consent_confirmed_at: string
  visibility: TranscriptVisibility
  status: 'ready' | 'processing' | 'failed'
  summary: string | null
  summary_generated_at: string | null
  /** Set when an organizer edited the generated summary (design §10.3); null = as generated. */
  summary_edited_at: string | null
  replaced_at: string | null
  created_at: string
}

export interface TranscriptWithContent extends TranscriptRow {
  content: string
}

// Built on demand: `sql` opens the pool the moment it is used, and importing this module must not
// (`next build` evaluates every route's module graph without DATABASE_URL).
const rowColumns = () => sql`
  id, event_id, session_id, uploaded_by, source, format, char_count, language, consent_confirmed_at,
  visibility, status, summary, summary_generated_at, summary_edited_at, replaced_at, created_at
`

/** The tier a role reads at: organizers see everything, other members the members tier. */
export function readTier(role: EventRoleName | null | undefined): ReadTier | null {
  if (!role) return null
  return ORGANIZER_ROLES.includes(role) ? 'organizers' : 'members'
}

export function canReadTranscript(tier: ReadTier | null, eventVisibility: string, transcriptVisibility: string): boolean {
  if (tier === 'organizers') return true
  if (tier === 'members') return eventVisibility === 'members' && transcriptVisibility === 'members'
  return false
}

export async function currentTranscript(db: Sql, sessionId: string): Promise<TranscriptWithContent | null> {
  const [row] = await db<TranscriptWithContent[]>`
    select ${rowColumns()}, content from session_transcripts
    where session_id = ${sessionId} and replaced_at is null
  `
  return row ?? null
}

export interface SaveTranscriptInput {
  eventId: string
  sessionId: string
  uploadedBy: string
  source: 'upload' | 'paste'
  language: string | null
  visibility: TranscriptVisibility
  normalized: NormalizedTranscript
}

/**
 * Store a transcript as the session's current one: the previous transcript is marked replaced
 * (purged after 30 days by the job runner), chunks are written, and an embed job is queued when
 * a provider is configured. One transaction.
 */
export async function saveTranscript(input: SaveTranscriptInput): Promise<{ transcript: TranscriptRow; chunks: number; embedQueued: boolean }> {
  const chunks = chunkParagraphs(input.normalized.paragraphs)
  const embed = embeddingsConfig() !== null
  return tx(async (t) => {
    await t`update session_transcripts set replaced_at = now() where session_id = ${input.sessionId} and replaced_at is null`
    const [transcript] = await t<TranscriptRow[]>`
      insert into session_transcripts (event_id, session_id, uploaded_by, source, format, content, char_count, language, consent_confirmed_at, visibility, status)
      values (${input.eventId}, ${input.sessionId}, ${input.uploadedBy}, ${input.source}, ${input.normalized.format},
              ${input.normalized.text}, ${input.normalized.charCount}, ${input.language}, now(), ${input.visibility}, 'ready')
      returning ${rowColumns()}
    `
    if (chunks.length) {
      const rows = chunks.map((c) => ({
        transcript_id: transcript.id,
        session_id: input.sessionId,
        event_id: input.eventId,
        chunk_index: c.index,
        text: c.text,
      }))
      await t`insert into transcript_chunks ${t(rows, 'transcript_id', 'session_id', 'event_id', 'chunk_index', 'text')}`
    }
    let embedQueued = false
    if (embed && chunks.length) embedQueued = (await enqueueKnowledgeJob(t, input.eventId, 'embed', input.uploadedBy)).created
    return { transcript, chunks: chunks.length, embedQueued }
  })
}

/** Remove the session's current transcript (chunks cascade). True when one existed. */
export async function deleteCurrentTranscript(sessionId: string): Promise<boolean> {
  const rows = await sql`delete from session_transcripts where session_id = ${sessionId} and replaced_at is null returning id`
  return rows.length > 0
}

export async function updateSummary(transcriptId: string, summary: string | null): Promise<void> {
  await sql`update session_transcripts set summary = ${summary}, summary_generated_at = ${summary ? sql`now()` : null} where id = ${transcriptId}`
}

/** Longest summary an organizer may save (a generated one is a few hundred words). */
export const MAX_SUMMARY_CHARS = 8_000

/**
 * An organizer's edit of the current summary (design §10.3). The generated text is replaced in
 * place — members read one summary, the edited one — and who edited it, and when, is kept.
 * Empty text clears the summary (the next summaries run writes a fresh one).
 */
export async function editSummary(input: { sessionId: string; summary: string | null; editedBy: string }): Promise<TranscriptRow | null> {
  const summary = input.summary?.trim() ? input.summary.trim().slice(0, MAX_SUMMARY_CHARS) : null
  const rows = await sql<TranscriptRow[]>`
    update session_transcripts set
      summary = ${summary},
      summary_edited_at = ${summary ? sql`now()` : null},
      summary_edited_by = ${summary ? input.editedBy : null}
    where session_id = ${input.sessionId} and replaced_at is null
    returning ${rowColumns()}
  `
  return rows[0] ?? null
}

/**
 * Are transcripts turned on for this gathering? The workspace sidebar shows "Ask" whenever they
 * are (design 2026-09-25 §2.2): the page itself explains what is still missing — no transcripts
 * yet, no answer key — rather than the navigation item disappearing and taking the explanation
 * with it.
 */
export async function transcriptsEnabled(eventId: string): Promise<boolean> {
  const [event] = await sql<{ transcripts_enabled: boolean }[]>`select transcripts_enabled from events where id = ${eventId}`
  return event?.transcripts_enabled ?? false
}

/**
 * Is there at least one ready transcript THIS VIEWER may read? One indexed count, per tier: a
 * member counts members-tier transcripts, an organizer all of them, a non-member none. Used for
 * "is there anything to answer from", not for the navigation.
 */
export async function hasReadableTranscripts(eventId: string, role: EventRoleName | null | undefined): Promise<boolean> {
  const tier = readTier(role)
  if (!tier) return false
  const [event] = await sql<{ transcripts_enabled: boolean; transcripts_visibility: TranscriptVisibility }[]>`
    select transcripts_enabled, transcripts_visibility from events where id = ${eventId}
  `
  if (!event?.transcripts_enabled) return false
  if (tier === 'members' && event.transcripts_visibility !== 'members') return false
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from session_transcripts
    where event_id = ${eventId} and replaced_at is null and status = 'ready'
      ${tier === 'members' ? sql`and visibility = 'members'` : sql``}
  `
  return (row?.n ?? 0) > 0
}

export async function readyTranscriptCount(eventId: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*) as count from session_transcripts where event_id = ${eventId} and replaced_at is null and status = 'ready'
  `
  return row?.count ?? 0
}

/** Which parts of the pipeline are configured. Never the keys. */
export interface ProviderStatus {
  embeddings:
    | { configured: true; provider: string; model: string; label: string; local: boolean; error: string | null }
    | { configured: false }
  chat:
    | { configured: true; model: string; provider: ChatConfig['provider']; source: ChatConfig['source'] }
    | { configured: false }
}

/** What the operator reads on the Knowledge page: `local (bge-small-en-v1.5)`, `voyage · voyage-3`. */
export function embeddingsLabel(cfg: EmbeddingsConfig): string {
  return cfg.provider === 'local' ? `local (${cfg.model.split('/').pop()})` : `${cfg.provider} · ${cfg.model}`
}

/**
 * `eventId` resolves the answer key the way answers do — the gathering's own first, the
 * deployment's second (design 2026-09-25 §2.1) — so the Knowledge page says which one is in use.
 */
export async function providerStatus(eventId: string): Promise<ProviderStatus> {
  const e = embeddingsConfig()
  const c = await resolveChatConfig(eventId)
  return {
    embeddings: e
      ? {
          configured: true,
          provider: e.provider,
          model: e.model,
          label: embeddingsLabel(e),
          local: e.provider === 'local',
          // A model that failed to load shows up here rather than taking the page down.
          error: e.provider === 'local' ? localModelState().error : null,
        }
      : { configured: false },
    chat: c ? { configured: true, model: c.model, provider: c.provider, source: c.source } : { configured: false },
  }
}

export interface CoverageSession {
  id: string
  title: string
  status: string
  host_id: string | null
  host_name: string | null
  track: string | null
  starts_at: string | null
  transcript: { id: string; format: string; char_count: number; word_count: number; created_at: string; has_summary: boolean; summary_edited: boolean; visibility: string } | null
}

export interface CoverageJob {
  id: string
  kind: 'embed' | 'summaries'
  status: string
  processed: number
  last_error: string | null
  updated_at: string
}

export interface Coverage {
  enabled: boolean
  visibility: TranscriptVisibility
  sessions: CoverageSession[]
  totals: { sessions: number; with_transcript: number; without_transcript: number; words: number; chunks: number; embedded: number }
  jobs: CoverageJob[]
  themes: unknown
  /** When an organizer last edited the themes (design §10.3); null = exactly as generated. */
  themes_edited_at: string | null
  providers: ProviderStatus
}

/** Organizer view: every approved / scheduled session, with or without a transcript. */
export async function coverage(eventId: string): Promise<Coverage> {
  const embeddingModel = embeddingsConfig()?.storedModel ?? null
  const [event] = await sql<{ transcripts_enabled: boolean; transcripts_visibility: TranscriptVisibility; themes: unknown; themes_edited_at: string | null }[]>`
    select transcripts_enabled, transcripts_visibility, themes, themes_edited_at from events where id = ${eventId}
  `
  type Row = Omit<CoverageSession, 'transcript'> & {
    transcript_id: string | null
    format: string | null
    char_count: number | null
    word_count: number | null
    transcript_created_at: string | null
    has_summary: boolean | null
    summary_edited: boolean | null
    visibility: string | null
  }
  const rows = await sql<Row[]>`
    select s.id, s.title, s.status, s.host_id, p.display_name as host_name, tr.name as track, ts.start_time as starts_at,
           t.id as transcript_id, t.format, t.char_count,
           case when t.id is null then null else array_length(regexp_split_to_array(btrim(t.content), '\\s+'), 1) end as word_count,
           t.created_at as transcript_created_at, (t.summary is not null) as has_summary,
           (t.summary_edited_at is not null) as summary_edited, t.visibility
    from sessions s
    left join profiles p on p.id = s.host_id
    left join tracks tr on tr.id = s.track_id
    left join time_slots ts on ts.id = s.time_slot_id
    left join session_transcripts t on t.session_id = s.id and t.replaced_at is null
    where s.event_id = ${eventId} and s.status in ('approved', 'scheduled')
    order by ts.start_time asc nulls last, s.title asc
  `
  const sessions: CoverageSession[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    host_id: r.host_id,
    host_name: r.host_name,
    track: r.track,
    starts_at: r.starts_at,
    transcript: r.transcript_id
      ? {
          id: r.transcript_id,
          format: r.format ?? 'txt',
          char_count: r.char_count ?? 0,
          word_count: r.word_count ?? 0,
          created_at: r.transcript_created_at ?? '',
          has_summary: !!r.has_summary,
          summary_edited: !!r.summary_edited,
          visibility: r.visibility ?? 'members',
        }
      : null,
  }))
  const [chunkStats] = await sql<{ chunks: number; embedded: number }[]>`
    select count(*) as chunks,
           count(*) filter (where c.embedding is not null and c.embedding_model = ${embeddingModel}) as embedded
    from transcript_chunks c
    join session_transcripts t on t.id = c.transcript_id and t.replaced_at is null
    where c.event_id = ${eventId}
  `
  const jobs = await sql<CoverageJob[]>`
    select distinct on (kind) id, kind, status, processed, last_error, updated_at
    from knowledge_jobs where event_id = ${eventId}
    order by kind, created_at desc
  `
  const withTranscript = sessions.filter((s) => s.transcript).length
  return {
    enabled: event?.transcripts_enabled ?? true,
    visibility: event?.transcripts_visibility ?? 'members',
    sessions,
    totals: {
      sessions: sessions.length,
      with_transcript: withTranscript,
      without_transcript: sessions.length - withTranscript,
      words: sessions.reduce((n, s) => n + (s.transcript?.word_count ?? 0), 0),
      chunks: chunkStats?.chunks ?? 0,
      embedded: chunkStats?.embedded ?? 0,
    },
    jobs,
    themes: event?.themes ?? null,
    themes_edited_at: event?.themes_edited_at ?? null,
    providers: await providerStatus(eventId),
  }
}
