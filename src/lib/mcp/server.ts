import 'server-only'
/**
 * The MCP server a member connects their own AI assistant to (`POST /api/mcp`).
 *
 * Everything here is READ-ONLY and scoped to the account behind the presented token:
 *
 *   - only gatherings the account is an appointed member of (`gatheringFor`);
 *   - sessions through the browser's own read model (`src/app/api/v1/sessions/_lib/read.ts`), so
 *     pending proposals, organizer extras and attendee tiers behave exactly as on the website;
 *   - transcripts only through `canReadTranscript` — the gathering's tier and the transcript's own;
 *   - the corpus export only for organizers.
 *
 * What never leaves, whatever the account's role (plan §3, spec §10 and the R9 filter):
 *   - anybody else's DID, email, messaging handle or account id;
 *   - exact addresses or private-home pins (a self-hosted session is its coarse public place);
 *   - vote counts, ballots, or anything from a round that has not closed;
 *   - attendee-only logistics (the Telegram group link, the exact location) — the assistant is
 *     told they exist and points the member at the session page, which asks for the real check.
 *
 * We do retrieval and the query embedding; the member's assistant does the inference. No chat
 * model is called from here.
 */
import { z } from 'zod'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { sql } from '@/lib/db'
import { publicUrl } from '@/lib/atproto/config'
import { getSession, listSessions, type SessionView } from '@/app/api/v1/sessions/_lib/read'
import { isUuid } from '@/app/api/v1/sessions/_lib/access'
import { canReadTranscript, currentTranscript } from '@/lib/knowledge/store'
import { embeddingsConfig, embedTexts } from '@/lib/knowledge/embeddings'
import { rankEventChunks, minScore } from '@/lib/knowledge/rank'
import { markerLabel } from '@/lib/knowledge/normalize'
import { buildCorpusRows, logCorpusAccess } from '@/lib/knowledge/export'
import { gatheringFor, myGatherings, type GatheringContext } from './access'
import type { AssistantPrincipal } from './tokens'

export const MCP_SERVER_NAME = 'unconference'

/** One page of a transcript. Big enough to be useful, small enough not to blow a context window. */
export const TRANSCRIPT_PAGE_CHARS = 12_000
/** One page of `corpus.jsonl`. */
export const CORPUS_PAGE_LINES = 100
export const CORPUS_PAGE_CHARS = 200_000

/* ─────────────────────────────── result helpers ─────────────────────────────── */

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function data(value: unknown): CallToolResult {
  return text(JSON.stringify(value, null, 2))
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

const NO_GATHERING = (slug: string) =>
  `No gathering “${slug}” that you are a member of. Call list_my_gatherings to see the ones you can read.`

/* ─────────────────────────────── formatting ─────────────────────────────── */

function dayKey(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
  } catch {
    return iso.slice(0, 10)
  }
}

function clock(iso: string | null, timeZone: string): string | null {
  if (!iso) return null
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
  } catch {
    return iso.slice(11, 16)
  }
}

function startOf(s: SessionView): string | null {
  return s.time_slot?.start_time ?? s.self_hosted_start_time ?? null
}

function endOf(s: SessionView): string | null {
  return s.time_slot?.end_time ?? s.self_hosted_end_time ?? null
}

/** A person as the assistant may see them: the name they chose, and their public handle. */
function people(s: SessionView): { display_name: string | null; handle: string | null }[] {
  const out = s.host ? [{ display_name: s.host.display_name, handle: s.host.handle }] : []
  for (const c of s.cohosts) out.push({ display_name: c.display_name, handle: c.handle })
  return out
}

/**
 * Where a session happens, in the coarsest form that is still useful: a named room for a venue
 * session, the host's own public place label for a self-hosted one. Never a street address, never
 * a private home's pin — those are attendee-only and stay behind the session page.
 */
function room(s: SessionView): string | null {
  if (s.venue?.name) return s.venue.name
  if (s.is_self_hosted) return s.public_place ?? null
  return null
}

function sessionLink(slug: string, id: string): string {
  return `${publicUrl()}/e/${slug}/sessions/${id}`
}

function listed(s: SessionView, slug: string, timeZone: string) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    format: s.format,
    duration_minutes: s.duration,
    tags: s.topic_tags,
    track: s.track?.name ?? null,
    day: startOf(s) ? dayKey(startOf(s)!, timeZone) : null,
    start: clock(startOf(s), timeZone),
    end: clock(endOf(s), timeZone),
    room: room(s),
    hosts: people(s),
    unclaimed: s.unclaimed,
    description: s.description,
    link: sessionLink(slug, s.id),
  }
}

/* ─────────────────────────────── the server ─────────────────────────────── */

/**
 * Build a fresh server for one request (the transport is stateless: nothing is shared between
 * requests, so a token can never reach another token's context).
 */
