import 'server-only'
/**
 * The answer model, behind one streaming interface (design 2026-09-25 §2.1).
 *
 * Two adapters:
 *   - `anthropic`          — the Anthropic Messages API (what this branch always used).
 *   - `openai-compatible`  — `POST <base_url>/v1/chat/completions`, so OpenAI, OpenRouter,
 *                            Together or a self-hosted server all work with one organizer-supplied
 *                            base URL and key.
 *
 * KEY RESOLUTION, for answers and for summaries alike: the gathering's own key
 * (`event_ai_settings`, sealed under `APP_SECRETS_KEY`) → the deployment's `ANTHROPIC_API_KEY` →
 * none, in which case every caller reports "not configured" and nothing is sent anywhere.
 *
 * Every outbound call goes through the SSRF-safe fetch: an organizer-named base URL is
 * third-party input. The key is never logged, never returned by a route, and never echoed by the
 * connection test; what IS logged is which provider answered (`source provider model`).
 */
import { sql } from '@/lib/db'
import { createSafeFetch } from '@/lib/net/safe-fetch'
import { open as openSealed, SealedValueError, secretsAvailable } from '@/lib/secrets/aead'

export type ChatProviderName = 'anthropic' | 'openai-compatible'
export const CHAT_PROVIDERS: readonly ChatProviderName[] = ['anthropic', 'openai-compatible']

/** Anthropic models the app offers; the compatible adapter takes free text instead. */
export const ANTHROPIC_MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (best answers)' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cheaper, faster)' },
] as const

export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5'
export const MAX_MODEL_CHARS = 100
export const MAX_KEY_CHARS = 500
export const MAX_BASE_URL_CHARS = 300

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

export interface ChatConfig {
  provider: ChatProviderName
  apiKey: string
  model: string
  /** `openai-compatible` only; null for Anthropic (its endpoint is not configurable). */
  baseUrl: string | null
  /** Which key answered — the gathering's own, or the deployment's. Safe to log and to show. */
  source: 'gathering' | 'deployment'
}

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message)
    this.name = 'ChatError'
  }
}

export interface ChatRequest {
  system: string
  user: string
  maxTokens?: number
}

export interface StreamEvent {
  type: 'text' | 'stop' | 'error'
  text?: string
  stopReason?: string | null
  error?: string
}

const fetchProvider = createSafeFetch({ timeoutMs: 180_000, maxBytes: 32 * 1024 * 1024 })
const fetchProviderQuick = createSafeFetch({ timeoutMs: 20_000, maxBytes: 1024 * 1024 })

/* ───────────────────────────── configuration ───────────────────────────── */

/** The deployment-wide Anthropic key, or null. `AI_CHAT_MODEL` overrides the default model. */
export function deploymentChatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return null
  return { provider: 'anthropic', apiKey, model: env.AI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL, baseUrl: null, source: 'deployment' }
}

export interface EventAiSettings {
  provider: ChatProviderName
  base_url: string | null
  model: string | null
  key_last4: string
  set_at: string
  set_by: string | null
}

/** What the organizer sees back: never the key, only its last four characters. */
export async function readEventAiSettings(eventId: string): Promise<EventAiSettings | null> {
  const [row] = await sql<EventAiSettings[]>`
    select provider, base_url, model, key_last4, set_at, set_by from event_ai_settings where event_id = ${eventId}
  `
  return row ?? null
}

/**
 * The gathering's own key, unsealed. Null when none is installed, when the deployment has no
 * `APP_SECRETS_KEY`, or when the sealed value does not open (logged, never fatal: answers fall
 * back to the deployment key rather than failing the page).
 */
export async function eventChatConfig(eventId: string): Promise<ChatConfig | null> {
  if (!secretsAvailable()) return null
  const [row] = await sql<{ provider: ChatProviderName; base_url: string | null; model: string | null; key_ciphertext: Uint8Array }[]>`
    select provider, base_url, model, key_ciphertext from event_ai_settings where event_id = ${eventId}
  `
  if (!row) return null
  let apiKey: string
  try {
    apiKey = openSealed(row.key_ciphertext, eventId)
  } catch (e) {
    console.error(
      `[knowledge:chat] the key stored for gathering ${eventId} could not be opened (${e instanceof SealedValueError ? e.code : 'error'}); falling back to the deployment key`,
    )
    return null
  }
  return {
    provider: row.provider,
    apiKey,
    model: row.model?.trim() || (row.provider === 'anthropic' ? DEFAULT_CHAT_MODEL : ''),
    baseUrl: row.base_url,
    source: 'gathering',
  }
}

