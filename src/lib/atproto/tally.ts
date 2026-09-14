/**
 * The k-suppressed vote tally (spec §5.5–5.6): the ONLY public artifact of a
 * voting round. Counts and presence per proposal, never a voter, never a rank.
 *
 *  - `computeTally`  aggregates app-side `votes` rows per session and applies
 *                    the suppression threshold k (entries with fewer than k
 *                    distinct voters carry no counts at all)
 *  - `publishTally`  writes `schellingpoint.draft.tally` at
 *                    `deterministicRkey('tally', eventId, round)` through the
 *                    gathering actor port, pinning each entry to the proposer's
 *                    published proposal or a gathering-written stub
 *
 * No user id ever leaves this module: the tally record carries strongRefs and
 * integers only, and `ballotsCast` is a count, not a list.
 */
import { createAdminClient } from '@/lib/supabase/server'
import { NSID } from './nsids'
import {
  attempt,
  ensureProposalRef,
  gatheringUriFor,
  loadPublishContext,
  putWithCas,
  type PublishDeps,
  type PublishInput,
  type PublishOutput,
  type PublishResult,
  type SessionRow,
} from './publish'
import { buildTallyRecord, DEFAULT_POLICY_THRESHOLDS } from './records'
import { deterministicRkey } from './rkey'
import type { StrongRef, TallyRound, VotingMechanism } from './types'

/** The columns of a `votes` row the tally needs. `user_id` is consumed here and goes no further. */
export interface VoteRow {
  session_id: string
  user_id: string
  vote_count: number | null
  credits_spent: number | null
}

export type TallyEntryCounts =
  | { sessionId: string; suppressed: true }
  | { sessionId: string; suppressed: false; voters: number; votes: number; credits: number }

export interface Tally {
  k: number
  /** Distinct voters across the round. */
  ballotsCast: number
  entries: TallyEntryCounts[]
}

export type VoteLoader = (eventId: string) => Promise<VoteRow[]>

/** Default k: the policy's `feedbackK` (3). */
export const DEFAULT_K: number = DEFAULT_POLICY_THRESHOLDS.feedbackK

async function loadVotes(eventId: string): Promise<VoteRow[]> {
  const db = await createAdminClient()
  const { data, error } = await db.from('votes').select('session_id, user_id, vote_count, credits_spent').eq('event_id', eventId)
  if (error) throw new Error(`votes list: ${error.message}`)
  return (data ?? []) as VoteRow[]
}

/**
 * Group votes by session: `voters` = distinct voters, `votes` = Σ vote_count,
 * `credits` = Σ credits_spent. Entries with `voters < k` are suppressed and
 * carry NO counts (not zeros). Entries are ordered by session id so the
 * output — and therefore the record's cid — is stable across runs.
 */
export async function computeTally(eventId: string, k: number = DEFAULT_K, load: VoteLoader = loadVotes): Promise<Tally> {
  if (!Number.isInteger(k) || k < 1) throw new Error(`tally k must be a positive integer, got ${k}`)
  const rows = await load(eventId)
  const perSession = new Map<string, { voters: Set<string>; votes: number; credits: number }>()
  const allVoters = new Set<string>()
  for (const row of rows) {
    if (!row.session_id || !row.user_id) continue
    const agg = perSession.get(row.session_id) ?? { voters: new Set<string>(), votes: 0, credits: 0 }
    agg.voters.add(row.user_id)
    agg.votes += Math.max(0, Math.trunc(row.vote_count ?? 0))
    agg.credits += Math.max(0, Math.trunc(row.credits_spent ?? 0))
    perSession.set(row.session_id, agg)
    allVoters.add(row.user_id)
  }
  const entries: TallyEntryCounts[] = [...perSession.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sessionId, agg]) =>
      agg.voters.size < k
        ? { sessionId, suppressed: true }
        : { sessionId, suppressed: false, voters: agg.voters.size, votes: agg.votes, credits: agg.credits },
    )
  return { k, ballotsCast: allVoters.size, entries }
}

