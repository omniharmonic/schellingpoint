import { assertSameOrigin } from '@/lib/auth/viewer'
import { json, jsonError, loadEventAccess, readJsonObject } from '@/app/api/v1/sessions/_lib/access'
import { askAvailability, prepareAsk, sseFrame, validateQuestion, MAX_QUESTION_CHARS } from '@/lib/knowledge/ask'
import { readTier } from '@/lib/knowledge/store'

/**
 * /api/v1/events/[slug]/knowledge/ask  (design §10.3, members)
 *
 * GET  → availability: whether members can ask right now and, if not, why
 *        (`chat` / `embeddings` not configured, `no-transcripts`, `no-embeddings`).
 * POST { question } → server-sent events:
 *        event: sources  data: AskSource[]          (the chunks the answer is built on)
 *        event: notice   data: { message }          (nothing relevant found — no answer follows)
 *        event: delta    data: { text }             (answer text, streamed)
 *        event: done     data: { stop }
 *        event: error    data: { error }
 *        503 `{ code: 'NotAvailable', reason }` when the pipeline is not configured.
 *
 * Members only, organizers included, and only over the transcripts the viewer's reading tier
 * may read (organizers-only transcripts never reach a member's answer, excerpts or sources); the
 * question and those chunks go to the configured providers and nowhere else. Nothing is stored.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

type RouteParams = { params: Promise<{ slug: string }> }

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'private, no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const

async function memberGate(request: Request, slug: string) {
  const access = await loadEventAccess(request, slug)
  if (access instanceof Response) return access
  if (!access.viewer) return jsonError(401, 'Sign in to ask the gathering')
  const tier = readTier(access.role)
  if (!tier) return jsonError(403, 'Ask the gathering is for members of this gathering')
  return { access, tier }
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const gate = await memberGate(request, slug)
  if (gate instanceof Response) return gate
  return json(await askAvailability(gate.access.event.id, gate.tier))
}

export async function POST(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const gate = await memberGate(request, slug)
  if (gate instanceof Response) return gate
  const { access, tier } = gate
  const body = await readJsonObject(request)
  if (body instanceof Response) return body
  const question = validateQuestion(body.question)
  if (!question) return jsonError(400, `Ask a question of 3 to ${MAX_QUESTION_CHARS} characters`, { field: 'question' })

  let prepared: Awaited<ReturnType<typeof prepareAsk>>
  try {
    prepared = await prepareAsk({ id: access.event.id, name: access.event.name, slug: access.event.slug }, question, tier)
  } catch (e) {
    console.error('[knowledge:ask] preparing failed', e instanceof Error ? e.message : e)
    return jsonError(502, 'The embeddings provider did not answer. Try again in a moment.', { code: 'ProviderError' })
  }
  if (prepared.status === 'unavailable') {
    return jsonError(503, 'Ask the gathering is not available on this server yet.', { code: 'NotAvailable', reason: prepared.reason })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => controller.enqueue(encoder.encode(sseFrame(event, data)))
      send('sources', prepared.sources)
      if (prepared.status === 'no-sources') {
        send('notice', { message: 'Nothing in this gathering’s transcripts is close enough to answer that. Try naming a session, a topic or a phrase you remember.' })
        send('done', { stop: 'no-sources' })
        controller.close()
        return
      }
      try {
        for await (const event of prepared.run(request.signal)) {
          if (event.type === 'text') send('delta', { text: event.text })
          else if (event.type === 'error') send('error', { error: event.error })
          else send('done', { stop: event.stopReason ?? 'end_turn' })
        }
      } catch (e) {
        console.error('[knowledge:ask] streaming failed', e instanceof Error ? e.message : e)
        send('error', { error: 'The answer model did not respond. Try again in a moment.' })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, { headers: SSE_HEADERS })
}