/** Gathering key → deployment key → none. The one resolver answers and summaries both use. */
export async function resolveChatConfig(eventId: string | null): Promise<ChatConfig | null> {
  if (eventId) {
    const own = await eventChatConfig(eventId)
    if (own) return own
  }
  return deploymentChatConfig()
}

/** `gathering anthropic claude-sonnet-5` — for logs and organizer UI. Never includes the key. */
export function describeChatConfig(cfg: ChatConfig): string {
  return `${cfg.source} ${cfg.provider} ${cfg.model || '(default model)'}`
}

/* ───────────────────────────── endpoint ───────────────────────────── */

/**
 * `https://api.openai.com/v1` and `https://api.openai.com` both end at
 * `https://api.openai.com/v1/chat/completions`; a base URL that already names the full path is
 * left alone. Anthropic's endpoint is fixed.
 */
export function chatEndpoint(cfg: ChatConfig): string {
  // An Anthropic config never carries a base URL in production: the route refuses one and the
  // table's check constraint forbids it. The tests set it to point the adapter at a fake server, so
  // no test ever calls a real model.
  if (cfg.provider === 'anthropic') return cfg.baseUrl ? `${cfg.baseUrl.replace(/\/+$/, '')}/v1/messages` : ANTHROPIC_MESSAGES_URL
  const base = (cfg.baseUrl ?? '').replace(/\/+$/, '')
  if (!base) throw new ChatError('This gathering’s answer provider has no base URL.')
  if (/\/chat\/completions$/.test(base)) return base
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`
  return `${base}/v1/chat/completions`
}

/* ───────────────────────────── requests ───────────────────────────── */

/** What the compatible provider calls its output cap; reasoning models take the second spelling. */
type TokenField = 'max_tokens' | 'max_completion_tokens'

function requestInit(cfg: ChatConfig, req: ChatRequest, stream: boolean, tokenField: TokenField = 'max_tokens'): RequestInit {
  const maxTokens = req.maxTokens ?? 2048
  if (cfg.provider === 'anthropic') {
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: cfg.model || DEFAULT_CHAT_MODEL, max_tokens: maxTokens, stream, system: req.system, messages: [{ role: 'user', content: req.user }] }),
    }
  }
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      [tokenField]: maxTokens,
      stream,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
  }
}

/**
 * One request, with one retry for the single incompatibility worth handling: OpenAI's reasoning
 * models (and the servers that copy them) answer 400 "Unsupported parameter: 'max_tokens' … use
 * 'max_completion_tokens'". Anything else is reported as the provider said it. When the answer is
 * an error its body has already been read, so callers pass it to `readError` rather than reading
 * the stream twice.
 */
async function send(
  cfg: ChatConfig,
  req: ChatRequest,
  stream: boolean,
  fetcher: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<{ res: Response; errorText: string | null }> {
  const res = await fetcher(chatEndpoint(cfg), { ...requestInit(cfg, req, stream), signal })
  if (res.ok) return { res, errorText: null }
  const errorText = await res.text().catch(() => '')
  if (cfg.provider === 'openai-compatible' && res.status === 400 && /max_tokens/i.test(errorText)) {
    const retry = await fetcher(chatEndpoint(cfg), { ...requestInit(cfg, req, stream, 'max_completion_tokens'), signal })
    if (retry.ok) return { res: retry, errorText: null }
    return { res: retry, errorText: await retry.text().catch(() => '') }
  }
  return { res, errorText }
}

/** The provider's own words about a failure, trimmed. The key never appears in one of these. */
function readError(cfg: ChatConfig, res: Response, text: string): ChatError {
  let detail = ''
  try {
    const payload = JSON.parse(text) as { error?: { message?: string; type?: string } | string; message?: string }
    detail =
      (typeof payload.error === 'string' ? payload.error : payload.error?.message || payload.error?.type) ||
      payload.message ||
      ''
  } catch {
    detail = text.slice(0, 200)
  }
  const where = cfg.provider === 'anthropic' ? 'answer model' : 'answer provider'
  return new ChatError(`${where} failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status)
}

