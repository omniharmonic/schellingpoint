import 'server-only'
/**
 * The sessions APIs' calls into the ATProto layer (work package F owns the writers).
 *
 * Every call here runs AFTER the app-side transaction has committed: a PDS that is slow or
 * down never rolls back a proposal, an acceptance or an RSVP. The outcome is reported to
 * the caller (`atproto` in the response) so the UI can offer a retry.
 */
import { sql } from '@/lib/db'
import {
  publishCohost,
  publishProposal,
  publicRsvp,
  retractPublicRsvp,
  withdrawCohost,
  withdrawProposal,
} from '@/lib/atproto/participant'

export interface AtprotoOutcome {
  uri?: string
  cid?: string
  /** Why nothing was written (not an error): e.g. `not_confirmed`, `nothing_to_withdraw`. */
  skipped?: string
  error?: string
  code?: string
}

/** Participant errors that mean "nothing to do here", not "something broke". */
const SKIP_CODES = new Set(['nothing_to_withdraw', 'link_atproto_first', 'no_rsvp'])

function codeOf(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code
  }
  return undefined
}

function failure(label: string, e: unknown): AtprotoOutcome {
  const code = codeOf(e)
  if (code && SKIP_CODES.has(code)) return { skipped: code }
  console.error(`[sessions] atproto ${label} failed:`, e instanceof Error ? e.message : e)
  return { error: e instanceof Error ? e.message : `${label} failed`, ...(code ? { code } : {}) }
}

/**
 * Whether this account's participant records go to their repo now (spec §4.2, §7):
 * custodial accounts always; Bluesky-door accounts only after they confirmed public
 * linkage (`profiles.publish_proposals`).
 */
export async function publishesParticipantRecords(accountId: string): Promise<boolean> {
  const rows = await sql<{ kind: string; publish_proposals: boolean | null }[]>`
    select a.kind, p.publish_proposals
    from accounts a left join profiles p on p.id = a.id
    where a.id = ${accountId}
  `
  const row = rows[0]
  if (!row) return false
  return row.kind === 'custodial' || !!row.publish_proposals
}

export async function publishProposalFor(sessionId: string, authorId: string): Promise<AtprotoOutcome> {
  if (!(await publishesParticipantRecords(authorId))) return { skipped: 'not_confirmed' }
  try {
    const result = await publishProposal({ sessionId, userId: authorId })
    return { uri: result.uri, cid: result.cid }
  } catch (e) {
    return failure('publishProposal', e)
  }
}

export async function withdrawProposalFor(sessionId: string, authorId: string): Promise<AtprotoOutcome> {
  try {
    const result = await withdrawProposal({ sessionId, userId: authorId })
    return { uri: result.uri }
  } catch (e) {
    return failure('withdrawProposal', e)
  }
}

export async function publishCohostFor(sessionId: string, cohostId: string): Promise<AtprotoOutcome> {
  if (!(await publishesParticipantRecords(cohostId))) return { skipped: 'not_confirmed' }
  const rows = await sql<{ proposal_uri: string | null; proposal_cid: string | null }[]>`
    select proposal_uri, proposal_cid from sessions where id = ${sessionId}
  `
  if (!rows[0]?.proposal_uri || !rows[0]?.proposal_cid) return { skipped: 'proposal_not_published' }
  try {
    const result = await publishCohost({ sessionId, userId: cohostId })
    return { uri: result.uri, cid: result.cid }
  } catch (e) {
    return failure('publishCohost', e)
  }
}

export async function withdrawCohostFor(sessionId: string, cohostId: string): Promise<AtprotoOutcome> {
  try {
    const result = await withdrawCohost({ sessionId, userId: cohostId })
    return { uri: result.uri }
  } catch (e) {
    return failure('withdrawCohost', e)
  }
}

export async function publicRsvpFor(sessionId: string, userId: string): Promise<AtprotoOutcome> {
  try {
    const result = await publicRsvp({ sessionId, userId, status: 'going' })
    return { uri: result.uri, cid: result.cid }
  } catch (e) {
    return failure('publicRsvp', e)
  }
}

export async function retractPublicRsvpFor(sessionId: string, userId: string): Promise<AtprotoOutcome> {
  try {
    const result = await retractPublicRsvp({ sessionId, userId })
    return { uri: result.uri }
  } catch (e) {
    return failure('retractPublicRsvp', e)
  }
}
