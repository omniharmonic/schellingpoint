import 'server-only'
/**
 * Hourly network-profile refresh for active OAuth accounts (release design §5.2).
 *
 * Who: accounts signed in through the Bluesky door (`kind = 'oauth'`) with an unexpired session
 * created in the last 24 hours (`at_sessions` has no last-seen stamp, so a recent sign-in is the
 * activity signal). Custodial accounts have nothing to import from — their repo is on our PDS and
 * their profile is edited here — so they are never touched.
 *
 * How often: at most once an hour per account, whatever the scheduler does (`profiles.
 * profile_refresh_at` is stamped on every attempt; `profile_synced_at` still marks success).
 *
 * What: `importBskyProfile` without `force` — blank and still-synced fields follow the network,
 * anything edited here stays local (see `bsky-profile.ts`).
 */
import { sql } from '@/lib/db'
import { importBskyProfile } from './bsky-profile'

export interface ProfileRefreshReport {
  /** OAuth accounts that were due and attempted. */
  attempted: number
  /** Attempts where the network profile could be read. */
  fetched: number
  /** Attempts that changed at least one field. */
  updated: number
  /** Whether the time budget ran out before every due account was tried. */
  truncated: boolean
}

export const REFRESH_INTERVAL = '1 hour'
export const ACTIVE_WINDOW = '24 hours'

export async function refreshActiveNetworkProfiles(opts: { limit?: number; timeBudgetMs?: number } = {}): Promise<ProfileRefreshReport> {
  const started = Date.now()
  const budget = opts.timeBudgetMs ?? 240_000
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)
  const due = await sql<{ id: string; did: string }[]>`
    select a.id, a.did
    from accounts a join profiles p on p.id = a.id
    where a.kind = 'oauth'
      and exists (
        select 1 from at_sessions s
        where s.user_id = a.id and s.expires_at > now() and s.created_at > now() - ${ACTIVE_WINDOW}::interval
      )
      and (p.profile_refresh_at is null or p.profile_refresh_at < now() - ${REFRESH_INTERVAL}::interval)
    order by p.profile_refresh_at nulls first
    limit ${limit}
  `
  const report: ProfileRefreshReport = { attempted: 0, fetched: 0, updated: 0, truncated: false }
  for (const account of due) {
    if (Date.now() - started > budget) {
      report.truncated = true
      break
    }
    // Stamp first so a slow or failing read is not retried on the next tick.
    await sql`update profiles set profile_refresh_at = now() where id = ${account.id}`
    report.attempted++
    const result = await importBskyProfile(account.id, account.did)
    if (result.fetched) report.fetched++
    if (result.updated.length) report.updated++
  }
  return report
}
