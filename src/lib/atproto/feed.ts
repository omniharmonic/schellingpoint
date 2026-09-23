import 'server-only'
/**
 * The gathering feed (design §7): the gathering's own account posts about its own activity so
 * anyone on Bluesky can follow it. Everything here is server-side; the browser only ever sees the
 * ledger through the organiser feed route.
 *
 *   GATES      nothing runs unless `events.feed_posts` is on (organiser switch, default off), the
 *              gathering has an actor, is public and out of draft. A person is @-mentioned only
 *              through the port's own consent set (`consentedMentionDids`, R9): their
 *              `event_members.mention_in_posts` for this gathering AND host / self-written co-host
 *              of the session AND a visible repo. Otherwise the text says "the host".
 *   LEDGER     `feed_posts` (migration 0022): one row per (event, kind, subject) is CLAIMED before
 *              any record is written, so re-running a publish never double-posts. When one publish
 *              would post about more sessions than `feed_digest_threshold`, the per-session rows
 *              are marked `digested` and ONE `schedule-digest` row is queued instead.
 *   DELIVERY   `publish_jobs` with `kind='feed'` (one live job per gathering), kicked off after the
 *              triggering request commits and drained by the scheduler's minute loop. Each post is
 *              one `putRecordAsGathering` (`publish-post`): lexicon-validated, sidecar-checked,
 *              R9-checked with the consented set the port computed itself, audited, paced by the
 *              credential session's `paceRepoWrite`.
 *   BUILDER    `buildPostRecord` is pure: ≤ 300 graphemes (the title is cut with "…" before the
 *              link), `langs: ['en']`, a link facet, consented mention facets only — any other
 *              mention `RichText` detects is stripped and its text rewritten as "the host" — and an
 *              `app.bsky.embed.external` card whose thumb, when the gathering has a logo, is the
 *              blob already in its own repo (design §7.3; `blobs.ts` uploads it once).
 *   NEVER      `host_name` / listed-as names, exact addresses (the gathering's `location_name`
 *              only), vote counts, attendee-only details.
 */
import { RichText } from '@atproto/api'
import { randomUUID } from 'node:crypto'
import { sql } from '@/lib/db'
import { actorForEvent, consentedMentionDids } from './actors'
import type { Approval } from './actor'
import { NSID } from './nsids'
import { enqueueFeedJob, runDuePublishJobs } from './publish-jobs'
import { isRateLimitBudgetExceeded } from './rate-limit'
import { assertNoForeignDid } from './records'
import { tid } from './rkey'
import type { RecordBlob } from './types'

export const POST_MAX_GRAPHEMES = 300
export const HOST_FALLBACK = 'the host'
/** Digest threshold bounds (`events.feed_digest_threshold`, migration 0022). */
export const DIGEST_THRESHOLD_BOUNDS = { min: 1, max: 100, default: 10 } as const

export type GatheringFeedKind = 'gathering-published' | 'proposals-open' | 'voting-open' | 'schedule-published'
export type SessionFeedKind = 'session-scheduled' | 'session-moved' | 'session-cancelled'
export type FeedKind = GatheringFeedKind | SessionFeedKind | 'schedule-digest'
export type FeedPostStatus = 'queued' | 'posted' | 'failed' | 'digested' | 'deleted'

export const FEED_KINDS: readonly FeedKind[] = [
  'gathering-published', 'proposals-open', 'voting-open', 'schedule-published', 'schedule-digest',
  'session-scheduled', 'session-moved', 'session-cancelled',
]

/** Plain words for the organiser UI (design §7.2 "plain-language list of what gets posted"). */
export const FEED_KIND_LABEL: Record<FeedKind, string> = {
  'gathering-published': 'Gathering published',
  'proposals-open': 'Proposals open',
  'voting-open': 'Voting open',
  'schedule-published': 'Schedule published',
  'schedule-digest': 'Sessions added (digest)',
  'session-scheduled': 'Session scheduled',
  'session-moved': 'Session moved',
  'session-cancelled': 'Session cancelled',
}

/* ────────────────────────────── builder (pure) ────────────────────────────── */

export interface PostMention {
  did: string
  handle: string
}

