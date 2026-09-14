import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import { isDid, isHandle, HandleNotFoundError } from '@/lib/atproto/identity'
import { authorizeUrl } from '@/lib/atproto/oauth'
import { describe, encodeOAuthState, isEventOrganizer, isOAuthPurpose } from '@/lib/atproto/bridge'

/**
 * Begin an ATProto OAuth flow.
 *
 *   GET /api/atproto/auth/start?handle=<handle|did>&purpose=signin|link|gathering&next=<path>&event=<eventId>
 *
 * `signin` needs no auth. `link` and `gathering` need a Supabase bearer
 * token — a browser navigation cannot carry one, so client JS calls this
 * with `fetch` (`Accept: application/json`) and gets `{ url }` back to
 * `window.location.assign`. Without that header the response is a 302 to
 * the authorization server, which is what a plain link or a test wants.
 */
export const dynamic = 'force-dynamic'

function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json')
}

function fail(request: Request, status: number, error: string, detail?: string) {
  return NextResponse.json({ error, ...(detail ? { detail } : {}) }, { status })
}

export async function GET(request: Request) {
  if (!isAtprotoConfigured()) return fail(request, 503, 'atproto_not_configured')

  const url = new URL(request.url)
  const rawHandle = (url.searchParams.get('handle') ?? '').trim().replace(/^@/, '').toLowerCase()
  const purpose = url.searchParams.get('purpose') ?? 'signin'
  const next = url.searchParams.get('next')
  const eventId = url.searchParams.get('event')

  if (!rawHandle || !(isHandle(rawHandle) || isDid(rawHandle))) {
    return fail(request, 400, 'invalid_handle', 'Enter a handle like you.bsky.social or a DID.')
  }
  if (!isOAuthPurpose(purpose)) return fail(request, 400, 'invalid_purpose')

  let userId: string | undefined
  if (purpose === 'link' || purpose === 'gathering') {
    const user = await getUserFromRequest(request)
    if (!user) return fail(request, 401, 'unauthorized')
    userId = user.id
  }
  if (purpose === 'gathering') {
    if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) return fail(request, 400, 'invalid_event')
    if (!(await isEventOrganizer(userId!, eventId))) return fail(request, 403, 'forbidden')
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
      request,
      notFound ? 404 : 502,
      notFound ? 'handle_not_found' : 'authorize_failed',
      notFound ? `We could not find an account for ${rawHandle}.` : 'The account’s server did not respond. Try again.',
    )
  }
}
