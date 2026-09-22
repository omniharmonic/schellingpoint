import 'server-only'
/**
 * Embeddings provider adapter (design §10.3). Server-only env:
 *
 *   EMBEDDINGS_PROVIDER=local|voyage|openai|none   EMBEDDINGS_MODEL=…   EMBEDDINGS_API_KEY=…
 *   EMBEDDINGS_CACHE_DIR=…   EMBEDDINGS_OFFLINE=1
 *
 * `local` is the default and costs nothing: Transformers.js runs `Xenova/bge-small-en-v1.5`
 * (384 dims, q8-quantized ONNX) on the CPU of this box, so the corpus is searchable with no API
 * key and no transcript text ever leaving the server. `voyage` and `openai` stay opt-in: they need
 * a model and a key, and their requests go to the provider's fixed https endpoint through the
 * SSRF-safe fetch. `none` turns embeddings off entirely (every caller no-ops, as before).
 *
 * The identifier written to `transcript_chunks.embedding_model` is `cfg.storedModel`
 * (`local:<model>` for the local provider, the bare model name for the hosted ones). Ranking
 * filters on it, so changing provider *or* model retires the old vectors instead of mixing
 * incomparable spaces; the embed job re-embeds on the next run.
 */
import path from 'node:path'
import { createSafeFetch } from '@/lib/net/safe-fetch'

/** Texts per request for the hosted providers. */
export const EMBED_BATCH = 32
/** Texts per forward pass for the on-box model (sequential batches; keeps peak memory small). */
export const LOCAL_EMBED_BATCH = 16
/** Longest text sent per item (chunks are ~3,200 chars; this only guards odd inputs). */
const MAX_TEXT_CHARS = 12_000

export type EmbeddingsProvider = 'local' | 'voyage' | 'openai'

export const DEFAULT_LOCAL_MODEL = 'Xenova/bge-small-en-v1.5'

export interface EmbeddingsConfig {
  provider: EmbeddingsProvider
  /** Model name as its provider knows it. */
  model: string
  /** What goes into `transcript_chunks.embedding_model`. Namespaced so spaces never mix. */
  storedModel: string
  /** null for the local provider. */
  apiKey: string | null
}

const ENDPOINTS: Record<'voyage' | 'openai', string> = {
  voyage: 'https://api.voyageai.com/v1/embeddings',
  openai: 'https://api.openai.com/v1/embeddings',
}

export function embeddingsConfig(env: NodeJS.ProcessEnv = process.env): EmbeddingsConfig | null {
  const provider = env.EMBEDDINGS_PROVIDER?.trim().toLowerCase() || 'local'
  if (provider === 'none' || provider === 'off' || provider === 'disabled') return null
  if (provider === 'local') {
    const model = env.EMBEDDINGS_MODEL?.trim() || DEFAULT_LOCAL_MODEL
    return { provider: 'local', model, storedModel: `local:${model}`, apiKey: null }
  }
  if (provider !== 'voyage' && provider !== 'openai') return null
  const model = env.EMBEDDINGS_MODEL?.trim()
  const apiKey = env.EMBEDDINGS_API_KEY?.trim()
  if (!model || !apiKey) return null
  return { provider, model, storedModel: model, apiKey }
}

/** How many texts go into one request / forward pass for this provider. */
export function embedBatchSize(cfg: EmbeddingsConfig | null): number {
  return cfg?.provider === 'local' ? LOCAL_EMBED_BATCH : EMBED_BATCH
}

/** Where Transformers.js keeps the model files. Prefetched into the image at build time. */
export function embeddingsCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.EMBEDDINGS_CACHE_DIR?.trim()
  return dir || path.join(process.cwd(), '.models')
}

/** With this set the runtime never reaches the Hugging Face hub: the cache must already hold the model. */
export function embeddingsOffline(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.EMBEDDINGS_OFFLINE?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export class EmbeddingsError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message)
    this.name = 'EmbeddingsError'
  }
}

/* ------------------------------------------------------------------ hosted providers */

const fetchProvider = createSafeFetch({ timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 })

interface EmbeddingsResponse {
  data?: Array<{ index?: number; embedding?: number[] }>
  error?: { message?: string } | string
  detail?: string
}