export interface BuildPostInput {
  /**
   * Template with `{title}` (the one segment truncated when over the limit), `{host}` (rendered
   * as `@handle` only when the host is in `consented`, else "the host") and `{link}` (the URL
   * without its scheme, carrying a link facet to `url`). Anything else is literal text.
   */
  template: string
  title?: string | null
  /** The session's host, when the post is about a session. */
  host?: { did: string; handle: string | null } | null
  /** The DIDs a mention may name: the port's set, never caller input. */
  consented: ReadonlySet<string>
  url: string
  card: { title: string; description: string }
  /** The gathering's own logo blob, already in its repo. Omitted → a card with no image. */
  thumb?: RecordBlob | null
  createdAt: Date | string
}

export interface BuiltPost {
  record: Record<string, unknown>
  text: string
  facets: Facet[]
  /** The DIDs actually named by a mention facet (each in `consented`). */
  mentions: PostMention[]
}

interface Facet {
  $type?: string
  index: { byteStart: number; byteEnd: number }
  features: Array<{ $type: string; did?: string; uri?: string; tag?: string }>
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

function graphemes(s: string): string[] {
  return Array.from(segmenter.segment(s), (x) => x.segment)
}

function graphemeLength(s: string): number {
  return new RichText({ text: s }).graphemeLength
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/** utf8 byte offset → utf16 index (facet indexes are bytes). */
function byteToUtf16(text: string, byteOffset: number): number {
  return Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8').length
}

export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
}

/**
 * Substitute the template's tokens. Title content is inserted verbatim (a title containing
 * "{host}" stays literal) and the mention only ever comes from `host` + `consented`.
 */
function render(input: BuildPostInput, title: string | null): { text: string; mention: PostMention | null; link: string } {
  const host = input.host
  const mention = host && host.handle && input.consented.has(host.did) ? { did: host.did, handle: host.handle } : null
  const link = displayUrl(input.url)
  const text = input.template
    .split(/(\{title\}|\{host\}|\{link\})/)
    .map((part) => {
      if (part === '{title}') return title ?? ''
      if (part === '{host}') return mention ? `@${mention.handle}` : HOST_FALLBACK
      if (part === '{link}') return link
      return part
    })
    .join('')
  return { text, mention, link }
}

/** Cut `title` so the rendered text fits `POST_MAX_GRAPHEMES`, ending the title with "…". */
function fitTitle(input: BuildPostInput): string | null {
  const title = input.title?.trim() || null
  const full = render(input, title).text
  const over = graphemeLength(full) - POST_MAX_GRAPHEMES
  if (over <= 0) return title
  if (!title || !input.template.includes('{title}')) return title
  const g = graphemes(title)
  const keep = Math.max(0, g.length - over - 1)
  return keep > 0 ? `${g.slice(0, keep).join('').replace(/\s+$/, '')}…` : '…'
}

/**
 * Pure post builder. Detects facets with `RichText`, KEEPS only a mention of the consented host
 * (its `did` set from our own data, never from detection) and REWRITES every other mention as
 * "the host"; adds our own link facet; drops detected links and tags. Throws if the result still
 * names a foreign DID (belt and braces — the port checks again).
 */
export function buildPostRecord(input: BuildPostInput): BuiltPost {
  const title = fitTitle(input)
  let { text } = render(input, title)
  const { mention, link } = render(input, title)

  // Strip every mention RichText finds that is not the consented host, rewriting the text.
  for (let guard = 0; guard < 50; guard++) {
    const rt = new RichText({ text })
    rt.detectFacetsWithoutResolution()
    const stray = (rt.facets ?? []).find((f) => {
      const m = f.features.find((x) => x.$type === 'app.bsky.richtext.facet#mention') as { did?: string } | undefined
      return m && !(mention && typeof m.did === 'string' && m.did.toLowerCase() === mention.handle.toLowerCase())
    })
    if (!stray) break
    const s = byteToUtf16(text, stray.index.byteStart)
    const e = byteToUtf16(text, stray.index.byteEnd)
    text = `${text.slice(0, s)}${HOST_FALLBACK}${text.slice(e)}`
  }
  if (graphemeLength(text) > POST_MAX_GRAPHEMES) {
    // Rewrites made it longer than the fitted title allowed: hard cut before the link.
    const at = text.lastIndexOf(link)
    const head = at >= 0 ? text.slice(0, at) : text
    const tail = at >= 0 ? text.slice(at) : ''
    const room = Math.max(0, POST_MAX_GRAPHEMES - graphemeLength(tail) - 2)
    text = `${graphemes(head).slice(0, room).join('').replace(/\s+$/, '')}… ${tail}`.trim()
  }

  const facets: Facet[] = []
  const mentions: PostMention[] = []
  if (mention) {
    const needle = `@${mention.handle}`
    const at = text.indexOf(needle)
    if (at >= 0) {
      facets.push({
        index: { byteStart: byteLen(text.slice(0, at)), byteEnd: byteLen(text.slice(0, at + needle.length)) },
        features: [{ $type: 'app.bsky.richtext.facet#mention', did: mention.did }],
      })
      mentions.push(mention)
    }
  }
  const linkAt = text.lastIndexOf(link)
  if (linkAt >= 0) {
    facets.push({
      index: { byteStart: byteLen(text.slice(0, linkAt)), byteEnd: byteLen(text.slice(0, linkAt + link.length)) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: input.url }],
    })
  }
  facets.sort((a, b) => a.index.byteStart - b.index.byteStart)

