import { assertSameOrigin } from '@/lib/auth/viewer'
import { dbErrorResponse, sql, tx } from '@/lib/db'
import {
  canSeeSession,
  ensurePublicMembership,
  isUuid,
  json,
  jsonError,
  loadEventAccess,
  readJsonObject,
  sessionRelation,
  type EventAccess,
} from '@/app/api/v1/sessions/_lib/access'
import { publicRsvpFor, retractPublicRsvpFor, type AtprotoOutcome } from '@/app/api/v1/sessions/_lib/atproto'
import { notify } from '@/lib/notifications'

/**
 * PUT    /api/v1/events/[slug]/rsvps/[sessionId]  { public?: boolean } — RSVP (or join the waitlist)
 * DELETE /api/v1/events/[slug]/rsvps/[sessionId]                     — cancel
 *
 * An RSVP is app-side by default (spec §9, §10: a forward-looking co-presence graph).
 * Capacity and waitlist placement are decided by the `assign_rsvp_status` trigger (0005);
 * promotion from the waitlist by `promote_from_waitlist`. Whoever that trigger promotes is
 * told here, in the same transaction — a notification is never emitted from a trigger
 * (spec §9), which is why promotion used to be silent (inventory 8.11 / P2-5). `public: true` additionally
 * writes a `community.lexicon.calendar.rsvp` into the attendee's OWN repo (opt-in, F),
 * and cancelling retracts that record first.
 */
type Params = { params: Promise<{ slug: string; sessionId: string }> }
type SignedIn = EventAccess & { viewer: NonNullable<EventAccess['viewer']> }

interface RsvpState {
  my_rsvp: { status: 'confirmed' | 'waitlist'; waitlist_position: number | null; public: boolean } | null
  rsvp_count: number
  waitlist_count: number
}

async function state(sessionId: string, accountId: string): Promise<RsvpState> {
  const rows = await sql<{ rsvp_count: number; waitlist_count: number; status: string | null; waitlist_position: number | null; rsvp_uri: string | null }[]>`
    select s.rsvp_count, s.waitlist_count, r.status, r.waitlist_position, r.rsvp_uri
    from sessions s
    left join session_rsvps r on r.session_id = s.id and r.user_id = ${accountId} and r.status <> 'cancelled'
    where s.id = ${sessionId}
  `
  const row = rows[0]
  return {
    my_rsvp: row?.status === 'confirmed' || row?.status === 'waitlist'
      ? { status: row.status, waitlist_position: row.waitlist_position, public: !!row.rsvp_uri }
      : null,
    rsvp_count: row?.rsvp_count ?? 0,
    waitlist_count: row?.waitlist_count ?? 0,
  }
}

async function prepare(request: Request, params: Params['params'], removing = false): Promise<{ access: SignedIn; sessionId: string } | Response> {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug, sessionId } = await params
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  if (!access.viewer) return jsonError(401, 'Unauthorized')
  if (!isUuid(sessionId)) return jsonError(404, 'Session not found')
  const rel = await sessionRelation(sql, sessionId, access.event.id, access.viewer.accountId)
  // Removing your own row stays possible after a session leaves public view (e.g. it was declined).
  if (!rel || (!removing && !canSeeSession(rel, access))) return jsonError(404, 'Session not found')
  return { access: access as SignedIn, sessionId }
}

export async function PUT(request: Request, { params }: Params) {
  const ready = await prepare(request, params)
  if (ready instanceof Response) return ready
  const { access, sessionId } = ready
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  const wantsPublic = body.public === true

  const accountId = access.viewer.accountId
  try {
    const joined = await tx(async (t) => {
      const role = await ensurePublicMembership(t, access)
      if (!role) return false
      const existing = await t<{ id: string; status: string }[]>`
        select id, status from session_rsvps where session_id = ${sessionId} and user_id = ${accountId}
      `
      if (existing[0]?.status === 'cancelled') {
        await t`delete from session_rsvps where id = ${existing[0].id}`
      } else if (existing[0]) {
        return true
      }
      // status and waitlist_position are assigned by the trigger.
      await t`
        insert into session_rsvps (event_id, session_id, user_id)
        values (${access.event.id}, ${sessionId}, ${accountId})
      `
      return true
    })
    if (!joined) return jsonError(403, 'Join this event to RSVP', { code: 'not_member' })
  } catch (e) {
    const mapped = dbErrorResponse(e)
    if (mapped) return mapped
    throw e
  }

  let current = await state(sessionId, accountId)
  let atproto: AtprotoOutcome | undefined
  if (wantsPublic) {
    atproto = current.my_rsvp?.status === 'confirmed'
      ? await publicRsvpFor(sessionId, accountId)
      : { skipped: 'not_confirmed' }
    if (atproto.uri) current = await state(sessionId, accountId)
  }
  return json({ ...current, ...(atproto ? { atproto } : {}) })
}

export async function DELETE(request: Request, { params }: Params) {
  const ready = await prepare(request, params, true)
  if (ready instanceof Response) return ready
  const { access, sessionId } = ready
  const accountId = access.viewer.accountId

  const rows = await sql<{ id: string; rsvp_uri: string | null }[]>`
    select id, rsvp_uri from session_rsvps where session_id = ${sessionId} and user_id = ${accountId}
  `
  let atproto: AtprotoOutcome | undefined
  if (rows[0]?.rsvp_uri) {
    // A public "going" must not outlive the RSVP it mirrors: retract it first, keep the RSVP on failure.
    atproto = await retractPublicRsvpFor(sessionId, accountId)
    if (atproto.error) {
      return jsonError(502, 'Your public RSVP could not be retracted from your repository. Try again.', { atproto })
    }
  }
  if (rows[0]) {
    await tx(async (t) => {
      const waiting = await t<{ user_id: string }[]>`
        select user_id from session_rsvps
        where session_id = ${sessionId} and status = 'waitlist' and user_id <> ${accountId}
      `
      await t`delete from session_rsvps where id = ${rows[0].id} and user_id = ${accountId}`
      if (!waiting.length) return
      // `promote_from_waitlist` has already run (AFTER DELETE, same transaction): whoever
      // was on the waitlist and now holds a seat was promoted by this cancellation.
      const promoted = await t<{ user_id: string }[]>`
        select user_id from session_rsvps
        where session_id = ${sessionId} and status = 'confirmed'
          and user_id in ${t(waiting.map((w) => w.user_id))}
      `
      if (!promoted.length) return
      const [session] = await t<{ title: string }[]>`select title from sessions where id = ${sessionId}`
      await notify(t, {
        eventId: access.event.id,
        userIds: promoted.map((p) => p.user_id),
        type: 'rsvp_promoted',
        title: `You have a place in "${session?.title ?? 'a session'}"`,
        body: 'A place opened up and you were next on the waitlist. You are confirmed.',
        actionUrl: `/e/${access.event.slug}/sessions/${sessionId}`,
        data: { session_id: sessionId },
      })
    })
  }
  return json({ ...(await state(sessionId, accountId)), ...(atproto ? { atproto } : {}) })
}
