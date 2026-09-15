import 'server-only'
/**
 * A proposer's availability (spec §4.2 `schellingpoint.draft.timePreference`): app-side by
 * default in `time_preferences` (package F's table), published into the proposer's own repo
 * only when they opted in for this proposal.
 */
import type { Sql } from '@/lib/db'
import { publishTimePreference } from '@/lib/atproto/participant'
import type { TimePreferenceInput } from './validate'
import type { AtprotoOutcome } from './atproto'

/** App-side save inside the caller's transaction (service role), so it commits with the proposal. */
export async function saveTimePreference(
  db: Sql,
  input: { eventId: string; sessionId: string; accountId: string; input: TimePreferenceInput },
): Promise<void> {
  const { windows, blackouts, publish } = input.input
  await db`
    insert into time_preferences (event_id, session_id, account_id, windows, blackouts, publish)
    values (${input.eventId}, ${input.sessionId}, ${input.accountId},
            ${db.json(windows as never)}, ${db.json(blackouts as never)}, ${publish})
    on conflict (session_id, account_id) do update
      set windows = excluded.windows, blackouts = excluded.blackouts, publish = excluded.publish, updated_at = now()
  `
}

const SKIPS = new Set(['proposal_not_published', 'confirm_public_linkage', 'link_atproto_first', 'nothing_to_withdraw'])

/**
 * After commit: let F reconcile the public record with the saved choice — write it when the
 * proposer opted in, delete a previously published one when they opted out.
 */
export async function reconcileTimePreference(sessionId: string, accountId: string, input: TimePreferenceInput): Promise<AtprotoOutcome> {
  try {
    const result = await publishTimePreference({
      sessionId,
      userId: accountId,
      windows: input.windows,
      blackouts: input.blackouts,
      publish: input.publish,
    })
    return result.record ? { uri: result.record.uri, cid: result.record.cid } : { skipped: input.publish ? 'not_published' : 'app_side' }
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? String((e as { code: unknown }).code) : undefined
    if (code && SKIPS.has(code)) return { skipped: code }
    console.error('[sessions] atproto publishTimePreference failed:', e instanceof Error ? e.message : e)
    return { error: e instanceof Error ? e.message : 'publishTimePreference failed', ...(code ? { code } : {}) }
  }
}