  const createdAt = typeof input.createdAt === 'string' ? new Date(input.createdAt).toISOString() : input.createdAt.toISOString()
  const record: Record<string, unknown> = {
    $type: NSID.post,
    text,
    ...(facets.length ? { facets } : {}),
    langs: ['en'],
    createdAt,
    embed: {
      $type: 'app.bsky.embed.external',
      external: {
        uri: input.url,
        title: input.card.title.slice(0, 200),
        description: input.card.description.slice(0, 500),
        ...(input.thumb ? { thumb: input.thumb } : {}),
      },
    },
  }
  // A foreign DID may appear only as a consented mention facet (design §7.2).
  assertNoForeignDid(record, 'did:example:feed-builder', { consentedMentionDids: new Set(mentions.map((m) => m.did)) })
  return { record, text, facets, mentions }
}

/* ─────────────────────────────── gates and rows ─────────────────────────────── */

interface EventGate {
  id: string
  slug: string
  name: string
  tagline: string | null
  timezone: string
  location_name: string | null
  start_date: string | Date
  end_date: string | Date
  status: string
  visibility: string
  actor_did: string | null
  actor_handle: string | null
  feed_posts: boolean
  feed_digest_threshold: number
}

async function loadGate(eventId: string): Promise<EventGate | null> {
  const [row] = await sql<EventGate[]>`
    select id, slug, name, tagline, timezone, location_name, start_date, end_date, status, visibility,
           actor_did, actor_handle, feed_posts, feed_digest_threshold
    from events where id = ${eventId}
  `
  return row ?? null
}

/** Why the feed is not posting, or null when every gate is open. */
export function feedBlockedReason(e: Pick<EventGate, 'feed_posts' | 'actor_did' | 'status' | 'visibility'>): string | null {
  if (!e.feed_posts) return 'feed posting is off for this gathering'
  if (!e.actor_did) return 'the gathering has no network identity'
  if (e.status === 'draft') return 'a draft gathering posts nothing'
  if (e.visibility !== 'public') return 'only public gatherings post to their feed'
  return null
}

export interface EnqueueResult {
  /** Rows newly claimed (0 when everything was already claimed or the gates are closed). */
  queued: number
  digest: boolean
  jobId: string | null
  blocked: string | null
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || 'https://unconference.events').replace(/\/+$/, '')
}

async function ensureJob(eventId: string, callerUserId: string | null): Promise<string | null> {
  const { job } = await enqueueFeedJob({ eventId, callerUserId })
  return job.id
}

/** Claim one gathering-level post (one per event and kind). */
export async function enqueueGatheringPost(input: { eventId: string; kind: GatheringFeedKind; callerUserId: string | null; meta?: Record<string, unknown> }): Promise<EnqueueResult> {
  const gate = await loadGate(input.eventId)
  const blocked = gate ? feedBlockedReason(gate) : 'event not found'
  if (!gate || blocked) return { queued: 0, digest: false, jobId: null, blocked }
  const inserted = await sql<{ id: string }[]>`
    insert into feed_posts (event_id, kind, subject_id, subject_key, requested_by, meta)
    values (${input.eventId}, ${input.kind}, null, '', ${input.callerUserId}, ${sql.json((input.meta ?? {}) as never)})
    on conflict (event_id, kind, subject_key) do nothing
    returning id
  `
  if (!inserted.length) return { queued: 0, digest: false, jobId: null, blocked: null }
  return { queued: 1, digest: false, jobId: await ensureJob(input.eventId, input.callerUserId), blocked: null }
}

