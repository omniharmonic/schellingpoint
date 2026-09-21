import 'server-only'
/**
 * Embeddings provider adapter (design §10.3). Server-only env:
 *
 *   EMBEDDINGS_PROVIDER=voyage|openai   EMBEDDINGS_MODEL=…   EMBEDDINGS_API_KEY=…
 *
 * Nothing runs without all three: `embeddingsConfig()` is null and every caller no-ops. Requests
 * go to the provider's fixed https endpoint through the SSRF-safe fetch, 32 texts at a time. The
 * provider receives transcript text — the consent checkbox and the Participation settings say so.
 */
import { createSafeFetch } from '@/lib/net/safe-fetch'

export const EMBED_BATCH = 32
/** Longest text sent per item (chunks are ~3,200 chars; this only guards odd inputs). */
const MAX_TEXT_CHARS = 12_000

export type EmbeddingsProvider = 'voyage' | 'openai'

export interface EmbeddingsConfig {
  provider: EmbeddingsProvider
  model: string
  apiKey: string
}

const ENDPOINTS: Record<EmbeddingsProvider, string> = {
  voyage: 'https://api.voyageai.com/v1/embeddings',
  openai: 'https://api.openai.com/v1/embeddings',
}

export function embeddingsConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig | null {
  const provider = env.EMBEDDINGS_PROVIDER?.trim().toLowerCase()
  const model = env.EMBEDDINGS_MODEL?.trim()
  const apiKey = env.EMBEDDINGS_API_KEY?.trim()
  if ((provider !== 'voyage' && provider !== 'openai') || !model || !apiKey) return null
  return { provider, model, apiKey }
}

export class EmbeddingsError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message)
    this.name = 'EmbeddingsError'
  }
}

const fetchProvider = createSafeFetch({ timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 })

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
  error?: { message?: string } | string
  detail?: string
}

async function embedBatch(texts: string[], kind: 'document' | 'query', cfg: EmbeddingsConfig): Promise<number[][]> {
  const body =
    cfg.provider === 'voyage'
      ? { input: texts, model: cfg.model, input_type: kind }
      : { input: texts, model: cfg.model, encoding_format: 'float' }
  const res = await fetchProvider(ENDPOINTS[cfg.provider], {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as EmbeddingsResponse
  if (!res.ok) {
    const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.detail
    throw new EmbeddingsError(`${cfg.provider} embeddings failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status)
  }
  const rows = payload.data ?? []
  if (rows.length !== texts.length) throw new EmbeddingsError(`${cfg.provider} returned ${rows.length} embeddings for ${texts.length} texts`)
  const out: number[][] = new Array(texts.length)
  rows.forEach((row, i) => {
    const at = typeof row.index === 'number' ? row.index : i
    if (!Array.isArray(row.embedding) || !row.embedding.length) throw new EmbeddingsError(`${cfg.provider} returned an empty embedding`)
    out[at] = row.embedding
  })
  return out
}

/**
 * Embed `texts` in order. Returns [] when no provider is configured (the caller decides what a
 * no-op means for it). `kind` lets providers that distinguish documents from queries do so.
 */
export async function embedTexts(texts: readonly string[], kind: 'document' | 'query', cfg: EmbeddingsConfig | null = embeddingsConfig()): Promise<number[][]> {
  if (!cfg || texts.length === 0) return []
  const prepared = texts.map((t) => (t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t))
  const out: number[][] = []
  for (let i = 0; i < prepared.length; i += EMBED_BATCH) {
    out.push(...(await embedBatch(prepared.slice(i, i + EMBED_BATCH), kind, cfg)))
  }
  return out
}