export function buildMcpServer(principal: AssistantPrincipal): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: '1.0.0', title: 'unconference.events' },
    {
      instructions:
        'Read-only access to the unconference gatherings this person belongs to: schedules, sessions, ' +
        'and the session transcripts they are allowed to read. Start with list_my_gatherings to get a ' +
        'slug, then use the other tools with it. Nothing here can be changed, and nothing here is ' +
        'public — treat what you read as material shared inside a gathering.',
    },
  )

  const openGathering = async (slug: string): Promise<GatheringContext | null> => gatheringFor(principal.accountId, slug)

  /* ── gatherings ── */
  server.registerTool(
    'list_my_gatherings',
    {
      title: 'List my gatherings',
      description:
        'The gatherings this person is a member of, with the slug the other tools take and the role ' +
        'they hold in each (owner, admin, moderator, track_lead, volunteer or attendee). Gatherings ' +
        'they have not joined are not listed, even public ones.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const rows = await myGatherings(principal.accountId)
      if (!rows.length) {
        return text('You are not a member of any gathering yet. Join or create one at ' + publicUrl() + ' first.')
      }
      return data(
        rows.map((g) => ({
          slug: g.slug,
          name: g.name,
          role: g.role,
          status: g.status,
          starts: g.start_date,
          ends: g.end_date,
          timezone: g.timezone,
          link: `${publicUrl()}/e/${g.slug}`,
        })),
      )
    },
  )

  /* ── schedule ── */
  server.registerTool(
    'get_schedule',
    {
      title: 'Get a gathering’s schedule',
      description:
        'The sessions of one gathering that have a time, grouped by day in the gathering’s own time ' +
        'zone: start and end, the room (for a session someone hosts at their own place, only the ' +
        'coarse public place they chose — never an address), and the hosts by display name and handle. ' +
        'Pass `day` as YYYY-MM-DD to get one day.',
      inputSchema: {
        slug: z.string().min(1).describe('The gathering slug, from list_my_gatherings.'),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('One day, YYYY-MM-DD in the gathering’s time zone.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, day }) => {
      const ctx = await openGathering(slug)
      if (!ctx) return fail(NO_GATHERING(slug))
      const tz = ctx.access.event.timezone || 'UTC'
      const sessions = await listSessions(ctx.access, {
        statuses: ['approved', 'scheduled'],
        timed: true,
        sort: 'time',
        day: day ?? null,
      })
      if (!sessions.length) {
        return text(day ? `Nothing is scheduled on ${day} in “${ctx.access.event.name}”.` : `“${ctx.access.event.name}” has no scheduled sessions yet.`)
      }
      const days = new Map<string, ReturnType<typeof listed>[]>()
      for (const s of sessions) {
        const key = s.time_slot?.day_date ?? dayKey(startOf(s)!, tz)
        const list = days.get(key) ?? []
        list.push(listed(s, slug, tz))
        days.set(key, list)
      }
      return data({
        gathering: { slug, name: ctx.access.event.name, timezone: tz },
        days: [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, list]) => ({ day: d, sessions: list })),
      })
    },
  )

  /* ── sessions ── */
  server.registerTool(
    'list_sessions',
    {
      title: 'List sessions',
      description:
        'Sessions of one gathering, scheduled or not: title, description, format, tags and hosts. ' +
        '`status` narrows to pending, approved, rejected or scheduled (default: approved and scheduled; ' +
        'pending and rejected proposals are only visible to their own host and to organizers). ' +
        '`query` is a plain substring match on title, description, tags and host name.',
      inputSchema: {
        slug: z.string().min(1),
        status: z.enum(['pending', 'approved', 'rejected', 'scheduled', 'all']).optional(),
        query: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, status, query }) => {
      const ctx = await openGathering(slug)
      if (!ctx) return fail(NO_GATHERING(slug))
      const tz = ctx.access.event.timezone || 'UTC'
      const sessions = await listSessions(ctx.access, {
        statuses: status === 'all' ? 'all' : status ? [status] : undefined,
        search: query ?? null,
        sort: 'title',
      })
      if (!sessions.length) return text(`No sessions in “${ctx.access.event.name}” match that.`)
      return data({ gathering: { slug, name: ctx.access.event.name }, count: sessions.length, sessions: sessions.map((s) => listed(s, slug, tz)) })
    },
  )

  server.registerTool(
    'get_session',
    {
      title: 'Get one session',
      description:
        'One session in full, and whether a transcript of it is available to this person. Attendee-only ' +
        'logistics (a private group link, the exact place a self-hosted session happens) are not returned ' +
        'here — the session page asks for those. Returns not-found for a session that belongs to another ' +
        'gathering, or that this person may not see.',
      inputSchema: {
        slug: z.string().min(1),
        session_id: z.string().min(1).describe('The session id, from get_schedule or list_sessions.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, session_id }) => {
      const ctx = await openGathering(slug)
      if (!ctx) return fail(NO_GATHERING(slug))
      if (!isUuid(session_id)) return fail(`No session ${session_id} in “${ctx.access.event.name}”.`)
      const session = await getSession(ctx.access, session_id)
      if (!session) return fail(`No session ${session_id} in “${ctx.access.event.name}”.`)
      const tz = ctx.access.event.timezone || 'UTC'
      const transcript = await currentTranscript(sql, session_id)
      const readable = transcript ? canReadTranscript(ctx.tier, ctx.transcriptsVisibility, transcript.visibility) : false
      return data({
        ...listed(session, slug, tz),
        skills: session.skills,
        expected_attendance: session.expected_attendance,
        rsvps: { confirmed: session.rsvp_count, waitlist: session.waitlist_count },
        my_rsvp: session.my_rsvp?.status ?? null,
        is_self_hosted: session.is_self_hosted,
        has_private_group: session.has_telegram_group,
        has_exact_location: session.has_private_location,
        transcript: transcript
          ? {
              available: readable,
              reason: readable ? null : 'This transcript is for organizers of this gathering only.',
              characters: readable ? transcript.char_count : null,
              language: readable ? transcript.language : null,
              summary: readable ? transcript.summary : null,
            }
          : { available: false, reason: 'No transcript has been attached to this session.' },
      })
    },
  )

  /* ── knowledge ── */
  server.registerTool(
    'search_knowledge',
    {
      title: 'Search a gathering’s transcripts',
      description:
        'Semantic search over the transcripts of one gathering that this person is allowed to read. ' +
        'Returns ranked excerpts with the session title, the [mm:ss] moment when the source had ' +
        'timings, and a link. It does not answer the question — read the excerpts and answer from them, ' +
        'citing the session and moment. Says so plainly when the server has no embeddings provider ' +
        'configured, or when nothing is close enough.',
      inputSchema: {
        slug: z.string().min(1),
        query: z.string().min(3).max(1000).describe('What to look for, in the words you would use to ask about it.'),
        k: z.number().int().min(1).max(20).optional().describe('How many excerpts to return (default 8).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, query, k }) => {
      const ctx = await openGathering(slug)
      if (!ctx) return fail(NO_GATHERING(slug))
      const config = embeddingsConfig()
      if (!config) {
        return text(
          'This server has embeddings switched off (EMBEDDINGS_PROVIDER=none), so transcript search is not ' +
            'available here. The operator can turn it back on — the default provider runs on the box itself; ' +
            'meanwhile use list_sessions with a `query` to search session titles, descriptions and tags, or ' +
            'get_transcript to read a transcript in full.',
        )
      }
      let vector: number[] | undefined
      try {
        ;[vector] = await embedTexts([query], 'query', config)
      } catch (e) {
        console.error('[mcp] embedding the query failed:', e instanceof Error ? e.message : e)
        return fail('The embeddings provider did not answer. Try again in a moment.')
      }
      if (!vector) return fail('The embeddings provider returned nothing for that query.')
      const ranked = await rankEventChunks(ctx.access.event.id, vector, { model: config.storedModel, tier: ctx.tier, limit: k ?? 8 })
      if (!ranked.length) {
        return text(
          `Nothing in the transcripts of “${ctx.access.event.name}” that you may read scores above the ` +
            `relevance threshold (${minScore()}) for that query. Either those conversations were not ` +
            'transcribed, or they have not been embedded yet. Try naming a session, a person or a phrase you remember.',
        )
      }
      return data({
        gathering: { slug, name: ctx.access.event.name },
        query,
        results: ranked.map((chunk) => ({
          session_id: chunk.session_id,
          session_title: chunk.session_title,
          marker: markerLabel(chunk.marker),
          score: Math.round(chunk.score * 1000) / 1000,
          excerpt: chunk.text,
          link: `${sessionLink(slug, chunk.session_id)}#transcript`,
        })),
      })
    },
  )

  server.registerTool(
    'get_transcript',
    {
      title: 'Read a session transcript',
      description:
        'The full normalized transcript of one session, in pages. Only transcripts this person may ' +
        'read: a gathering (or a single transcript) can be set to organizers only, and then a member ' +
        'gets a refusal rather than the text. Pass the `next_offset` from the previous page to continue.',
      inputSchema: {
        slug: z.string().min(1),
        session_id: z.string().min(1),
        offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, session_id, offset }) => {
      const ctx = await openGathering(slug)
      if (!ctx) return fail(NO_GATHERING(slug))
      if (!isUuid(session_id)) return fail(`No session ${session_id} in “${ctx.access.event.name}”.`)
      const session = await getSession(ctx.access, session_id)
      if (!session) return fail(`No session ${session_id} in “${ctx.access.event.name}”.`)
      const transcript = await currentTranscript(sql, session_id)
      if (!transcript) return text(`“${session.title}” has no transcript.`)
      if (!canReadTranscript(ctx.tier, ctx.transcriptsVisibility, transcript.visibility)) {
        return fail(
          `The transcript of “${session.title}” is for organizers of “${ctx.access.event.name}” only. ` +
            'Ask an organizer if you need it.',
        )
      }
      const start = Math.min(offset ?? 0, transcript.content.length)
      const slice = transcript.content.slice(start, start + TRANSCRIPT_PAGE_CHARS)
      const next = start + slice.length
      const header = [
        `# ${session.title}`,
        transcript.summary ? `\n## Summary\n\n${transcript.summary}` : null,
        `\n## Transcript (characters ${start}–${next} of ${transcript.content.length})`,
        '',
      ]
        .filter((l): l is string => l !== null)
        .join('\n')
      const footer =
        next < transcript.content.length
          ? `\n\n[…continues. Call get_transcript again with offset=${next} for the next page.]`
          : ''
      return text(`${start === 0 ? header : `# ${session.title} (characters ${start}–${next} of ${transcript.content.length})\n\n`}${slice}${footer}`)
    },
  )

  server.registerTool(
    'export_corpus',
    {
      title: 'Export a gathering’s corpus (organizers)',
      description:
        'The gathering’s transcript corpus as corpus.jsonl — one JSON object per line, one chunk each ' +
        `(id, session_id, title, hosts, track, day, start, venue, chunk_index, text, tags, marker). ` +
        `Organizers only, and returned in pages of at most ${CORPUS_PAGE_LINES} lines; pass the ` +
        '`next_offset` to continue. This is members-only material: do not publish it. Every page is logged.',
      inputSchema: {
        slug: z.string().min(1),
        offset: z.number().int().min(0).optional().describe('Line offset to start from (default 0).'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ slug, offset }) => {
      const ctx = await openGathering(slug)
      if (!ctx) return fail(NO_GATHERING(slug))
      if (!ctx.isOrganizer) {
        return fail(`The corpus export of “${ctx.access.event.name}” is for its organizers. You are ${ctx.role} there.`)
      }
      const { sessions, lines } = await buildCorpusRows(ctx.access.event.id)
      if (!lines.length) return text(`“${ctx.access.event.name}” has no transcripts to export yet.`)
      const start = Math.min(offset ?? 0, lines.length)
      const page: string[] = []
      let bytes = 0
      let at = start
      while (at < lines.length && page.length < CORPUS_PAGE_LINES && bytes < CORPUS_PAGE_CHARS) {
        const line = JSON.stringify(lines[at])
        page.push(line)
        bytes += line.length + 1
        at += 1
      }
      await logCorpusAccess(ctx.access.event.id, principal.accountId, { sessionCount: sessions.length, chunkCount: page.length, bytes }, 'mcp')
      const footer = at < lines.length ? `\n\n[lines ${start}–${at} of ${lines.length}. Call export_corpus again with offset=${at}.]` : `\n\n[lines ${start}–${at} of ${lines.length}. That is the whole corpus.]`
      return text(page.join('\n') + footer)
    },
  )

  /* ── resource: a gathering's schedule, so a client can attach it as context ── */
  server.registerResource(
    'gathering-schedule',
    new ResourceTemplate('unconference://gatherings/{slug}/schedule', {
      list: async () => {
        const rows = await myGatherings(principal.accountId)
        return {
          resources: rows.map((g) => ({
            uri: `unconference://gatherings/${g.slug}/schedule`,
            name: `${g.name} — schedule`,
            description: `Sessions of ${g.name} that have a time, ${g.start_date} to ${g.end_date}.`,
            mimeType: 'application/json',
          })),
        }
      },
    }),
    {
      title: 'Gathering schedule',
      description: 'The scheduled sessions of one gathering you belong to, as JSON.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      const slug = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug
      const ctx = slug ? await openGathering(String(slug)) : null
      if (!ctx) throw new Error(NO_GATHERING(String(slug ?? '')))
      const tz = ctx.access.event.timezone || 'UTC'
      const sessions = await listSessions(ctx.access, { statuses: ['approved', 'scheduled'], timed: true, sort: 'time' })
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(
              {
                gathering: { slug: ctx.access.event.slug, name: ctx.access.event.name, timezone: tz },
                sessions: sessions.map((s) => listed(s, ctx.access.event.slug, tz)),
              },
              null,
              2,
            ),
          },
        ],
      }
    },
  )

  return server
}
