import { NextResponse, after } from 'next/server'
import { safeReturnPath } from '@/lib/auth-redirect'
import { isAtprotoConfigured, publicUrl } from '@/lib/atproto/config'
import { resolveDidDoc } from '@/lib/atproto/identity'
import { handleCallback } from '@/lib/atproto/oauth'
import { createAtSession } from '@/lib/atproto/session'
import {
  attachGatheringActor,
  describe,
  findOrCreateOAuthAccount,
  isEventOrganizer,
  verifyOAuthState,
  type OAuthStatePayload,
} from '@/lib/atproto/bridge'
import { fetchBskyProfile, importBskyProfile } from '@/lib/atproto/bsky-profile'

/**
 * How long sign-in waits for the profile import before redirecting anyway. Long enough that the
 * common case (one PDS read, one small avatar) lands before onboarding renders; short enough that
 * a slow or dead PDS never holds the redirect. The import always runs to completion in `after()`.
 */
const PROFILE_IMPORT_GRACE_MS = 1500

/**
 * Where the authorization server sends the browser back. Finishes the OAuth exchange,
 * verifies our signed `state`, then:
 *
 *   signin     find the `accounts` row for the DID or create one (kind `oauth`, email
 *              NULL), set `sp_at_session`, redirect to `next`. The network profile import
 *              (PDS record first, AppView fallback; blank or still-synced fields only) starts
 *              at once and finishes in the background: a failed import never fails sign-in.
 *   link       refused — one account = one DID (`?atproto_error=identity_exists`).
 *   gathering  remember the DID as the event's actor; no session change.
 *
 * Failures redirect: `/login?error=atproto` for sign-in (or an unreadable state),
 * otherwise back to `next` with `atproto_error=<code>`.
 */
export const dynamic = 'force-dynamic'

function redirectTo(path: string, setCookie?: string) {
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
    handle = (await fetchBskyProfile(did))?.handle ?? null
  }

  try {
    switch (state.purpose) {
      case 'signin': {
        const account = await findOrCreateOAuthAccount(did, handle)
        // The profile trigger seeds display_name with the handle's first label; that counts as empty.
        const imported = importBskyProfile(account.accountId, did, { placeholderName: handle ? handle.split('.')[0] : null })
          .catch((e) => console.warn('[atproto] profile import failed:', describe(e)))
        after(() => imported)
        const at = await createAtSession({ did, accountId: account.accountId, kind: 'oauth' })
        await Promise.race([imported, new Promise((r) => setTimeout(r, PROFILE_IMPORT_GRACE_MS))])
        return redirectTo(state.next, at.setCookie)
      }
      case 'link':
        return redirectTo(withError(state.next, 'identity_exists'))
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
    return redirectTo(withError(state.next, '1'))
  }
}