/**
 * Claim session posts (one per event, kind and session). For `session-scheduled`, more newly
 * claimed sessions than `feed_digest_threshold` in one call become a single digest post.
 */
export async function enqueueSessionPosts(input: { eventId: string; kind: SessionFeedKind; sessionIds: readonly string[]; callerUserId: string | null }): Promise<EnqueueResult> {
  const ids = Array.from(new Set(input.sessionIds))
  if (!ids.length) return { queued: 0, digest: false, jobId: null, blocked: null }
  const gate = await loadGate(input.eventId)
  const blocked = gate ? feedBlockedReason(gate) : 'event not found'
  if (!gate || blocked) return { queued: 0, digest: false, jobId: null, blocked }
  // Only sessions of THIS event, never a foreign id smuggled in.
  const inserted = await sql<{ id: string }[]>`
    insert into feed_posts (event_id, kind, subject_id, subject_key, requested_by)
    select s.event_id, ${input.kind}, s.id, s.id::text, ${input.callerUserId}
    from sessions s
    where s.event_id = ${input.eventId} and s.id = any(${ids}::uuid[])
      -- The gathering does not announce a session it has hidden (migration 0033).
      and not coalesce(s.hidden_by_moderation, false)
    on conflict (event_id, kind, subject_key) do nothing
    returning id
  `
  if (!inserted.length) return { queued: 0, digest: false, jobId: null, blocked: null }
  let digest = false
  if (input.kind === 'session-scheduled' && inserted.length > gate.feed_digest_threshold) {
    digest = true
    const claimed = inserted.map((r) => r.id)
    await sql`update feed_posts set status = 'digested', updated_at = now() where id = any(${claimed}::uuid[])`
    await sql`
      insert into feed_posts (event_id, kind, subject_id, subject_key, requested_by, meta)
      values (${input.eventId}, 'schedule-digest', null, ${randomUUID()}, ${input.callerUserId}, ${sql.json({ count: claimed.length, postIds: claimed } as never)})
    `
  }
  return { queued: digest ? 1 : inserted.length, digest, jobId: await ensureJob(input.eventId, input.callerUserId), blocked: null }
}

/** Run the gathering's live feed job now (routes call this from `after()`; the scheduler resumes it). */
export async function kickFeedDelivery(eventId: string, timeBudgetMs = 60_000): Promise<void> {
  const [job] = await sql<{ id: string }[]>`
    select id from publish_jobs where event_id = ${eventId} and kind = 'feed' and status in ('queued', 'running') order by created_at desc limit 1
  `
  if (!job) return
  await runDuePublishJobs({ jobId: job.id, timeBudgetMs }).catch(() => undefined)
}

/* ──────────────────────────────── composing ──────────────────────────────── */

interface FeedRow {
  id: string
  event_id: string
  kind: FeedKind
  subject_id: string | null
  meta: Record<string, unknown>
  attempts: number
  requested_by: string | null
}

interface SessionRow {
  id: string
  title: string
  host_id: string | null
  cancelled_at: string | null
  start_time: string | Date | null
  venue_name: string | null
  host_did: string | null
  host_handle: string | null
}

function dateOnly(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}

/** "Sat, Oct 3, 9:00 AM" in the gathering's timezone. */
export function formatWhen(at: Date | string, timezone: string): string {
  const d = typeof at === 'string' ? new Date(at) : at
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
  } catch {
    return d.toISOString()
  }
}

/** "Oct 3–4, 2026" from date-only columns. */
export function formatDates(start: string | Date, end: string | Date): string {
  const s = new Date(`${dateOnly(start)}T12:00:00Z`)
  const e = new Date(`${dateOnly(end)}T12:00:00Z`)
  const f = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(d)
  if (dateOnly(start) === dateOnly(end)) return f(s, { month: 'short', day: 'numeric', year: 'numeric' })
  if (s.getUTCMonth() === e.getUTCMonth() && s.getUTCFullYear() === e.getUTCFullYear()) return `${f(s, { month: 'short', day: 'numeric' })}–${f(e, { day: 'numeric' })}, ${s.getUTCFullYear()}`
  return `${f(s, { month: 'short', day: 'numeric' })} – ${f(e, { month: 'short', day: 'numeric', year: 'numeric' })}`
}

