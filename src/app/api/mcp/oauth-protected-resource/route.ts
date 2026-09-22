import { publicUrl } from '@/lib/atproto/config'

/**
 * RFC 9728 protected-resource metadata for `/api/mcp`, served at
 * `/.well-known/oauth-protected-resource` through the rewrite in next.config.js (a path segment
 * starting with a dot is not a route folder in the app router).
 *
 * There is no authorization server: an assistant authenticates with a personal token the member
 * mints in Account → Identity. `authorization_servers` is therefore empty, and
 * `resource_documentation` points at the page that explains how to get one — so a client that
 * probes this endpoint learns what to do instead of receiving the app's HTML 404.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const base = publicUrl()
  return Response.json(
    {
      resource: `${base}/api/mcp`,
      authorization_servers: [],
      bearer_methods_supported: ['header'],
      scopes_supported: ['read'],
      resource_name: 'unconference.events',
      resource_documentation: `${base}/help/assistants`,
    },
    {
      headers: {
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
      },
    },
  )
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Max-Age': '86400',
    },
  })
}
