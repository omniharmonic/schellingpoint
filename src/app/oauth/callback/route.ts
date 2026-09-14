import { NextResponse } from 'next/server'
import { safeReturnPath } from '@/lib/auth-redirect'
import { isAtprotoConfigured, publicUrl } from '@/lib/atproto/config'
import { resolveDidDoc } from '@/lib/atproto/identity'
import { handleCallback } from '@/lib/atproto/oauth'
import { createAtSession } from '@/lib/atproto/session'
import {
  attachGatheringActor,
  describe,
  DidAlreadyLinkedError,
  ensureSupabaseUserForDid,
  implicitCallbackPath,
  isEventOrganizer,
  linkDidToProfile,
  mintSupabaseSession,
  verifyOAuthState,
  type OAuthStatePayload,
} from '@/lib/atproto/bridge'
import { importBskyProfileInBackground } from '@/lib/atproto/bsky-profile'

/**
 * Where the authorization server sends the browser back. Finishes the OAuth
 * exchange, verifies our signed `state`, then does one of three things:
 *
 *   signin     find-or-create the Supabase user for the DID, set the
 *              `sp_at_session` cookie, mint a Supabase session and land on
 *              `/auth/callback#access_token=…` like a magic link would.
 *   link       attach the DID to the signed-in member; set the cookie.
 *   gathering  remember the DID as the event's actor; NO user cookie.
 *
 * Every failure redirects: `/login?error=atproto` for sign-in (or when the
 * state cannot be read), otherwise back to `next` with `atproto_error=<code>`.
 */
export const dynamic = 'force-dynamic'

function redirectTo(path: string, setCookie?: string) {
  // Absolute, on the public origin: in loopback mode the callback lives on
  // 127.0.0.1 while the app may be opened on localhost; the cookie is scoped
  // to whichever host served this response, so stay on it.
  const res = NextResponse.redirect(new URL(path, publicUrl()), { status: 302 })
  if (setCookie) res.headers.append('Set-Cookie', setCookie)
  res.headers.set('Cache-Control', 'private, no-store')
  return res
}

function withError(next: string, code: string): string {
  const url = new URL(safeReturnPath(next), 'http://x')
  url.searchParams.set('atproto_error', code)
  return `${url.pathname}${url.search}${url.hash}`
}

export async function GET(request: Request) {
  if (!isAtprotoConfigured()) return redirectTo('/login?error=atproto')

  const params = new URL(request.url).searchParams
  let did: string
  let state: OAuthStatePayload
  try {
    const result = await handleCallback(params)
    did = result.did
    state = verifyOAuthState(result.state)
  } catch (e) {
    console.error('[atproto] callback rejected:', describe(e))
    return redirectTo('/login?error=atproto')
  }

  let handle: string | null = null
  let pds: string | null = null
  try {
    const doc = await resolveDidDoc(did)
    handle = doc.handle
    pds = doc.pds
  } catch (e) {
    console.warn('[atproto] DID document unavailable after callback:', describe(e))
  }

  try {
    switch (state.purpose) {
      case 'signin': {
        const bridged = await ensureSupabaseUserForDid(did, handle)
        importBskyProfileInBackground(bridged.userId, did, { placeholderName: handle ?? did })
        const at = await createAtSession({ did, userId: bridged.userId, kind: 'oauth' })
        const minted = await mintSupabaseSession(bridged.email)
        return redirectTo(implicitCallbackPath(minted, state.next), at.setCookie)
      }
      case 'link': {
        await linkDidToProfile(state.userId!, did, handle)
        importBskyProfileInBackground(state.userId!, did)
        const at = await createAtSession({ did, userId: state.userId!, kind: 'oauth' })
        return redirectTo(state.next, at.setCookie)
      }
      case 'gathering': {
        if (!(await isEventOrganizer(state.userId!, state.eventId!))) {
          return redirectTo(withError(state.next, 'forbidden'))
        }
        await attachGatheringActor({ eventId: state.eventId!, did, handle, pdsUrl: pds, userId: state.userId! })
        return redirectTo(state.next)
      }
    }
  } catch (e) {
    console.error(`[atproto] callback (${state.purpose}) failed:`, describe(e))
    if (state.purpose === 'signin') return redirectTo('/login?error=atproto')
    const code = e instanceof DidAlreadyLinkedError ? 'conflict' : '1'
    return redirectTo(withError(state.next, code))
  }
}
