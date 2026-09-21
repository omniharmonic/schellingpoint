import { requireEventRole } from '@/lib/auth/viewer'
import { jsonError } from '@/app/api/v1/sessions/_lib/access'
import { buildCorpusExport, logExport } from '@/lib/knowledge/export'
import { ORGANIZER_ROLES } from '@/lib/knowledge/store'

/**
 * GET /api/v1/events/[slug]/knowledge/export  (design §10.2, organizers)
 *
 * The corpus zip: corpus.jsonl, sessions.json, README.md, transcripts/*.md. Works without any AI
 * provider. Every download is logged (server log line + `knowledge_exports` row). Members-only
 * material: the response is never cacheable.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteParams = { params: Promise<{ slug: string }> }

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const gate = await requireEventRole(request, slug, ORGANIZER_ROLES)
  if (gate instanceof Response) return gate
  try {
    const result = await buildCorpusExport(gate.event.id)
    await logExport(gate.event.id, gate.viewer.accountId, result)
    const stamp = new Date().toISOString().slice(0, 10)
    return new Response(new Uint8Array(result.zip), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${slug}-corpus-${stamp}.zip"`,
        'Content-Length': String(result.zip.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Corpus-Sessions': String(result.sessionCount),
        'X-Corpus-Chunks': String(result.chunkCount),
      },
    })
  } catch (e) {
    console.error('[knowledge:export] failed', e instanceof Error ? e.message : e)
    return jsonError(500, 'Could not build the corpus export')
  }
}
