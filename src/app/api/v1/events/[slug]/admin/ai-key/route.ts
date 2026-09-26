import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { json, jsonError, readJsonObject } from '@/app/api/v1/sessions/_lib/access'
import {
  ANTHROPIC_MODELS,
  CHAT_PROVIDERS,
  DEFAULT_CHAT_MODEL,
  MAX_BASE_URL_CHARS,
  MAX_KEY_CHARS,
  MAX_MODEL_CHARS,
  deploymentChatConfig,
  readEventAiSettings,
  resolveChatConfig,
  testChatConfig,
  type ChatConfig,
  type ChatProviderName,
} from '@/lib/knowledge/chat-provider'
import { last4, seal, secretsAvailable } from '@/lib/secrets/aead'
import { checkOutboundUrl, UnsafeUrlError } from '@/lib/net/safe-fetch'

/**
 * /api/v1/events/[slug]/admin/ai-key  (design 2026-09-25 §2.1, owners and admins)
 *
 * The gathering's own answer-model credential. The key is sealed with AES-256-GCM under the
 * deployment's `APP_SECRETS_KEY` (associated data: the event id) and NEVER returned, logged or
 * echoed — not by GET, not by the connection test, not in an error.
 *
 * GET                  → { secrets_configured, settings: { provider, base_url, model, last4, set_at } | null,
 *                          deployment: { configured, model } , anthropic_models }
 * PUT { provider, key, model?, base_url? } → install or replace it (201/200).
 * DELETE               → remove it; answers fall back to the deployment key, or stop.
 * POST ?action=test    → one-token request to the provider named in the body (or the stored one),
 *                        answering { ok, detail } in the provider's own words.
 *
 * Without `APP_SECRETS_KEY` the deployment cannot store a secret at all: every write answers 503
 * `{ code: 'SecretsUnavailable' }` and GET says `secrets_configured: false`, so the admin page can
 * say "the operator has not configured secret storage" instead of failing.
 */

export const runtime = 'nodejs'

type RouteParams = { params: Promise<{ slug: string }> }

const WRITE_ROLES = ['owner', 'admin'] as const
const KEY_SHAPE = /^[A-Za-z0-9._\-~+/=:]+$/

interface Installed {
  provider: ChatProviderName
  base_url: string | null
  /** Always a concrete model: Anthropic falls back to the default, the compatible adapter requires one. */
  model: string
  key: string
}

/** A field-scoped validation failure, as the routes in this app report them. */
type Invalid = { error: string; field: string }

function isInvalid(v: unknown): v is Invalid {
  return typeof v === 'object' && v !== null && 'error' in v && 'field' in v
}

function validateProvider(value: unknown): ChatProviderName | Invalid {
  if (typeof value !== 'string' || !CHAT_PROVIDERS.includes(value as ChatProviderName)) {
    return { error: `Choose a provider: ${CHAT_PROVIDERS.join(' or ')}`, field: 'provider' }
  }
  return value as ChatProviderName
}

function validateKey(value: unknown): string | Invalid {
  if (typeof value !== 'string') return { error: 'Paste the API key', field: 'key' }
  const key = value.trim()
  if (key.length < 8 || key.length > MAX_KEY_CHARS) return { error: `The key looks wrong: 8 to ${MAX_KEY_CHARS} characters`, field: 'key' }
  if (!KEY_SHAPE.test(key)) return { error: 'The key has characters an API key does not use — paste it again', field: 'key' }
  return key
}

/**
 * The base URL is third-party input: https only, no credentials, no query or fragment, and it must
 * pass the same outbound policy every other organizer-named URL passes. Outside production a
 * loopback origin is accepted only when it is exactly `AI_TEST_BASE_ORIGIN` (the tests' fake
 * provider); `checkOutboundUrl` enforces that, and production has no exemption at all.
 */
function validateBaseUrl(value: unknown, provider: ChatProviderName): string | null | Invalid {
  if (provider === 'anthropic') {
    if (typeof value === 'string' && value.trim()) return { error: 'Anthropic has no base URL to set', field: 'base_url' }
    return null
  }
  if (typeof value !== 'string' || !value.trim()) return { error: 'Give the provider’s base URL, e.g. https://api.openai.com/v1', field: 'base_url' }
  const raw = value.trim()
  if (raw.length > MAX_BASE_URL_CHARS) return { error: `The base URL must be at most ${MAX_BASE_URL_CHARS} characters`, field: 'base_url' }
  let url: URL
  try {
    ;({ url } = checkOutboundUrl(raw))
  } catch (e) {
    const detail = e instanceof UnsafeUrlError ? 'it must be an https URL on a public address' : 'it is not a URL'
    return { error: `That base URL was refused: ${detail}`, field: 'base_url' }
  }
  if (url.search || url.hash) return { error: 'The base URL cannot carry a query or a fragment', field: 'base_url' }
  return url.toString().replace(/\/+$/, '')
}

function validateModel(value: unknown, provider: ChatProviderName): string | Invalid {
  const model = typeof value === 'string' ? value.trim() : ''
  if (provider === 'anthropic') {
    if (!model) return DEFAULT_CHAT_MODEL
    if (!ANTHROPIC_MODELS.some((m) => m.id === model)) return { error: 'Choose one of the models offered', field: 'model' }
    return model
  }
  if (!model) return { error: 'Name the model, as the provider names it', field: 'model' }
  if (model.length > MAX_MODEL_CHARS) return { error: `The model name must be at most ${MAX_MODEL_CHARS} characters`, field: 'model' }
  if (!/^[\x20-\x7e]+$/.test(model)) return { error: 'The model name has characters the provider will not accept', field: 'model' }
  return model
}