async function loadSession(eventId: string, sessionId: string): Promise<SessionRow | null> {
  const [row] = await sql<SessionRow[]>`
    select s.id, s.title, s.host_id, s.cancelled_at, ts.start_time, v.name as venue_name, a.did as host_did, a.handle as host_handle
    from sessions s
    left join time_slots ts on ts.id = s.time_slot_id
    left join venues v on v.id = s.venue_id
    left join accounts a on a.id = s.host_id
    where s.id = ${sessionId} and s.event_id = ${eventId}
      -- Re-checked at delivery, not only at enqueue: a session can be hidden in the minutes
      -- between a post being queued and the queue being drained.
      and not coalesce(s.hidden_by_moderation, false)
  `
  return row ?? null
}

/** Everything `buildPostRecord` needs for one row, read fresh at delivery time. */
async function compose(event: EventGate, row: FeedRow): Promise<Omit<BuildPostInput, 'createdAt' | 'consented'> & { sessionId: string | null }> {
  const base = `${appUrl()}/e/${event.slug}`
  const place = event.location_name?.trim() ? `, ${event.location_name.trim()}` : ''
  const when = formatDates(event.start_date, event.end_date)
  const gatheringCard = { title: event.name, description: event.tagline?.trim() || `${when}${place}` }
  switch (row.kind) {
    case 'gathering-published':
      return { template: `{title} — ${when}${place}. {link}`, title: event.name, url: base, card: gatheringCard, sessionId: null }
    case 'proposals-open':
      return { template: `Proposals are open for {title}: pitch a session. {link}`, title: event.name, url: `${base}/sessions/new`, card: { ...gatheringCard, description: 'Proposals are open.' }, sessionId: null }
    case 'voting-open':
      return { template: `Voting is open for {title}. {link}`, title: event.name, url: `${base}/sessions`, card: { ...gatheringCard, description: 'Voting is open.' }, sessionId: null }
    case 'schedule-published': {
      const n = Number(row.meta.sessions ?? 0)
      const m = Number(row.meta.rooms ?? 0)
      const summary = `${n} session${n === 1 ? '' : 's'} across ${m} room${m === 1 ? '' : 's'}`
      return { template: `The schedule is out for {title}: ${summary}. {link}`, title: event.name, url: `${base}/schedule`, card: { title: `${event.name} schedule`, description: summary }, sessionId: null }
    }
    case 'schedule-digest': {
      const n = Number(row.meta.count ?? 0)
      const summary = `${n} session${n === 1 ? ' was' : 's were'} added to the schedule`
      return { template: `${summary} for {title}. {link}`, title: event.name, url: `${base}/schedule`, card: { title: `${event.name} schedule`, description: summary }, sessionId: null }
    }
    case 'session-scheduled':
    case 'session-moved':
    case 'session-cancelled': {
      if (!row.subject_id) throw new Error('session post without a session')
      const s = await loadSession(event.id, row.subject_id)
      if (!s) throw new Error('session not found in this gathering')
      const url = `${base}/sessions/${s.id}`
      const host = s.host_did ? { did: s.host_did, handle: s.host_handle } : null
      if (row.kind === 'session-cancelled' || s.cancelled_at) {
        return { template: `Cancelled: “{title}”. {link}`, title: s.title, url, card: { title: s.title, description: `Cancelled · ${event.name}` }, sessionId: s.id }
      }
      const at = s.start_time ? formatWhen(s.start_time, event.timezone) : null
      const room = s.venue_name?.trim() || null
      const whenWhere = [at, room ? `in ${room}` : null].filter(Boolean).join(' ')
      if (row.kind === 'session-moved') {
        return { template: `Moved: “{title}” is now ${whenWhere || 'at a new time'}. {link}`, title: s.title, url, host, card: { title: s.title, description: `${whenWhere} · ${event.name}` }, sessionId: s.id }
      }
      return { template: `On the schedule: “{title}” — ${whenWhere}, hosted by {host}. {link}`, title: s.title, url, host, card: { title: s.title, description: `${whenWhere} · ${event.name}` }, sessionId: s.id }
    }
  }
}