async function embedHostedBatch(texts: string[], kind: 'document' | 'query', cfg: EmbeddingsConfig): Promise<number[][]> {
  const provider = cfg.provider as 'voyage' | 'openai'
  const body =
    provider === 'voyage'
      ? { input: texts, model: cfg.model, input_type: kind }
      : { input: texts, model: cfg.model, encoding_format: 'float' }
  const res = await fetchProvider(ENDPOINTS[provider], {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as EmbeddingsResponse
  if (!res.ok) {
    const detail = typeof payload.error === 'string' ? payload.error : payload.error?.message ?? payload.detail
    throw new EmbeddingsError(`${provider} embeddings failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status)
  }
  const rows = payload.data ?? []
  if (rows.length !== texts.length) throw new EmbeddingsError(`${provider} returned ${rows.length} embeddings for ${texts.length} texts`)
  const out: number[][] = new Array(texts.length)
  rows.forEach((row, i) => {
    const at = typeof row.index === 'number' ? row.index : i
    if (!Array.isArray(row.embedding) || !row.embedding.length) throw new EmbeddingsError(`${provider} returned an empty embedding`)
    out[at] = row.embedding
  })
  return out
}

/* ---------------------------------------------------------------- the local provider */

/**
 * BGE is trained for asymmetric retrieval: the model card asks for this instruction on the
 * *query* side only (passages are embedded bare). Other local models get the text unchanged.
 */
const BGE_QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: '

function prepareLocal(text: string, kind: 'document' | 'query', model: string): string {
  return kind === 'query' && /bge/i.test(model) ? `${BGE_QUERY_INSTRUCTION}${text}` : text
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][]; dispose?: () => void }>

/** One pipeline per process, loaded on first use. `null` while unloaded or after a failed load. */
let extractorPromise: Promise<FeatureExtractor> | null = null
let extractorModel: string | null = null
let extractorReady = false
let extractorError: string | null = null

/** Whether the on-box model is loaded, and the last load failure if there was one. Never throws. */
export function localModelState(): { loaded: boolean; loading: boolean; error: string | null } {
  return { loaded: extractorReady, loading: extractorPromise !== null && !extractorReady, error: extractorError }
}

/** Test/ops hook: drop the cached pipeline so the next call reloads it. */
export function resetLocalModel(): void {
  extractorPromise = null
  extractorModel = null
  extractorReady = false
  extractorError = null
}

async function localExtractor(model: string): Promise<FeatureExtractor> {
  if (extractorModel !== model) resetLocalModel()
  if (!extractorPromise) {
    extractorModel = model
    extractorPromise = (async () => {
      // Imported lazily: onnxruntime-node is a native module, and a server that never embeds
      // (or runs with EMBEDDINGS_PROVIDER=none) must not pay for loading it.
      const { env, pipeline } = await import('@huggingface/transformers')
      const cacheDir = embeddingsCacheDir()
      env.cacheDir = cacheDir
      // Transformers.js lays both of these out as <dir>/<model id>/<file>, so the prefetched
      // cache answers either lookup — with or without the hub.
      env.localModelPath = cacheDir
      env.allowLocalModels = true
      if (embeddingsOffline()) env.allowRemoteModels = false
      const extractor = (await pipeline('feature-extraction', model, { dtype: 'q8' })) as unknown as FeatureExtractor
      extractorReady = true
      extractorError = null
      return extractor
    })().catch((e: unknown) => {
      // A failed load is a provider status, not a crash: forget it so a later call can retry.
      extractorError = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : String(e).slice(0, 300)
      extractorPromise = null
      extractorReady = false
      throw new EmbeddingsError(`local embeddings model "${model}" failed to load: ${extractorError}`)
    })
  }
  return extractorPromise
}

async function embedLocalBatch(texts: string[], kind: 'document' | 'query', cfg: EmbeddingsConfig): Promise<number[][]> {
  const extract = await localExtractor(cfg.model)
  const output = await extract(
    texts.map((t) => prepareLocal(t, kind, cfg.model)),
    { pooling: 'mean', normalize: true },
  )
  const rows = output.tolist()
  output.dispose?.()
  if (!Array.isArray(rows) || rows.length !== texts.length) {
    throw new EmbeddingsError(`local model returned ${Array.isArray(rows) ? rows.length : 0} embeddings for ${texts.length} texts`)
  }
  for (const row of rows) {
    if (!Array.isArray(row) || !row.length) throw new EmbeddingsError('local model returned an empty embedding')
  }
  return rows
}

/* ----------------------------------------------------------------------- the adapter */

/**
 * Embed `texts` in order, one batch at a time. Returns [] when no provider is configured (the
 * caller decides what a no-op means for it). `kind` lets providers that distinguish documents
 * from queries do so.
 */
export async function embedTexts(
  texts: readonly string[],
  kind: 'document' | 'query',
  cfg: EmbeddingsConfig | null = embeddingsConfig(),
): Promise<number[][]> {
  if (!cfg || texts.length === 0) return []
  const prepared = texts.map((t) => (t.length > MAX_TEXT_CHARS ? t.slice(0, MAX_TEXT_CHARS) : t))
  const size = embedBatchSize(cfg)
  const out: number[][] = []
  for (let i = 0; i < prepared.length; i += size) {
    const batch = prepared.slice(i, i + size)
    out.push(...(cfg.provider === 'local' ? await embedLocalBatch(batch, kind, cfg) : await embedHostedBatch(batch, kind, cfg)))
  }
  return out
}