/** Everything a write (or a test of an unsaved form) needs, validated. */
function validateBody(body: Record<string, unknown>, opts: { keyRequired: boolean }): Installed | { provider: ChatProviderName; base_url: string | null; model: string; key: null } | Invalid {
  const provider = validateProvider(body.provider)
  if (isInvalid(provider)) return provider
  const baseUrl = validateBaseUrl(body.base_url, provider)
  if (isInvalid(baseUrl)) return baseUrl
  const model = validateModel(body.model, provider)
  if (isInvalid(model)) return model
  if (!opts.keyRequired && (body.key === undefined || body.key === null || body.key === '')) {
    return { provider, base_url: baseUrl, model, key: null }
  }
  const key = validateKey(body.key)
  if (isInvalid(key)) return key
  return { provider, base_url: baseUrl, model, key }
}

export async function GET(request: Request, { params }: RouteParams) {
  const { slug } = await params
  const gate = await requireEventRole(request, slug, WRITE_ROLES)
  if (gate instanceof Response) return gate
  const settings = await readEventAiSettings(gate.event.id)
  const deployment = deploymentChatConfig()
  return json({
    secrets_configured: secretsAvailable(),
    settings: settings
      ? { provider: settings.provider, base_url: settings.base_url, model: settings.model, last4: settings.key_last4, set_at: settings.set_at }
      : null,
    deployment: deployment ? { configured: true, model: deployment.model } : { configured: false },
    anthropic_models: ANTHROPIC_MODELS,
    default_model: DEFAULT_CHAT_MODEL,
  })
}

export async function PUT(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const gate = await requireEventRole(request, slug, WRITE_ROLES)
  if (gate instanceof Response) return gate
  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  const parsed = validateBody(body, { keyRequired: true })
  if (isInvalid(parsed)) return jsonError(400, parsed.error, { field: parsed.field })
  if (!parsed.key) return jsonError(400, 'Paste the API key', { field: 'key' })
  if (!secretsAvailable()) {
    return jsonError(503, 'This server cannot store a key: the operator has not configured secret storage (APP_SECRETS_KEY).', {
      code: 'SecretsUnavailable',
    })
  }

  const ciphertext = seal(parsed.key, gate.event.id)
  const existed = (await readEventAiSettings(gate.event.id)) !== null
  await sql`
    insert into event_ai_settings (event_id, provider, base_url, key_ciphertext, key_last4, model, set_by, set_at)
    values (${gate.event.id}, ${parsed.provider}, ${parsed.base_url}, ${ciphertext}, ${last4(parsed.key)}, ${parsed.model}, ${gate.viewer.accountId}, now())
    on conflict (event_id) do update set
      provider = excluded.provider,
      base_url = excluded.base_url,
      key_ciphertext = excluded.key_ciphertext,
      key_last4 = excluded.key_last4,
      model = excluded.model,
      set_by = excluded.set_by,
      set_at = now()
  `
  console.info(`[knowledge:ai-key] ${existed ? 'replaced' : 'installed'} a ${parsed.provider} key for gathering ${gate.event.id}`)
  const settings = await readEventAiSettings(gate.event.id)
  return json(
    { settings: settings && { provider: settings.provider, base_url: settings.base_url, model: settings.model, last4: settings.key_last4, set_at: settings.set_at } },
    { status: existed ? 200 : 201 },
  )
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  const gate = await requireEventRole(request, slug, WRITE_ROLES)
  if (gate instanceof Response) return gate
  const rows = await sql`delete from event_ai_settings where event_id = ${gate.event.id} returning event_id`
  if (rows.length) console.info(`[knowledge:ai-key] removed the key for gathering ${gate.event.id}`)
  return json({ removed: rows.length > 0, deployment: deploymentChatConfig() ? { configured: true } : { configured: false } })
}

/**
 * POST ?action=test — one token through the chosen adapter. The body may carry an unsaved form
 * (so an organizer can test before storing) or nothing at all (test the stored key). The reply is
 * the provider's own answer or error; the key never appears in it.
 */
export async function POST(request: Request, { params }: RouteParams) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const { slug } = await params
  // Role first: a private gathering answers 404 to a non-member whatever the action says.
  const gate = await requireEventRole(request, slug, WRITE_ROLES)
  if (gate instanceof Response) return gate
  if (new URL(request.url).searchParams.get('action') !== 'test') return jsonError(400, 'Unknown action', { field: 'action' })
  const body = await readJsonObject(request)
  if (body instanceof Response) return body

  let cfg: ChatConfig | null = null
  if (body.provider !== undefined) {
    const parsed = validateBody(body, { keyRequired: false })
    if (isInvalid(parsed)) return jsonError(400, parsed.error, { field: parsed.field })
    if (parsed.key) {
      cfg = { provider: parsed.provider, apiKey: parsed.key, model: parsed.model, baseUrl: parsed.base_url, source: 'gathering' }
    }
  }
  // No key in the body: test what is stored (the gathering's, else the deployment's).
  if (!cfg) cfg = await resolveChatConfig(gate.event.id)
  if (!cfg) return json({ ok: false, detail: 'No key to test: this gathering has none and the server has none.' })
  const result = await testChatConfig(cfg)
  return json({ ok: result.ok, detail: result.detail, source: cfg.source, provider: cfg.provider, model: cfg.model })
}
