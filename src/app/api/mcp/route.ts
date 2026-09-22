import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { buildMcpServer } from '@/lib/mcp/server'
import { bearerFrom, resolveAssistantToken, touchAssistantToken } from '@/lib/mcp/tokens'
import { takeMcpRequest, MCP_REQUESTS_PER_MINUTE } from '@/lib/mcp/rate-limit'

/**
 * `/api/mcp` — the remote MCP server (Streamable HTTP), so a member can point their own AI
 * assistant at the gatherings they belong to. Read-only; see `src/lib/mcp/server.ts` for the
 * tools and for what never leaves.
 *
 * AUTH. `Authorization: Bearer unc_…`, a token the member mints in Account → Identity
 * (migration 0028). No cookie is read on this route and none is accepted: a browser that happens
 * to hold a session here gains nothing. Without a usable token: 401 with
 * `WWW-Authenticate: Bearer realm="unconference.events", error="invalid_token"`. We deliberately
 * do NOT advertise `resource_metadata` there: there is no authorization server to negotiate with,
 * and a client that starts an OAuth dance would only fail in a more confusing way. Clients that
 * probe `/.well-known/oauth-protected-resource` get a small JSON document (rewritten to
 * `/api/mcp/oauth-protected-resource`) that says as much and points at the help page.
 *
 * CORS. Browser-based clients (claude.ai's custom connectors among them) fetch this endpoint from
 * their own origin, and the list of those origins is neither published nor stable. The route
 * answers `Access-Control-Allow-Origin: *` — safe precisely because the credential is a bearer
 * token in a header and never an ambient cookie: `*` cannot be combined with credentials, so no
 * browser will ever attach one. Nothing here is a mutation, and `assertSameOrigin` is therefore
 * not applied: the CSRF it defends against needs ambient credentials, which this route has none of.
 *
 * LIMITS. 120 requests a minute per token, counted in this process (see ./rate-limit); 429 with
 * `Retry-After` past that. Stateless transport: a fresh server and transport per request, so no
 * state is shared between tokens, and no session id is issued.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version, www-authenticate, retry-after',
  'Access-Control-Max-Age': '86400',
} as const

const BASE_HEADERS = { ...CORS, 'Cache-Control': 'private, no-store' } as const

/** A JSON-RPC-shaped error, so an MCP client renders something better than an HTTP status. */
function rpcError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', ...extra },
  })
}

// Header values are ByteStrings: ASCII only, so no typographic arrow here (the JSON body says it
// properly). A non-latin1 character in a header throws when the Response is constructed.
const WWW_AUTHENTICATE = 'Bearer realm="unconference.events", error="invalid_token", error_description="Mint a token in Account -> Identity"'

function unauthorized(message: string): Response {
  return rpcError(401, -32001, message, { 'WWW-Authenticate': WWW_AUTHENTICATE })
}

async function handle(request: Request): Promise<Response> {
  const raw = bearerFrom(request)
  if (!raw) {
    return unauthorized(
      'This MCP server needs a personal token. Sign in at unconference.events, open Account → Identity → ' +
        '“Connect an AI assistant”, mint a token, and send it as `Authorization: Bearer unc_…`.',
    )
  }
  let principal
  try {
    principal = await resolveAssistantToken(raw)
  } catch (e) {
    console.error('[mcp] resolving the token failed:', e instanceof Error ? e.message : e)
    return rpcError(503, -32003, 'The server could not check your token. Try again in a moment.')
  }
  if (!principal) return unauthorized('That token is not valid, or it has been revoked. Mint a new one in Account → Identity.')

  const budget = takeMcpRequest(principal.tokenId)
  if (!budget.ok) {
    return rpcError(429, -32005, `Too many requests: this token is limited to ${MCP_REQUESTS_PER_MINUTE} a minute.`, {
      'Retry-After': String(budget.retryAfter),
      'X-RateLimit-Limit': String(budget.limit),
      'X-RateLimit-Remaining': '0',
    })
  }
  void touchAssistantToken(principal.tokenId)

  const server = buildMcpServer(principal)
  // Stateless: no session id is generated, so nothing survives the request.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  try {
    await server.connect(transport)
    const response = await transport.handleRequest(request)
    const headers = new Headers(response.headers)
    for (const [k, v] of Object.entries(BASE_HEADERS)) headers.set(k, v)
    headers.set('X-RateLimit-Limit', String(budget.limit))
    headers.set('X-RateLimit-Remaining', String(budget.remaining))
    return new Response(response.body, { status: response.status, headers })
  } catch (e) {
    console.error('[mcp] request failed:', e instanceof Error ? e.message : e)
    return rpcError(500, -32603, 'The MCP server could not handle that request.')
  } finally {
    // The JSON response is fully buffered by the time handleRequest resolves (enableJsonResponse),
    // so closing here frees the per-request server without truncating anything.
    void server.close().catch(() => undefined)
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS })
}

export const POST = handle
export const GET = handle
export const DELETE = handle
