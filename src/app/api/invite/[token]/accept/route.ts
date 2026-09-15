import { tx, dbErrorResponse } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { notify } from '@/lib/notifications'
import { json, jsonError } from '@/app/api/v1/sessions/_lib/access'
import { publishCohostFor } from '@/app/api/v1/sessions/_lib/atproto'

/**
 * POST /api/invite/[token]/accept — the second half of the co-host double opt-in.
 *
 * In one transaction: the invite is claimed (row-locked, pending, unexpired), the acceptor
 * becomes a co-host, and the proposer is notified (`cohost_accepted`). After commit the
 * co-host's own `schellingpoint.draft.cohost` is written into THEIR repository, strongRef'ing
 * the proposal's current record (F) — custodial accounts always, Bluesky-door accounts once
 * they have confirmed public linkage.
 */
class Refusal extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { token } = await params
  if (!/^[0-9a-f]{64}$/.test(token)) return jsonError(404, 'Invite not found')
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return jsonError(401, 'Sign in to accept this invitation')

  let accepted: { sessionId: string; eventSlug: string }
  try {
    accepted = await tx(async (t) => {
      const invites = await t<{ id: string; session_id: string; event_id: string; status: string; expires_at: string }[]>`
        select id, session_id, event_id, status, expires_at
        from cohost_invites where token = ${token}
        for update
      `
      const invite = invites[0]
      if (!invite) throw new Refusal(404, 'Invite not found')

      const sessions = await t<{ host_id: string | null; title: string; slug: string; visibility: string; status: string }[]>`
        select s.host_id, s.title, e.slug, e.visibility, e.status
        from sessions s join events e on e.id = s.event_id
        where s.id = ${invite.session_id} and s.event_id = ${invite.event_id}
      `
      const session = sessions[0]
      if (!session) throw new Refusal(404, 'Session not found')

      const already = await t`select 1 from session_cohosts where session_id = ${invite.session_id} and user_id = ${viewer.accountId}`
      if (already.length) {
        throw new Refusal(409, 'You are already a co-host of this session', { session_id: invite.session_id, event_slug: session.slug })
      }
      if (invite.status !== 'pending') throw new Refusal(409, `This invite has been ${invite.status}`)
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        await t`update cohost_invites set status = 'expired' where id = ${invite.id}`
        return { expired: true as const }
      }
      if (session.host_id === viewer.accountId) throw new Refusal(400, 'You already host this session')

      // A co-host takes part in the gathering: public events admit them as attendees; a private
      // event's organizers must have invited them to the event first.
      const member = await t`select 1 from event_members where event_id = ${invite.event_id} and user_id = ${viewer.accountId}`
      if (!member.length) {
        if (session.visibility !== 'public' || session.status === 'draft') {
          throw new Refusal(403, 'Ask an organizer to invite you to this event before accepting')
        }
        await t`
          insert into event_members (event_id, user_id, role) values (${invite.event_id}, ${viewer.accountId}, 'attendee')
          on conflict (event_id, user_id) do nothing
        `
      }

      const order = await t<{ n: number }[]>`select count(*)::int as n from session_cohosts where session_id = ${invite.session_id}`
      await t`
        insert into session_cohosts (session_id, event_id, user_id, display_order)
        values (${invite.session_id}, ${invite.event_id}, ${viewer.accountId}, ${order[0]?.n ?? 0})
      `
      await t`
        update cohost_invites set status = 'accepted', accepted_by = ${viewer.accountId}, accepted_at = now()
        where id = ${invite.id}
      `
      const acceptor = await t<{ display_name: string | null }[]>`select display_name from profiles where id = ${viewer.accountId}`
      const who = acceptor[0]?.display_name?.trim() || 'Someone'
      await notify(t, {
        eventId: invite.event_id,
        userIds: [session.host_id],
        type: 'cohost_accepted',
        title: 'Co-host invitation accepted',
        body: `${who} is now co-hosting "${session.title}".`,
        actionUrl: `/e/${session.slug}/sessions/${invite.session_id}`,
        data: { session_id: invite.session_id, session_title: session.title },
      })
      return { sessionId: invite.session_id, eventSlug: session.slug }
    }).then((r) => {
      if ('expired' in r) throw new Refusal(410, 'This invite has expired')
      return r
    })
  } catch (e) {
    if (e instanceof Refusal) return jsonError(e.status, e.message, e.extra)
    const mapped = dbErrorResponse(e)
    if (mapped) return mapped
    throw e
  }

  const atproto = await publishCohostFor(accepted.sessionId, viewer.accountId)
  return json({ session_id: accepted.sessionId, event_slug: accepted.eventSlug, atproto })
}
