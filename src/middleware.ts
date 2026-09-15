import { NextResponse, type NextRequest } from 'next/server'
import { resolveGatheringHost } from '@/lib/events/hosts'

/**
 * Gathering subdomains: `<slug>.<PDS_HANDLE_DOMAIN>/<path>` renders `/e/<slug>/<path>`.
 *
 * Node.js runtime (stable in Next 15.5) so the host can be resolved against Postgres. The
 * apex, `www`/`pds`, and every non-page path pass straight through; a label that is not a
 * gathering redirects to the apex home. `/.well-known/*` and `/xrpc/*` are never touched —
 * on a gathering host they belong to the PDS (handle resolution).
 */

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/|favicon\\.ico$|icon\\.svg$).*)'],
}

/** App paths that mean the same thing on every host (APIs, auth, assets, site pages). */
const PASS_THROUGH = [
  '/.well-known/', '/xrpc/', '/api/', '/uploads/', '/auth/', '/oauth/', '/internal/', '/e/', '/fonts/',
  '/login', '/account', '/create', '/events', '/invite', '/privacy', '/terms', '/codeofconduct',
]

function passesThrough(pathname: string): boolean {
  if (pathname === '/.well-known' || pathname === '/xrpc' || pathname === '/api' || pathname === '/e') return true
  if (PASS_THROUGH.some((prefix) => (prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(`${prefix}/`)))) {
    return true
  }
  // Public files (`/logo.png`, `/robots.txt`): a last segment with an extension.
  return /\/[^/]+\.[a-z0-9]{2,5}$/i.test(pathname)
}

function apexUrl(request: NextRequest): URL | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim()
  if (!configured) return null
  try {
    const apex = new URL(configured)
    const requested = (request.headers.get('host') ?? '').toLowerCase()
    if (apex.host.toLowerCase() === requested) return null
    return new URL('/', apex)
  } catch {
    return null
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (passesThrough(pathname)) return NextResponse.next()

  let resolution
  try {
    resolution = await resolveGatheringHost(request.headers.get('host'))
  } catch (e) {
    console.error('[middleware] gathering host lookup failed:', e instanceof Error ? e.message : e)
    return NextResponse.next()
  }

  if (resolution.kind === 'gathering') {
    const url = request.nextUrl.clone()
    url.pathname = `/e/${resolution.slug}${pathname === '/' ? '' : pathname}`
    return NextResponse.rewrite(url)
  }
  if (resolution.kind === 'unknown') {
    const apex = apexUrl(request)
    return apex ? NextResponse.redirect(apex, 307) : NextResponse.rewrite(new URL('/', request.url))
  }
  return NextResponse.next()
}
