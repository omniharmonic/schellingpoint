import { NextResponse } from 'next/server'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { publicUrl } from '@/lib/atproto/config'
import {
  listAssistantTokens,
  mintAssistantToken,
  revokeAssistantToken,
  validateTokenName,
  MAX_LIVE_TOKENS,
  MAX_TOKEN_NAME,
} from '@/lib/mcp/tokens'

/**
 * `/api/me/assistant-tokens` — the member's own tokens for the MCP server (`/api/mcp`).
 *
 * GET     → `{ tokens: [{ id, name, created_at, last_used_at, … }], limit, mcp_url }`
 * POST    → `{ token: 'unc_…', assistant_token: { … } }`. The secret is returned exactly once and
 *            is not recoverable afterwards (only its sha256 is stored).
 * DELETE  → `?id=<uuid>` revokes one of the member's own tokens, immediately.
 *
 * Same-origin + a signed-in viewer for every method, GET included: the list says which assistants
 * a person has connected, which is theirs alone.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const

function json(body: unknown, status = 200): Response {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): Response {
  return NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })
}

function mcpUrl(): string {
  try {
    return `${publicUrl()}/api/mcp`
  } catch {
    return '/api/mcp'
  }
}

export async function GET(request: Request) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  return json({ tokens: await listAssistantTokens(viewer.accountId), limit: MAX_LIVE_TOKENS, mcp_url: mcpUrl() })
}

export async function POST(request: Request) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  let body: Record<string, unknown>
  try {
    const raw = await request.text()
    body = raw.trim() ? JSON.parse(raw) : {}
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }
  const name = validateTokenName(body.name)
  if (!name) return jsonError(400, `Name the assistant (1 to ${MAX_TOKEN_NAME} characters)`, { field: 'name' })

  const result = await mintAssistantToken(viewer.accountId, name)
  if ('error' in result) {
    return jsonError(409, `You already have ${MAX_LIVE_TOKENS} connected assistants. Revoke one first.`, { code: 'TokenLimit' })
  }
  return json({ token: result.secret, assistant_token: result.token, mcp_url: mcpUrl() }, 201)
}

export async function DELETE(request: Request) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const id = new URL(request.url).searchParams.get('id') ?? ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return jsonError(400, 'Which token?', { field: 'id' })
  }
  const revoked = await revokeAssistantToken(viewer.accountId, id)
  if (!revoked) return jsonError(404, 'No such token')
  return json({ success: true })
}
