import 'server-only'
import { sql } from '@/lib/db'
import { publicTally } from '@/lib/voting/rounds'
import { RoundOpenError } from '@/lib/voting/errors'

export interface EventActivity {
  mode: 'endorsements' | 'results'
  entries: Array<{ id: string; title: string; count: number }>
  votingOpen: boolean
  threshold: number | null
}

/** Only opt-in public endorsements or finalized, k-suppressed results; never live ballots. */
export async function loadEventActivity(eventId: string): Promise<EventActivity> {
  let votingOpen = false
  try {
    const tally = await publicTally(eventId)
    if (tally) {
      const visible = tally.entries.filter(e => !e.suppressed)
      const ids = visible.map(e => e.sessionId)
      const sessions = ids.length ? await sql<{ id: string; title: string }[]>`
        select id, title from sessions where event_id = ${eventId} and id in ${sql(ids)}
          and status in ('approved', 'scheduled') and not coalesce(hidden_by_moderation, false)
      ` : []
      const entries = sessions.flatMap(s => {
        const entry = visible.find(e => e.sessionId === s.id)
        return entry && !entry.suppressed ? [{ ...s, count: entry.votes }] : []
      }).sort((a, b) => b.count - a.count || a.title.localeCompare(b.title)).slice(0, 5)
      return { mode: 'results', entries, votingOpen: false, threshold: tally.k }
    }
  } catch (e) { if (e instanceof RoundOpenError) votingOpen = true; else throw e }
  const entries = await sql<EventActivity['entries']>`
    select s.id, s.title, count(distinct r.did)::int as count
    from sessions s join at_records r on r.record -> 'proposal' ->> 'uri' = s.proposal_uri
      and r.collection = 'schellingpoint.draft.endorsement'
    where s.event_id = ${eventId} and s.status in ('approved', 'scheduled')
      and not coalesce(s.hidden_by_moderation, false)
      and not exists (select 1 from at_repo_status rs where rs.did = r.did and rs.hidden)
    group by s.id, s.title order by count desc, s.title limit 5
  `
  return { mode: 'endorsements', entries, votingOpen, threshold: null }
}
