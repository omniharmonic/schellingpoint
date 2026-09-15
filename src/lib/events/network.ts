import 'server-only'
/**
 * Package A's side of the ATProto contracts (plan §7.2): lifecycle and settings changes
 * reach the network only through here, always AFTER the database transaction commits and
 * never inside it. A network failure never turns a saved change into an error; it is
 * reported on the response (`network`) and audited by the gathering actor port (F), which
 * writes an `at_audit` row for every record write it attempts.
 */
import { publishGathering, publishPolicy, type PublishOutput } from '@/lib/atproto/publish'

export type NetworkAction = 'publish-gathering' | 'publish-policy'

export interface NetworkWrite {
  action: NetworkAction
  ok: boolean
  /** Records that were written (at-uris). */
  written: string[]
  /** Per-record failures, or one entry for a failure before any record was attempted. */
  errors: string[]
}

function summarize(action: NetworkAction, output: PublishOutput): NetworkWrite {
  const written = output.results.filter((r) => r.uri && !r.error).map((r) => r.uri as string)
  const errors = output.results.filter((r) => r.error).map((r) => `${r.kind}: ${r.error}`)
  return { action, ok: errors.length === 0, written, errors }
}

async function attempt(action: NetworkAction, run: () => Promise<PublishOutput>): Promise<NetworkWrite> {
  try {
    const result = summarize(action, await run())
    if (!result.ok) console.error(`[events/network] ${action} had failures:`, result.errors)
    return result
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown error'
    console.error(`[events/network] ${action} failed:`, message)
    return { action, ok: false, written: [], errors: [message] }
  }
}

/** Policy, the gathering's calendar event + config, and `gathering@self` (phase from status). */
export function publishGatheringRecords(eventId: string, callerUserId: string): Promise<NetworkWrite> {
  return attempt('publish-gathering', () => publishGathering({ eventId, callerUserId }))
}

/** Only the `freeschool.draft.policy` record (voting/proposal rules, thresholds). */
export function publishPolicyRecord(eventId: string, callerUserId: string): Promise<NetworkWrite> {
  return attempt('publish-policy', () => publishPolicy({ eventId, callerUserId }))
}