function logUse(cfg: ChatConfig, what: string): void {
  console.info(`[knowledge:chat] ${what} via ${describeChatConfig(cfg)}`)
}

/** One non-streamed completion; returns the concatenated text. */
export async function completeText(cfg: ChatConfig, req: ChatRequest): Promise<{ text: string; stopReason: string | null }> {
  logUse(cfg, 'completion')
  const { res, errorText } = await send(cfg, req, false, fetchProvider)
  if (!res.ok) throw readError(cfg, res, errorText ?? '')
  if (cfg.provider === 'anthropic') {
    const payload = (await res.json()) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string }
    const text = (payload.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
    if (payload.stop_reason === 'refusal') throw new ChatError('The answer model declined this request.', 200)
    return { text, stopReason: payload.stop_reason ?? null }
  }
  const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }> }
  const choice = payload.choices?.[0]
  return { text: choice?.message?.content ?? '', stopReason: choice?.finish_reason ?? null }
}

/** Split an SSE body into `data:` payload strings, in order. */
async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new ChatError('the answer provider returned no body')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at: number
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('')
        if (data) yield data
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/** Streamed completion: text deltas as they arrive, then one `stop` (or `error`). */
export async function* streamText(cfg: ChatConfig, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  logUse(cfg, 'streamed answer')
  const { res, errorText } = await send(cfg, req, true, fetchProvider, signal)
  if (!res.ok) throw readError(cfg, res, errorText ?? '')

  let stopReason: string | null = null
  for await (const data of sseData(res)) {
    if (data === '[DONE]') break
    let event: {
      type?: string
      delta?: { type?: string; text?: string; stop_reason?: string }
      error?: { message?: string } | string
      choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>
    }
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (cfg.provider === 'anthropic') {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        yield { type: 'text', text: event.delta.text }
      } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
        stopReason = event.delta.stop_reason
      } else if (event.type === 'error') {
        yield { type: 'error', error: (typeof event.error === 'string' ? event.error : event.error?.message) ?? 'answer model error' }
        return
      }
      continue
    }
    if (event.error) {
      yield { type: 'error', error: (typeof event.error === 'string' ? event.error : event.error.message) ?? 'answer provider error' }
      return
    }
    const choice = event.choices?.[0]
    if (choice?.delta?.content) yield { type: 'text', text: choice.delta.content }
    if (choice?.finish_reason) stopReason = choice.finish_reason
  }
  if (stopReason === 'refusal' || stopReason === 'content_filter') {
    yield { type: 'error', error: 'The answer model declined this question.' }
    return
  }
  yield { type: 'stop', stopReason }
}

/**
 * "Test connection": one token, non-streamed, through the same adapter and the same SSRF-safe
 * fetch. Reports what the provider said — its answer or its error — and never the key.
 */
export async function testChatConfig(cfg: ChatConfig): Promise<{ ok: boolean; detail: string }> {
  try {
    logUse(cfg, 'connection test')
    const { res, errorText } = await send(cfg, { system: 'Reply with the single word OK.', user: 'ping', maxTokens: 1 }, false, fetchProviderQuick)
    if (!res.ok) return { ok: false, detail: readError(cfg, res, errorText ?? '').message }
    const payload = (await res.json().catch(() => null)) as
      | { content?: Array<{ type: string; text?: string }>; stop_reason?: string; model?: string; choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }> }
      | null
    const text =
      cfg.provider === 'anthropic'
        ? (payload?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
        : (payload?.choices?.[0]?.message?.content ?? '')
    const model = payload?.model ? ` (${String(payload.model).slice(0, 60)})` : ''
    return { ok: true, detail: `The provider answered${model}${text.trim() ? `: “${text.trim().slice(0, 60)}”` : '.'}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message.slice(0, 300) : 'The provider could not be reached.' }
  }
}
