import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { CONTENT_TYPES, resolveStoredPath } from '@/lib/storage/files'

/**
 * GET /uploads/<aa>/<sha256>.<ext> — images stored by `POST /api/uploads`. The name is the
 * content hash, so a response never changes: cache it forever. Only the stored path shape
 * is served; anything else (traversal, other files) is a 404.
 */

export const runtime = 'nodejs'

const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain' } })

async function serve(request: Request, params: Promise<{ path: string[] }>, head: boolean): Promise<Response> {
  const { path: segments } = await params
  const resolved = resolveStoredPath(segments ?? [])
  if (!resolved) return notFound()

  let size: number
  try {
    const info = await stat(resolved.file)
    if (!info.isFile()) return notFound()
    size = info.size
  } catch {
    return notFound()
  }

  const etag = `"${segments[1].slice(0, 64)}"`
  const headers = {
    'Content-Type': CONTENT_TYPES[resolved.kind],
    'Content-Length': String(size),
    'Cache-Control': 'public, max-age=31536000, immutable',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'cross-origin',
  }
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
  if (head) return new Response(null, { status: 200, headers })

  const stream = Readable.toWeb(createReadStream(resolved.file)) as ReadableStream<Uint8Array>
  return new Response(stream, { status: 200, headers })
}

export function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return serve(request, params, false)
}

export function HEAD(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return serve(request, params, true)
}