/* ─────────────────────────────── delivery ─────────────────────────────── */

export interface DeliverResult {
  posted: number
  failed: number
  /** Rows still queued (rate-limited or newer than this pass). */
  remaining: number
  retryAfterMs?: number
}

async function failRow(id: string, error: string): Promise<void> {
  await sql`update feed_posts set status = 'failed', error = ${error.slice(0, 500)}, attempts = attempts + 1, updated_at = now() where id = ${id}`
}

/**
 * Post every queued row of one gathering, oldest first, through the port. Never throws for one
 * row; a rate limit stops the pass and reports when to resume; a denial stops the pass (every
 * later row would be denied the same way).
 */
export async function deliverQueuedPosts(input: { eventId: string; callerUserId: string | null; limit?: number }): Promise<DeliverResult> {
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100))
  const rows = await sql<FeedRow[]>`
    select id, event_id, kind, subject_id, meta, attempts, requested_by from feed_posts
    where event_id = ${input.eventId} and status = 'queued' order by created_at, id limit ${limit}
  `
  const out: DeliverResult = { posted: 0, failed: 0, remaining: 0 }
  if (!rows.length) return out
  const event = await loadGate(input.eventId)
  const blocked = event ? feedBlockedReason(event) : 'event not found'
  if (!event || blocked) {
    for (const r of rows) await failRow(r.id, `not posted: ${blocked}`)
    out.failed = rows.length
    return out
  }
  const port = await actorForEvent(event.id)
  // One blob for the whole pass: the gathering's logo, uploaded once and cached in `at_blobs`.
  const thumb = await gatheringThumb(event, input.callerUserId)
  for (const [i, row] of rows.entries()) {
    try {
      const draft = await compose(event, row)
      const consented = draft.sessionId ? await consentedMentionDids(event.id, draft.sessionId) : new Set<string>()
      const built = buildPostRecord({ ...draft, consented, thumb, createdAt: new Date() })
      const rkey = tid()
      const res = await port.putRecordAsGathering({
        callerUserId: input.callerUserId,
        action: 'publish-post',
        collection: NSID.post,
        rkey,
        record: built.record,
        swapRecord: null,
        reason: `feed: ${FEED_KIND_LABEL[row.kind].toLowerCase()}${built.mentions.length ? ' (host consented to the mention)' : ''}`,
        feedSubject: { sessionId: draft.sessionId },
      })
      await sql`
        update feed_posts set status = 'posted', uri = ${res.uri}, cid = ${res.cid}, rkey = ${rkey}, text = ${built.text},
          facets = ${sql.json(built.facets as never)}, embed = ${sql.json(built.record.embed as never)},
          mentions = ${sql.json(built.mentions as never)}, error = null, attempts = attempts + 1, posted_at = now(), updated_at = now()
        where id = ${row.id}
      `
      out.posted++
    } catch (e) {
      if (isRateLimitBudgetExceeded(e)) {
        out.retryAfterMs = Math.max(1_000, e.retryAfterMs)
        out.remaining += rows.length - i
        return out
      }
      const name = (e as { name?: string })?.name
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      await failRow(row.id, message)
      out.failed++
      if (name === 'GatheringActionDeniedError' || name === 'GatheringNotLinkedError') {
        // Everything after this row would be refused for the same reason: stop, leave them queued.
        out.remaining += rows.length - i - 1
        return out
      }
    }
  }
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from feed_posts where event_id = ${input.eventId} and status = 'queued'`
  out.remaining += n
  return out
}

/**
 * The gathering's logo as the link card's thumb (design §7.3). Best effort: no logo, a logo we
 * did not store ourselves, or a refused upload gives a card without an image — never a failure.
 */
async function gatheringThumb(event: EventGate, callerUserId: string | null): Promise<RecordBlob | null> {
  const [row] = await sql<{ logo_url: string | null }[]>`select logo_url from events where id = ${event.id}`
  if (!row?.logo_url || !event.actor_did) return null
  const { gatheringAvatarBlob } = await import('./blobs')
  return gatheringAvatarBlob({
    eventId: event.id,
    actorDid: event.actor_did,
    callerUserId,
    url: row.logo_url,
    reason: `feed: upload "${event.name}"'s logo for the post link card`,
    purpose: 'feed-thumb',
  })
}

