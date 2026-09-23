import { tx, dbErrorResponse } from '@/lib/db'
import { assertSameOrigin, getViewer } from '@/lib/auth/viewer'
import { notify } from '@/lib/notifications'
import { json, jsonError } from '@/app/api/v1/sessions/_lib/access'

/**
 * POST /api/invite/[token]/decline — the other answer to a co-host invitation.
 *
 * Until now an invite could only be accepted or left to expire, so `cohost_declined` could
 * never fire (inventory 4.4). Declining closes the link and tells the proposer, so they can
 * ask someone else instead of waiting out the seven days.
 *
 * Signing in is not required: whoever holds the link may decline it, and an invite names
 * nobody. When a signed-in person declines, `declined_by` records who, which is the same
 * fact `accepted_by` records on the other branch. The notification never carries an
 * address, and names a person only when they were signed in.
 */
class Refusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { token } = await params
  if (!/^[0-9a-f]{64}$/.test(token)) return jsonError(404, 'Invite not found')
  const viewer = await getViewer(request)

  try {
    const outcome = await tx(async (t) => {
      const invites = await t<{ id: string; session_id: string; event_id: string; status: string; expires_at: string }[]>`
        select id, session_id, event_id, status, expires_at from cohost_invites where token = ${token} for update
      `
      const invite = invites[0]
      if (!invite) throw new Refusal(404, 'Invite not found')
      if (invite.status === 'declined') return { alreadyDone: true as const }
      if (invite.status !== 'pending') throw new Refusal(409, `This invite has been ${invite.status}`)
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        await t`update cohost_invites set status = 'expired' where id = ${invite.id}`
        throw new Refusal(410, 'This invite has expired')
      }

      const sessions = await t<{ host_id: string | null; title: string; slug: string }[]>`
        select s.host_id, s.title, e.slug
        from sessions s join events e on e.id = s.event_id
        where s.id = ${invite.session_id} and s.event_id = ${invite.event_id}
      `
      const session = sessions[0]
      if (!session) throw new Refusal(404, 'Session not found')

      await t`
        update cohost_invites
        set status = 'declined', declined_at = now(), declined_by = ${viewer?.accountId ?? null}
        where id = ${invite.id}
      `

      let who = 'Someone'
      if (viewer) {
        const [profile] = await t<{ display_name: string | null }[]>`select display_name from profiles where id = ${viewer.accountId}`
        who = profile?.display_name?.trim() || 'Someone'
      }
      await notify(t, {
        eventId: invite.event_id,
        userIds: [session.host_id],
        type: 'cohost_declined',
        title: 'Co-host invitation declined',
        body: `${who} will not be co-hosting "${session.title}". The invite link is closed; you can create another.`,
        actionUrl: `/e/${session.slug}/sessions/${invite.session_id}`,
        data: { session_id: invite.session_id, session_title: session.title },
      })
      return { alreadyDone: false as const }
    })
    return json({ declined: true, already: outcome.alreadyDone })
  } catch (e) {
    if (e instanceof Refusal) return jsonError(e.status, e.message)
    const mapped = dbErrorResponse(e)
    if (mapped) return mapped
    throw e
  }
}
