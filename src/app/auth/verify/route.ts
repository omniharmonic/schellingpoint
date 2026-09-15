import { NextResponse } from 'next/server'
import { publicUrl } from '@/lib/atproto/config'
import { createAtSession } from '@/lib/atproto/session'
import { getAccount, maskedEmailForToken, verifyEmailToken } from '@/lib/auth/custody'
import { assertSameOrigin } from '@/lib/auth/viewer'

/**
 * The magic link, in two steps so a mail scanner cannot burn it.
 *
 *   GET  /auth/verify?token=   A confirmation page ("Continue signing in as b•••@example.org") with a
 *                              same-origin form. Does NOT consume the token and says nothing about
 *                              whether it is still valid: a used or expired token renders the same page
 *                              (link-scanning gateways such as Safe Links only ever issue GETs).
 *   POST /auth/verify          Form body `token=`. Same-origin only. Consumes the token (single use),
 *                              opens a session, sets the cookie and 303-redirects to the path the
 *                              sign-in started from. Any failure 303s to `/login?error=link`.
 */
export const dynamic = 'force-dynamic'

function pageHeaders(): Record<string, string> {
  let appOrigin = ''
  try {
    appOrigin = ` ${new URL(publicUrl()).origin}`
  } catch {
    // 'self' alone.
  }
  return { ...PAGE_HEADERS, 'Content-Security-Policy': `${PAGE_HEADERS['Content-Security-Policy']}; form-action 'self'${appOrigin}` }
}

const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'private, no-store',
  // `same-origin`, not `no-referrer`: under `no-referrer` a browser sends `Origin: null` on the form
  // POST and the same-origin check would refuse it. Cross-origin, nothing (and no token) leaks.
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  // form-action also governs the POST's redirect to the app origin; `pageHeaders()` appends it.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function page(token: string, masked: string | null): string {
  const who = masked ? ` as <strong>${escapeHtml(masked)}</strong>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Continue signing in</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; box-sizing: border-box;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 26rem; width: 100%; text-align: center; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1.5rem; overflow-wrap: anywhere; }
  button { font: inherit; font-weight: 600; padding: .75rem 1.5rem; border-radius: .5rem; border: 0; cursor: pointer;
           background: #111827; color: #fff; width: 100%; }
  @media (prefers-color-scheme: dark) { button { background: #f9fafb; color: #111827; } }
  p { font-size: .875rem; opacity: .7; margin: 1rem 0 0; }
</style>
</head>
<body>
<main>
  <h1>Continue signing in${who}</h1>
  <form method="post" action="/auth/verify">
    <input type="hidden" name="token" value="${escapeHtml(token)}">
    <button type="submit">Continue</button>
  </form>
  <p>If you did not ask to sign in, close this page.</p>
</main>
</body>
</html>`
}

function redirect(path: string, setCookie?: string) {
  const res = NextResponse.redirect(new URL(path, publicUrl()), { status: 303 })
  if (setCookie) res.headers.append('Set-Cookie', setCookie)
  res.headers.set('Cache-Control', 'private, no-store')
  res.headers.set('Referrer-Policy', 'no-referrer')
  return res
}

export async function GET(request: Request) {
  const token = (new URL(request.url).searchParams.get('token') ?? '').slice(0, 256)
  let masked: string | null = null
  try {
    masked = await maskedEmailForToken(token)
  } catch {
    // The page works without the address.
  }
  return new Response(page(token, masked), { status: 200, headers: pageHeaders() })
}

export async function POST(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused

  let token = ''
  try {
    const form = await request.formData()
    const value = form.get('token')
    token = typeof value === 'string' ? value : ''
  } catch {
    token = ''
  }
  try {
    const { accountId, nextPath } = await verifyEmailToken(token)
    const account = await getAccount(accountId)
    if (!account) return redirect('/login?error=link')
    const session = await createAtSession({ did: account.did, accountId: account.id, kind: account.kind })
    return redirect(nextPath, session.setCookie)
  } catch (e) {
    if (!(e instanceof Error && e.name === 'AuthError')) {
      console.error('[auth] verify failed:', e instanceof Error ? e.name : 'error')
    }
    return redirect('/login?error=link')
  }
}
