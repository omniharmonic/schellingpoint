import 'server-only'
/**
 * The answer model (design §10.3): Anthropic Messages API over raw HTTPS through the SSRF-safe
 * fetch. Server-only env: `ANTHROPIC_API_KEY`, `AI_CHAT_MODEL` (default `claude-sonnet-5`).
 * Nothing runs without the key: `chatConfig()` is null and callers answer "not available".
 *
 * Raw HTTP rather than the SDK on purpose: the AppView keeps its outbound calls on one audited
 * fetch, and the SDK is not a dependency of this branch.
 */
import { createSafeFetch } from '@/lib/net/safe-fetch'

export const DEFAULT_CHAT_MODEL = 'claude-sonnet-5'
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

export interface ChatConfig {
  apiKey: string
  model: string
}

export function chatConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig | null {
  const apiKey = env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return null
  return { apiKey, model: env.AI_CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL }
}

export class ChatError extends Error {
  constructor(message: string, public readonly status: number | null = null) {
    super(message)
    this.name = 'ChatError'
  }
}

const fetchAnthropic = createSafeFetch({ timeoutMs: 180_000, maxBytes: 32 * 1024 * 1024 })

export interface ChatRequest {
  system: string
  user: string
  maxTokens?: number
}

function requestInit(cfg: ChatConfig, req: ChatRequest, stream: boolean): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': API_VERSION,
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: req.maxTokens ?? 2048,
      stream,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    }),
  }
}

async function readError(res: Response): Promise<ChatError> {
  const payload = (await res.json().catch(() => ({}))) as { error?: { message?: string; type?: string } }
  const detail = payload.error?.message ?? payload.error?.type
  return new ChatError(`answer model failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`, res.status)
}

/** One non-streamed completion; returns the concatenated text blocks. */
export async function completeText(cfg: ChatConfig, req: ChatRequest): Promise<{ text: string; stopReason: string | null }> {
  const res = await fetchAnthropic(MESSAGES_URL, requestInit(cfg, req, false))
  if (!res.ok) throw await readError(res)
  const payload = (await res.json()) as { content?: Array<{ type: string; text?: string }>; stop_reason?: string }
  const text = (payload.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')
  if (payload.stop_reason === 'refusal') throw new ChatError('The answer model declined this request.', 200)
  return { text, stopReason: payload.stop_reason ?? null }
}

export interface StreamEvent {
  type: 'text' | 'stop' | 'error'
  text?: string
  stopReason?: string | null
  error?: string
}

/** Streamed completion: yields text deltas as they arrive, then one `stop` (or `error`). */
export async function* streamText(cfg: ChatConfig, req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
  const res = await fetchAnthropic(MESSAGES_URL, { ...requestInit(cfg, req, true), signal })
  if (!res.ok) throw await readError(res)
  if (!res.body) throw new ChatError('answer model returned no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let stopReason: string | null = null
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
        if (!data) continue
        let event: {
          type?: string
          delta?: { type?: string; text?: string; stop_reason?: string }
          error?: { message?: string }
        }
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          yield { type: 'text', text: event.delta.text }
        } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason
        } else if (event.type === 'error') {
          yield { type: 'error', error: event.error?.message ?? 'answer model error' }
          return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  if (stopReason === 'refusal') {
    yield { type: 'error', error: 'The answer model declined this question.' }
    return
  }
  yield { type: 'stop', stopReason }
}
