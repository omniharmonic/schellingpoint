/**
 * GET /internal/tls-check?domain=<name>   (Caddy on-demand TLS `ask`, container-local)
 *
 * 200 when this stack serves the name, 403 otherwise. Answers from closed sets only
 * (`src/lib/atproto/hosts.ts#allowCertificateFor`): the web host and `www.`, the PDS host, an
 * existing gathering slug under the handle domain, or a handle our PDS vouches for (3 s timeout,
 * then NO). The edge Caddyfile answers 404 for `/internal/*` from the public internet; Caddy asks
 * `http://app:3000` directly. The domain is never logged and never echoed.
 */
import { allowCertificateFor } from '@/lib/atproto/hosts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HEADERS = { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' }

export async function GET(request: Request): Promise<Response> {
  const domain = new URL(request.url).searchParams.get('domain')
  let allowed = false
  try {
    allowed = await allowCertificateFor(domain)
  } catch {
    allowed = false
  }
  return new Response(allowed ? 'ok' : 'no', { status: allowed ? 200 : 403, headers: HEADERS })
}
