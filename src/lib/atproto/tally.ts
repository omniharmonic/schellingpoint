/**
 * The k-suppressed vote tally (spec §5.3 steps 5–6): the ONLY public artifact of a
 * voting round. Counts and presence per proposal, never a voter, never a rank.
 *
 *  - input   `publicTally` from `@/lib/voting`: per-session sums of a FINALIZED round,
 *            already held to k. It is computed from `vote_round_results`, which has no
 *            account column, so no user id ever reaches this module.
 *  - output  `schellingpoint.draft.tally` at `deterministicRkey('tally', eventId, round)`,
 *            written through the gathering actor port, each entry pinned to the proposer's
 *            published proposal or a gathering-written stub (`ensureProposalRef`).
 *
 * Called by `closeRound` best-effort AFTER its transaction commits — never inside it.
 * A round that is still open cannot be published: `publicTally` throws `RoundOpenError`.
 *
 * Not `server-only`: tests import it and inject fake deps and loaders. The database is
 * loaded lazily so importing this module never pulls in a `server-only` module.
 */
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
import { buildTallyRecord } from './records'
import { deterministicRkey } from './rkey'
import type { StrongRef, TallyRound, VotingMechanism } from './types'

/** Default k: the policy's `feedbackK` (3) when the event sets none. */
export const DEFAULT_K = 3

/** One tally entry as the voting module hands it over: counts only when not suppressed. */
export type TallyEntryCounts =
  | { sessionId: string; suppressed: true }
  | { sessionId: string; suppressed: false; voters: number; votes: number; credits: number }

/** A finalized round's public tally, shaped for publication. */
export interface LoadedTally {
  roundId: string
  mechanism: VotingMechanism
  creditsPerVoter: number
  closedAt: string
  k: number
  ballotsCast: number
  entries: TallyEntryCounts[]
}

export type TallyLoader = (
  eventId: string,
  options: { round: TallyRound; roundId?: string; k?: number },
) => Promise<LoadedTally | null>

export type TallySessionRow = SessionRow & { track_at_uri: string | null }
export type TallySessionLoader = (eventId: string, sessionIds: string[]) => Promise<TallySessionRow[]>

export interface PublishTallyInput extends PublishInput {
  /** Which phase's tally record to write; defaults to 'pre-event'. */
  round?: TallyRound
  /** A specific finalized round; otherwise the latest finalized round of `round`'s phase. */
  roundId?: string
  /** Suppression threshold; defaults to the event's policy feedbackK. */
  k?: number
}

/** Latest finalized round of the phase (or `roundId`), through `publicTally`. */
async function loadTallyFromDb(
  eventId: string,
  options: { round: TallyRound; roundId?: string; k?: number },
): Promise<LoadedTally | null> {
  const [{ sql }, voting] = await Promise.all([import('@/lib/db'), import('@/lib/voting')])
  let roundId = options.roundId
  if (!roundId) {
    const [row] = await sql<{ id: string }[]>`
      select id from vote_rounds
      where event_id = ${eventId} and phase = ${options.round} and finalized_at is not null
      order by finalized_at desc limit 1
    `
    if (!row) return null
    roundId = row.id
  }
  const tally = await voting.publicTally(eventId, options.k, { roundId })
  if (!tally) return null
  return {
    roundId: tally.round.id,
    mechanism: tally.round.mechanism,
    creditsPerVoter: tally.round.credits,
    closedAt: tally.round.finalizedAt ?? tally.round.closesAt,
    k: tally.k,
    ballotsCast: tally.ballotsCast,
    entries: tally.entries,
  }
}

async function loadSessionsFromDb(eventId: string, sessionIds: string[]): Promise<TallySessionRow[]> {
  if (sessionIds.length === 0) return []
  const { sql } = await import('@/lib/db')
  return sql<TallySessionRow[]>`
    select s.*, t.at_uri as track_at_uri
    from sessions s
    left join tracks t on t.id = s.track_id and t.event_id = s.event_id
    where s.event_id = ${eventId} and s.id in ${sql(sessionIds)}
      -- A hidden session contributes no title to a public record (migration 0033). Its entry
      -- simply drops out of the tally, exactly as a deleted session's does.
      and not coalesce(s.hidden_by_moderation, false)
  `
}

/**
 * Write the round's tally as the gathering. Sessions that no longer exist are skipped;
 * a session whose (stub) proposal cannot be written is reported in `results` and left
 * out of the record rather than failing the whole tally.
 */
export async function publishTally(
  input: PublishTallyInput,
  deps?: PublishDeps,
  opts: { loadTally?: TallyLoader; loadSessions?: TallySessionLoader } = {},
): Promise<PublishOutput> {
  const round: TallyRound = input.round ?? 'pre-event'
  const tally = await (opts.loadTally ?? loadTallyFromDb)(input.eventId, { round, roundId: input.roundId, k: input.k })
  if (!tally) throw new Error(`event ${input.eventId} has no closed ${round} voting round to publish`)
  if (!Number.isInteger(tally.k) || tally.k < 1) throw new Error(`tally k must be a positive integer, got ${tally.k}`)

  const ctx = await loadPublishContext(input, deps)
  const results: PublishResult[] = []

  const rows = await (opts.loadSessions ?? loadSessionsFromDb)(
    ctx.event.id,
    tally.entries.map((e) => e.sessionId),
  )
  const sessions = new Map(rows.map((s) => [s.id, s]))

  const entries: Array<{ proposal: StrongRef; voters: number; votes: number; credits: number }> = []
  for (const entry of [...tally.entries].sort((a, b) => a.sessionId.localeCompare(b.sessionId))) {
    const session = sessions.get(entry.sessionId)
    if (!session) continue
    const proposal = await ensureProposalRef(ctx, { session, track: { at_uri: session.track_at_uri } }, results)
    if (!proposal) continue
    // Suppressed entries go in with zero voters, which `buildTallyRecord` turns into
    // `{ proposal, suppressed: true }` with no counts at all.
    entries.push(
      entry.suppressed
        ? { proposal, voters: 0, votes: 0, credits: 0 }
        : { proposal, voters: entry.voters, votes: entry.votes, credits: entry.credits },
    )
  }

  const record = buildTallyRecord({
    gathering: gatheringUriFor(ctx.actorDid),
    round,
    mechanism: tally.mechanism,
    creditsPerVoter: tally.creditsPerVoter,
    ballotsCast: tally.ballotsCast,
    k: tally.k,
    entries,
    closedAt: tally.closedAt,
    createdAt: new Date().toISOString(),
  })
  await attempt(results, 'tally', ctx.event.id, () =>
    putWithCas(ctx, {
      action: 'publish-tally',
      collection: NSID.tally,
      rkey: deterministicRkey('tally', ctx.event.id, round),
      record,
      reason: `publish ${round} tally (k=${tally.k}, ${tally.ballotsCast} ballots)`,
    }),
  )
  return { results }
}