/* ─────────────────────────────── organiser API ─────────────────────────────── */

export interface FeedPostView {
  id: string
  kind: FeedKind
  label: string
  status: FeedPostStatus
  subjectId: string | null
  text: string
  uri: string | null
  /** `https://bsky.app/profile/<handle>/post/<rkey>` when posted. */
  bskyUrl: string | null
  mentions: PostMention[]
  error: string | null
  createdAt: string
  postedAt: string | null
}

export interface FeedState {
  enabled: boolean
  digestThreshold: number
  blocked: string | null
  actorHandle: string | null
  counts: { queued: number; posted: number; failed: number }
  posts: FeedPostView[]
}

export async function feedState(eventId: string, limit = 20): Promise<FeedState | null> {
  const event = await loadGate(eventId)
  if (!event) return null
  const [counts] = await sql<{ queued: number; posted: number; failed: number }[]>`
    select count(*) filter (where status = 'queued')::int as queued,
           count(*) filter (where status = 'posted')::int as posted,
           count(*) filter (where status = 'failed')::int as failed
    from feed_posts where event_id = ${eventId}
  `
  const rows = await sql<Array<{ id: string; kind: FeedKind; status: FeedPostStatus; subject_id: string | null; text: string; uri: string | null; rkey: string | null; mentions: PostMention[]; error: string | null; created_at: string; posted_at: string | null }>>`
    select id, kind, status, subject_id, text, uri, rkey, mentions, error, created_at, posted_at
    from feed_posts where event_id = ${eventId} and status <> 'digested'
    order by created_at desc, id desc limit ${Math.max(1, Math.min(limit, 100))}
  `
  return {
    enabled: event.feed_posts,
    digestThreshold: event.feed_digest_threshold,
    blocked: feedBlockedReason(event),
    actorHandle: event.actor_handle,
    counts: counts ?? { queued: 0, posted: 0, failed: 0 },
    posts: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: FEED_KIND_LABEL[r.kind] ?? r.kind,
      status: r.status,
      subjectId: r.subject_id,
      text: r.text,
      uri: r.uri,
      bskyUrl: r.status === 'posted' && r.rkey && event.actor_handle ? `https://bsky.app/profile/${encodeURIComponent(event.actor_handle)}/post/${encodeURIComponent(r.rkey)}` : null,
      mentions: Array.isArray(r.mentions) ? r.mentions : [],
      error: r.error,
      createdAt: r.created_at,
      postedAt: r.posted_at,
    })),
  }
}

/** Put a failed post back in the queue and make sure a delivery job exists. */
export async function retryFeedPost(input: { eventId: string; postId: string; callerUserId: string }): Promise<{ jobId: string } | null> {
  const [row] = await sql<{ id: string }[]>`
    update feed_posts set status = 'queued', error = null, requested_by = ${input.callerUserId}, updated_at = now()
    where id = ${input.postId} and event_id = ${input.eventId} and status = 'failed'
    returning id
  `
  if (!row) return null
  const jobId = await ensureJob(input.eventId, input.callerUserId)
  return jobId ? { jobId } : null
}

/**
 * DESTRUCTIVE (two organisers, design §7.4): delete a post from the gathering's repo. The port
 * action `delete-post` needs the policy's approvals; the ledger row is kept as `deleted`, so a
 * retraction stays visible to organisers. Reached from the Network page's Feed card ("Retract"),
 * which goes through `approvals.ts` — the same two-organiser flow as moving or cancelling a
 * published session — and never directly.
 */
export async function deleteFeedPost(input: { eventId: string; postId: string; callerUserId: string; reason: string; approvals: Approval[] }): Promise<{ auditId: string } | null> {
  const [row] = await sql<{ id: string; rkey: string | null }[]>`
    select id, rkey from feed_posts where id = ${input.postId} and event_id = ${input.eventId} and status = 'posted'
  `
  if (!row?.rkey) return null
  const port = await actorForEvent(input.eventId)
  const res = await port.deleteRecordAsGathering({
    callerUserId: input.callerUserId,
    action: 'delete-post',
    collection: NSID.post,
    rkey: row.rkey,
    reason: input.reason,
    approvals: input.approvals,
  })
  await sql`update feed_posts set status = 'deleted', deleted_at = now(), updated_at = now() where id = ${row.id}`
  return res
}
