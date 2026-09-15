import { NextResponse } from 'next/server'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import { isDid, isHandle, HandleNotFoundError } from '@/lib/atproto/identity'
import { authorizeUrl } from '@/lib/atproto/oauth'
import { describe, encodeOAuthState, isEventOrganizer, isOAuthPurpose } from '@/lib/atproto/bridge'
import { getViewer } from '@/lib/auth/viewer'

/**
 * Begin an ATProto OAuth flow — the SECONDARY door (spec §7).
 *
 *   GET /api/atproto/auth/start?handle=<handle|did>&purpose=signin|gathering&next=<path>&event=<eventId>&confirm=1
 *
 * `signin`     REQUIRES `confirm=1`: the member has ticked the hard confirm — "Your
 *              proposals and public actions will be permanently attached to this identity."
 * `link`       refused (409): one account = one DID, and every account already has one.
 * `gathering`  a signed-in organizer (cookie) connects an existing account as the event's
 *              actor instead of the minted one.
 *
 * With `Accept: application/json` the answer is `{ url }` for `window.location.assign`;
 * otherwise a 302 to the authorization server.
 */
export const dynamic = 'force-dynamic'

const PERMANENCE_NOTICE = 'Your proposals and public actions will be permanently attached to this identity.'

function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json')
}

function fail(status: number, error: string, detail?: string) {
  return NextResponse.json({ error, ...(detail ? { detail } : {}) }, { status, headers: { 'Cache-Control': 'private, no-store' } })
}

export async function GET(request: Request) {
  if (!isAtprotoConfigured()) return fail(503, 'atproto_not_configured')

  const url = new URL(request.url)
  const rawHandle = (url.searchParams.get('handle') ?? '').trim().replace(/^@/, '').toLowerCase()
  const purpose = url.searchParams.get('purpose') ?? 'signin'
  const next = url.searchParams.get('next')
  const eventId = url.searchParams.get('event')

  if (!isOAuthPurpose(purpose)) return fail(400, 'invalid_purpose')
  if (purpose === 'link') return fail(409, 'This account already has an identity')
  if (!rawHandle || !(isHandle(rawHandle) || isDid(rawHandle))) {
    return fail(400, 'invalid_handle', 'Enter a handle like you.bsky.social or a DID.')
  }
  if (purpose === 'signin' && url.searchParams.get('confirm') !== '1') {
    return fail(400, 'confirmation_required', `${PERMANENCE_NOTICE} Confirm before continuing.`)
  }

  let userId: string | undefined
  if (purpose === 'gathering') {
    const viewer = await getViewer(request)
    if (!viewer) return fail(401, 'unauthorized')
    userId = viewer.accountId
    if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) return fail(400, 'invalid_event')
    if (!(await isEventOrganizer(userId, eventId))) return fail(403, 'forbidden')
  }

  const state = encodeOAuthState({
    purpose,
    next,
    ...(eventId && purpose === 'gathering' ? { eventId } : {}),
    ...(userId ? { userId } : {}),
  })

  try {
    const authorize = await authorizeUrl(rawHandle, { state })
    if (wantsJson(request)) {
      return NextResponse.json({ url: authorize }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    return NextResponse.redirect(authorize, { status: 302 })
  } catch (e) {
    console.error('[atproto] authorize failed:', describe(e))
    const notFound = e instanceof HandleNotFoundError || /resolve|not found|unknown/i.test(describe(e))
    return fail(
      notFound ? 404 : 502,
      notFound ? 'handle_not_found' : 'authorize_failed',
      notFound ? `We could not find an account for ${rawHandle}.` : 'The account’s server did not respond. Try again.',
    )
  }
}