export interface PublishTallyInput extends PublishInput {
  round?: TallyRound
  /** Suppression threshold; defaults to the policy's feedbackK. */
  k?: number
}

const MECHANISMS: readonly VotingMechanism[] = ['quadratic', 'linear', 'approval']

/**
 * Write the round's tally as the gathering. Sessions that no longer exist are
 * skipped; a session whose (stub) proposal cannot be written is reported in
 * `results` and left out of the record rather than failing the whole tally.
 */
export async function publishTally(
  input: PublishTallyInput,
  deps?: PublishDeps,
  opts: { loadVotes?: VoteLoader } = {},
): Promise<PublishOutput> {
  const ctx = await loadPublishContext(input, deps)
  const round: TallyRound = input.round ?? 'pre-event'
  const results: PublishResult[] = []
  const tally = await computeTally(ctx.event.id, input.k ?? DEFAULT_K, opts.loadVotes)

  const sessionIds = tally.entries.map((e) => e.sessionId)
  const sessions = new Map<string, SessionRow>()
  if (sessionIds.length) {
    const { data, error } = await ctx.db
      .from('sessions')
      .select(
        'id, title, description, format, duration, status, venue_id, time_slot_id, track_id, topic_tags, expected_attendance, ' +
          'required_features, is_self_hosted, self_hosted_start_time, self_hosted_end_time, custom_location, created_at, ' +
          'proposal_uri, proposal_cid, calendar_event_uri, calendar_event_cid, slot_uri, slot_cid',
      )
      .eq('event_id', ctx.event.id)
      .in('id', sessionIds)
    if (error) throw new Error(`sessions list: ${error.message}`)
    for (const s of (data ?? []) as unknown as SessionRow[]) sessions.set(s.id, s)
  }
  const trackIds = [...new Set([...sessions.values()].map((s) => s.track_id).filter((id): id is string => !!id))]
  const trackUris = new Map<string, string | null>()
  if (trackIds.length) {
    const { data } = await ctx.db.from('tracks').select('id, at_uri').in('id', trackIds)
    for (const t of (data ?? []) as Array<{ id: string; at_uri: string | null }>) trackUris.set(t.id, t.at_uri)
  }

  const entries: Array<{ proposal: StrongRef; voters: number; votes: number; credits: number }> = []
  for (const entry of tally.entries) {
    const session = sessions.get(entry.sessionId)
    if (!session) continue
    const track = session.track_id ? { at_uri: trackUris.get(session.track_id) ?? null } : null
    const proposal = await ensureProposalRef(ctx, { session, track }, results)
    if (!proposal) continue
    entries.push(
      entry.suppressed
        ? { proposal, voters: 0, votes: 0, credits: 0 }
        : { proposal, voters: entry.voters, votes: entry.votes, credits: entry.credits },
    )
  }

  const mechanism = MECHANISMS.includes(ctx.event.voting_mechanism as VotingMechanism)
    ? (ctx.event.voting_mechanism as VotingMechanism)
    : 'quadratic'
  const now = new Date().toISOString()
  const record = buildTallyRecord({
    gathering: gatheringUriFor(ctx.actorDid),
    round,
    mechanism,
    creditsPerVoter: ctx.event.vote_credits_per_user,
    ballotsCast: tally.ballotsCast,
    k: tally.k,
    entries,
    closedAt: ctx.event.voting_closes_at ?? now,
    createdAt: now,
  })
  await attempt(results, 'tally', ctx.event.id, () =>
    putWithCas(ctx, {
      action: 'publish-tally',
      collection: NSID.tally,
      rkey: deterministicRkey('tally', ctx.event.id, round),
      record,
      reason: `publish ${round} tally for "${ctx.event.name}" (k=${tally.k}, ${tally.ballotsCast} ballots)`,
    }),
  )
  return { results }
}
