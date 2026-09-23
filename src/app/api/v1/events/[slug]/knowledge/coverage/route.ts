import { sql, tx } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { notify } from '@/lib/notifications'
import { json, jsonError, readJsonObject } from '@/app/api/v1/sessions/_lib/access'
import { coverage, ORGANIZER_ROLES } from '@/lib/knowledge/store'

/**
 * /api/v1/events/[slug]/knowledge/coverage  (design §10.2, organizers)
 *
 * GET  → which approved / scheduled sessions have a transcript, word totals, chunk / embedding
 *        counts, the latest jobs, the themes, and which providers are configured (never keys).
 * POST { action: 'request' } → notify the hosts and co-hosts of transcript-less scheduled
 *        sessions (`admin_announcement`, inside one transaction). A session asked within the last
 *        24 hours is skipped (`sessions.transcripts_requested_at`, migration 0027); the response
 *        counts `sessions` asked, `notified` rows and `skipped` sessions.
 */

export const runtime = 'nodejs'

type RouteParams = { params: Promise<{ slug: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const gate = await requireEventRole(request, slug, ORGANIZER_ROLES)
  if (gate instanceof Response) return gate
  return json(await coverage(gate.event.id))
}

export async function POST(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const gate = await requireEventRole(request, slug, ORGANIZER_ROLES)
  if (gate instanceof Response) return gate
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  if (body.action !== 'request') return jsonError(400, 'Unknown action', { field: 'action' })

  const [event] = await sql<{ name: string; transcripts_enabled: boolean }[]>`select name, transcripts_enabled from events where id = ${gate.event.id}`
  if (!event?.transcripts_enabled) return jsonError(409, 'Transcripts are turned off for this gathering', { code: 'TranscriptsDisabled' })

  const candidates = await sql<{ id: string; title: string; recipients: string[]; recent: boolean }[]>`
    select s.id, s.title,
           array_remove(array_cat(array[s.host_id], coalesce((
             select array_agg(c.user_id) from session_cohosts c where c.session_id = s.id and c.cohost_inactive_at is null
           ), '{}'::uuid[])), null) as recipients,
           (s.transcripts_requested_at is not null and s.transcripts_requested_at > now() - interval '24 hours') as recent
    from sessions s
    where s.event_id = ${gate.event.id} and s.status = 'scheduled'
      and not exists (select 1 from session_transcripts t where t.session_id = s.id and t.replaced_at is null)
    order by s.title
  `
  const sessions = candidates.filter((s) => !s.recent)
  const skipped = candidates.length - sessions.length
  const notified = await tx(async (t) => {
    let count = 0
    for (const s of sessions) {
      if (!s.recipients.length) continue
      await t`update sessions set transcripts_requested_at = now() where id = ${s.id}`
      count += await notify(t, {
        eventId: gate.event.id,
        userIds: s.recipients,
        type: 'admin_announcement',
        title: `Please add a transcript for “${s.title}”`,
        body: `The organizers of ${event.name} are collecting session transcripts so members can search and revisit what was said. Open your session and use “Add transcript” (a .txt, .md, .vtt or .srt file, or pasted text). Only attach one if everyone in the room was told the session was being recorded or transcribed.`,
        actionUrl: `/e/${slug}/sessions/${s.id}`,
        data: { session_id: s.id, kind: 'transcript_request' },
      })
    }
    return count
  })
  return json({ sessions: sessions.length, notified, skipped })
}
