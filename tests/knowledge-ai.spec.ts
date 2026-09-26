import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, withServerOnlyShim, TEST_BASE_URL, type TestAccount, type TestGathering } from './helpers/gathering'

// Per-gathering answer keys and the two chat adapters (design 2026-09-25 §2.1–2.2):
//   1. the sealing (`src/lib/secrets/aead.ts`) — round trip, tamper, wrong owner, fail closed
//   2. both adapters against a fake HTTP provider, in both stream shapes
//   3. the ai-key route's authz and validation, and that no route ever returns the key
//   4. the Ask page's empty states and installing a key through the admin UI
//
// No test ever calls a real provider: the fake server runs on `AI_TEST_BASE_ORIGIN` (unset by
// default; the SSRF layer accepts that one http origin outside production and nothing else).
loadEnvConfig(process.cwd(), true)

const base = TEST_BASE_URL
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const configured = Boolean(ownerUrl && (process.env.PDS_INTERNAL_URL || process.env.PDS_URL) && process.env.PDS_ADMIN_PASSWORD)
const deploymentKey = Boolean(process.env.ANTHROPIC_API_KEY)
/** The origin the app is allowed to treat as a provider in development. Tests bind exactly it. */
const testOrigin = (process.env.AI_TEST_BASE_ORIGIN || '').replace(/\/+$/, '')

type Aead = typeof import('../src/lib/secrets/aead')
type Chat = typeof import('../src/lib/knowledge/chat-provider')

const aead = () =>
  withServerOnlyShim(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../src/lib/secrets/aead') as Aead
  })

const chat = () =>
  withServerOnlyShim(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('../src/lib/knowledge/chat-provider') as Chat
  })

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function api(path: string, init: { method?: string; cookie?: string; json?: unknown; origin?: string } = {}) {
  const headers: Record<string, string> = { origin: init.origin ?? base }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${base}${path}`, { method: init.method ?? 'GET', headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })
}

async function jsonOf(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

/* ───────────────────────────── the fake provider ───────────────────────────── */

interface FakeProvider {
  origin: string
  /** Every request seen: method, path, the authorization / x-api-key header, and the body. */
  hits: Array<{ path: string; auth: string; body: any }>
  /**
   * Next reply: 'ok' streams or answers, 'unauthorized' answers 401 with a provider-shaped error,
   * 'needs-max-completion-tokens' refuses `max_tokens` the way OpenAI's reasoning models do.
   */
  mode: 'ok' | 'unauthorized' | 'needs-max-completion-tokens'
  /** What a non-streamed answer says (the themes pass wants JSON). */
  reply: string
  close(): Promise<void>
}

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Compost "}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"heaps [Session · 00:10]."}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
]

const OPENAI_SSE = [
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"Tool "}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"sharing [Session · 00:45]."},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
]

async function startFakeProvider(port = 0): Promise<FakeProvider> {
  const state: FakeProvider = { origin: '', hits: [], mode: 'ok', reply: 'OK', close: async () => {} }
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      let body: any = null
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')
      } catch {
        body = null
      }
      const path = req.url ?? ''
      state.hits.push({ path, auth: String(req.headers.authorization ?? req.headers['x-api-key'] ?? ''), body })
      if (state.mode === 'unauthorized') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }))
        return
      }
      if (state.mode === 'needs-max-completion-tokens' && body && 'max_tokens' in body) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' },
          }),
        )
        return
      }
      const anthropic = path.includes('/v1/messages')
      if (body?.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const frame of anthropic ? ANTHROPIC_SSE : OPENAI_SSE) res.write(frame)
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          anthropic
            ? { model: body?.model, content: [{ type: 'text', text: state.reply }], stop_reason: 'end_turn' }
            : { model: body?.model, choices: [{ message: { role: 'assistant', content: state.reply }, finish_reason: 'stop' }] },
        ),
      )
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  state.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()))
  return state
}

/* ───────────────────────────── 1. sealing ───────────────────────────── */

test.describe('secrets: AES-256-GCM sealing', () => {
  const key = randomBytes(32).toString('base64')
  const other = randomBytes(32).toString('base64')
  const eventId = '11111111-2222-3333-4444-555555555555'
  const secret = 'sk-ant-test-0123456789abcdef'

  test('a sealed key round-trips, differs every time, and never contains the plaintext', async () => {
    await withEnv({ APP_SECRETS_KEY: key }, async () => {
      const { seal, open, last4, secretsAvailable } = await aead()
      expect(secretsAvailable()).toBe(true)
      const a = seal(secret, eventId)
      const b = seal(secret, eventId)
      expect(a.equals(b)).toBe(false) // fresh nonce each time
      expect(a.toString('utf8')).not.toContain('sk-ant')
      expect(a.toString('latin1')).not.toContain(secret)
      expect(open(a, eventId)).toBe(secret)
      expect(open(b, eventId)).toBe(secret)
      expect(last4(secret)).toBe('cdef')
    })
  })

  test('a tampered byte anywhere fails to open', async () => {
    await withEnv({ APP_SECRETS_KEY: key }, async () => {
      const { seal, open } = await aead()
      const sealed = seal(secret, eventId)
      for (const at of [0, 3, 20, sealed.length - 1]) {
        const bad = Buffer.from(sealed)
        bad[at] = bad[at] ^ 0xff
        expect(() => open(bad, eventId)).toThrow(/could not be opened/)
      }
      expect(() => open(sealed.subarray(0, 10), eventId)).toThrow(/too short/)
    })
  })

  test('the wrong event id, or the wrong deployment key, fails to open', async () => {
    const sealed = await withEnv({ APP_SECRETS_KEY: key }, async () => (await aead()).seal(secret, eventId))
    await withEnv({ APP_SECRETS_KEY: key }, async () => {
      const { open } = await aead()
      expect(() => open(sealed, '99999999-2222-3333-4444-555555555555')).toThrow(/authentication failed/)
      expect(open(sealed, eventId)).toBe(secret)
    })
    await withEnv({ APP_SECRETS_KEY: other }, async () => {
      const { open } = await aead()
      expect(() => open(sealed, eventId)).toThrow(/authentication failed/)
    })
  })

  test('without APP_SECRETS_KEY it fails closed, and a key of the wrong length is refused', async () => {
    const sealed = await withEnv({ APP_SECRETS_KEY: key }, async () => (await aead()).seal(secret, eventId))
    await withEnv({ APP_SECRETS_KEY: undefined }, async () => {
      const { seal, open, secretsAvailable } = await aead()
      expect(secretsAvailable()).toBe(false)
      expect(() => seal(secret, eventId)).toThrow(/Secret storage is not configured/)
      expect(() => open(sealed, eventId)).toThrow(/Secret storage is not configured/)
    })
    await withEnv({ APP_SECRETS_KEY: randomBytes(16).toString('base64') }, async () => {
      const { secretsAvailable, seal } = await aead()
      expect(secretsAvailable()).toBe(false)
      expect(() => seal(secret, eventId)).toThrow(/32 base64-encoded bytes/)
    })
  })
})

/* ───────────────────────────── 2. adapters ───────────────────────────── */

test.describe('chat providers: both adapters against a fake provider', () => {
  let provider: FakeProvider

  test.beforeAll(async () => {
    provider = await startFakeProvider()
  })
  test.afterAll(async () => {
    await provider?.close()
  })

  test('the endpoint is composed from the base URL', async () => {
    const { chatEndpoint } = await chat()
    const cfg = (baseUrl: string | null, provider: 'anthropic' | 'openai-compatible' = 'openai-compatible') =>
      ({ provider, apiKey: 'k', model: 'm', baseUrl, source: 'gathering' }) as const
    expect(chatEndpoint(cfg('https://api.openai.com'))).toBe('https://api.openai.com/v1/chat/completions')
    expect(chatEndpoint(cfg('https://api.openai.com/v1'))).toBe('https://api.openai.com/v1/chat/completions')
    expect(chatEndpoint(cfg('https://api.openai.com/v1/'))).toBe('https://api.openai.com/v1/chat/completions')
    expect(chatEndpoint(cfg('https://host/openai/v1/chat/completions'))).toBe('https://host/openai/v1/chat/completions')
    expect(chatEndpoint(cfg(null, 'anthropic'))).toBe('https://api.anthropic.com/v1/messages')
  })

  test('the Anthropic adapter streams text deltas and stops, with the key in x-api-key', async () => {
    await withEnv({ AI_TEST_BASE_ORIGIN: provider.origin }, async () => {
      const { streamText, completeText } = await chat()
      const cfg = { provider: 'anthropic' as const, apiKey: 'sk-ant-fake', model: 'claude-sonnet-5', baseUrl: provider.origin, source: 'gathering' as const }
      const events: string[] = []
      let text = ''
      for await (const e of streamText(cfg, { system: 'sys', user: 'question' })) {
        events.push(e.type)
        if (e.type === 'text') text += e.text
      }
      expect(text).toBe('Compost heaps [Session · 00:10].')
      expect(events[events.length - 1]).toBe('stop')
      const done = await completeText(cfg, { system: 'sys', user: 'question' })
      expect(done.text).toBe('OK')
      expect(done.stopReason).toBe('end_turn')
      const hit = provider.hits.at(-1)!
      expect(hit.path).toBe('/v1/messages')
      expect(hit.auth).toBe('sk-ant-fake')
      expect(hit.body.system).toBe('sys')
      expect(hit.body.messages[0]).toEqual({ role: 'user', content: 'question' })
    })
  })

  test('the OpenAI-compatible adapter streams choices deltas and honours [DONE]', async () => {
    await withEnv({ AI_TEST_BASE_ORIGIN: provider.origin }, async () => {
      const { streamText, completeText } = await chat()
      const cfg = { provider: 'openai-compatible' as const, apiKey: 'sk-compat', model: 'gpt-test', baseUrl: `${provider.origin}/v1`, source: 'gathering' as const }
      let text = ''
      let stop: string | null | undefined
      for await (const e of streamText(cfg, { system: 'sys', user: 'question' })) {
        if (e.type === 'text') text += e.text
        if (e.type === 'stop') stop = e.stopReason
      }
      expect(text).toBe('Tool sharing [Session · 00:45].')
      expect(stop).toBe('stop')
      const done = await completeText(cfg, { system: 'sys', user: 'question' })
      expect(done.text).toBe('OK')
      const hit = provider.hits.at(-1)!
      expect(hit.path).toBe('/v1/chat/completions')
      expect(hit.auth).toBe('Bearer sk-compat')
      expect(hit.body.messages[0]).toEqual({ role: 'system', content: 'sys' })
      expect(hit.body.model).toBe('gpt-test')
    })
  })

  test('the connection test reports what the provider said, and never the key', async () => {
    await withEnv({ AI_TEST_BASE_ORIGIN: provider.origin }, async () => {
      const { testChatConfig } = await chat()
      const cfg = { provider: 'openai-compatible' as const, apiKey: 'sk-compat-secret', model: 'gpt-test', baseUrl: provider.origin, source: 'gathering' as const }
      const ok = await testChatConfig(cfg)
      expect(ok.ok).toBe(true)
      expect(ok.detail).toContain('answered')
      expect(ok.detail).not.toContain('sk-compat-secret')
      expect(provider.hits.at(-1)!.body.max_tokens).toBe(1)

      provider.mode = 'unauthorized'
      const bad = await testChatConfig(cfg)
      provider.mode = 'ok'
      expect(bad.ok).toBe(false)
      expect(bad.detail).toContain('401')
      expect(bad.detail).toContain('invalid api key')
      expect(bad.detail).not.toContain('sk-compat-secret')
    })
  })

  test('a provider that refuses max_tokens is retried once with max_completion_tokens', async () => {
    await withEnv({ AI_TEST_BASE_ORIGIN: provider.origin }, async () => {
      const { testChatConfig, completeText } = await chat()
      const cfg = { provider: 'openai-compatible' as const, apiKey: 'sk-compat', model: 'o-reasoning', baseUrl: provider.origin, source: 'gathering' as const }
      provider.mode = 'needs-max-completion-tokens'
      const before = provider.hits.length
      try {
        const test = await testChatConfig(cfg)
        expect(test.ok).toBe(true)
        const sent = provider.hits.slice(before)
        expect(sent.length).toBe(2) // the refused attempt, then the retry
        expect(sent[0].body.max_tokens).toBe(1)
        expect(sent[1].body.max_tokens).toBeUndefined()
        expect(sent[1].body.max_completion_tokens).toBe(1)
        // Answers take the same path, so a reasoning model works beyond the button too.
        expect((await completeText(cfg, { system: 'sys', user: 'q' })).text).toBe('OK')
      } finally {
        provider.mode = 'ok'
      }
    })
  })

  test('an http base URL that is not the test origin is refused by the outbound policy', async () => {
    await withEnv({ AI_TEST_BASE_ORIGIN: undefined }, async () => {
      const { testChatConfig } = await chat()
      const res = await testChatConfig({ provider: 'openai-compatible', apiKey: 'k', model: 'm', baseUrl: provider.origin, source: 'gathering' })
      expect(res.ok).toBe(false)
      expect(res.detail).toMatch(/Refused by outbound URL policy/)
    })
  })

  test('key resolution: the gathering’s key wins, then the deployment’s, then none', async () => {
    await withEnv({ ANTHROPIC_API_KEY: 'sk-deployment', AI_CHAT_MODEL: undefined }, async () => {
      const { deploymentChatConfig, resolveChatConfig } = await chat()
      expect(deploymentChatConfig()?.source).toBe('deployment')
      expect(deploymentChatConfig()?.model).toBe('claude-sonnet-5')
      // No gathering id: the deployment key answers.
      const resolved = await resolveChatConfig(null)
      expect(resolved?.source).toBe('deployment')
    })
    await withEnv({ ANTHROPIC_API_KEY: undefined }, async () => {
      const { deploymentChatConfig, resolveChatConfig } = await chat()
      expect(deploymentChatConfig()).toBeNull()
      expect(await resolveChatConfig(null)).toBeNull()
    })
  })
})

/* ───────────────────────────── 3. the route ───────────────────────────── */

test.describe('ai-key route: authz, validation and secrecy', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let sql: postgres.Sql
  let gathering: TestGathering
  let owner: TestAccount
  let admin: TestAccount
  let moderator: TestAccount
  let member: TestAccount
  let stranger: TestAccount
  let route = ''

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    // Private on purpose: a non-member must get 404, not 403 (existence is not disclosed).
    gathering = await createTestGathering(sql, { tag: 'aikey', status: 'live', visibility: 'private' })
    ;[owner, admin, moderator, member, stranger] = await Promise.all([
      createTestAccount('aikey-owner', { sql }),
      createTestAccount('aikey-admin', { sql }),
      createTestAccount('aikey-mod', { sql }),
      createTestAccount('aikey-member', { sql }),
      createTestAccount('aikey-stranger', { sql }),
    ])
    await sql`
      insert into event_members (event_id, user_id, role) values
        (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${admin.id}, 'admin'),
        (${gathering.id}, ${moderator.id}, 'moderator'), (${gathering.id}, ${member.id}, 'attendee')
    `
    route = `/api/v1/events/${gathering.slug}/admin/ai-key`
  })

  test.afterAll(async () => {
    if (sql) await sql`delete from event_ai_settings where event_id = ${gathering.id}`.catch(() => undefined)
    await gathering?.cleanup()
    await Promise.all([owner, admin, moderator, member, stranger].filter(Boolean).map((a) => a.cleanup()))
    await sql?.end()
  })

  test('only owners and admins reach it: member 403, moderator 403, non-member 404, anonymous 401', async () => {
    expect((await api(route, { cookie: member.cookie })).status).toBe(403)
    expect((await api(route, { cookie: moderator.cookie })).status).toBe(403)
    expect((await api(route, { cookie: stranger.cookie })).status).toBe(404)
    expect((await api(route)).status).toBe(404) // private gathering: existence is not disclosed
    const asOwner = await api(route, { cookie: owner.cookie })
    expect(asOwner.status).toBe(200)
    const body = await jsonOf(asOwner)
    expect(body.settings).toBeNull()
    expect(body.anthropic_models.length).toBeGreaterThan(1)
    expect((await api(route, { cookie: admin.cookie })).status).toBe(200)
  })

  test('a cross-origin write is refused, and a member cannot write', async () => {
    const crossOrigin = await api(route, { method: 'PUT', cookie: owner.cookie, json: { provider: 'anthropic', key: 'sk-ant-abcdefgh' }, origin: 'https://evil.example' })
    expect(crossOrigin.status).toBe(403)
    const asMember = await api(route, { method: 'PUT', cookie: member.cookie, json: { provider: 'anthropic', key: 'sk-ant-abcdefgh' } })
    expect(asMember.status).toBe(403)
    const [row] = await sql`select count(*)::int as n from event_ai_settings where event_id = ${gathering.id}`
    expect(row.n).toBe(0)
  })

  test('validation: provider, model, base URL and key shape', async () => {
    const put = (json: unknown) => api(route, { method: 'PUT', cookie: owner.cookie, json })
    const cases: Array<[unknown, string]> = [
      [{ provider: 'bogus', key: 'sk-ant-abcdefgh' }, 'provider'],
      [{ provider: 'anthropic', key: 'short' }, 'key'],
      [{ provider: 'anthropic', key: 'sk with spaces and more' }, 'key'],
      [{ provider: 'anthropic', key: 'sk-ant-abcdefgh', model: 'claude-made-up' }, 'model'],
      [{ provider: 'anthropic', key: 'sk-ant-abcdefgh', base_url: 'https://example.com' }, 'base_url'],
      [{ provider: 'openai-compatible', key: 'sk-abcdefgh', model: 'gpt-test' }, 'base_url'],
      [{ provider: 'openai-compatible', key: 'sk-abcdefgh', model: 'gpt-test', base_url: 'http://192.168.1.10/v1' }, 'base_url'],
      [{ provider: 'openai-compatible', key: 'sk-abcdefgh', model: 'gpt-test', base_url: 'https://api.openai.com/v1?x=1' }, 'base_url'],
      [{ provider: 'openai-compatible', key: 'sk-abcdefgh', base_url: 'https://api.openai.com/v1' }, 'model'],
    ]
    for (const [json, field] of cases) {
      const res = await put(json)
      expect(res.status, JSON.stringify(json)).toBe(400)
      expect((await jsonOf(res)).field, JSON.stringify(json)).toBe(field)
    }
  })

  test('an Anthropic key is stored sealed, read back as last4 only, and removed again', async () => {
    const secret = `sk-ant-${randomBytes(12).toString('hex')}`
    const created = await api(route, { method: 'PUT', cookie: owner.cookie, json: { provider: 'anthropic', key: secret, model: 'claude-haiku-4-5-20251001' } })
    const createdText = await created.text()
    expect(created.status, createdText).toBe(201)
    expect(createdText).not.toContain(secret)

    const read = await api(route, { cookie: admin.cookie })
    const readText = await read.text()
    expect(readText).not.toContain(secret)
    const body = JSON.parse(readText)
    expect(body.settings.provider).toBe('anthropic')
    expect(body.settings.model).toBe('claude-haiku-4-5-20251001')
    expect(body.settings.base_url).toBeNull()
    expect(body.settings.last4).toBe(secret.slice(-4))
    expect(body.settings.key).toBeUndefined()
    expect(body.secrets_configured).toBe(true)

    // The row holds ciphertext, not the key — and it opens only for this gathering.
    const [row] = await sql<{ ciphertext: Buffer; last4: string; set_by: string }[]>`
      select key_ciphertext as ciphertext, key_last4 as last4, set_by from event_ai_settings where event_id = ${gathering.id}
    `
    expect(Buffer.from(row.ciphertext).toString('latin1')).not.toContain(secret)
    expect(row.set_by).toBe(owner.id)
    const { open } = await aead()
    expect(open(row.ciphertext, gathering.id)).toBe(secret)
    expect(() => open(row.ciphertext, owner.id)).toThrow(/authentication failed/)

    // Replacing it is a 200 and changes last4; removing it empties the table.
    const replacement = `sk-ant-${randomBytes(12).toString('hex')}`
    const replaced = await api(route, { method: 'PUT', cookie: admin.cookie, json: { provider: 'anthropic', key: replacement } })
    expect(replaced.status).toBe(200)
    expect((await jsonOf(await api(route, { cookie: owner.cookie }))).settings.last4).toBe(replacement.slice(-4))
    const removed = await jsonOf(await api(route, { method: 'DELETE', cookie: owner.cookie }))
    expect(removed.removed).toBe(true)
    expect((await jsonOf(await api(route, { cookie: owner.cookie }))).settings).toBeNull()
  })

  test('“test connection” goes through the adapter and reports the provider’s own words', async () => {
    test.skip(!testOrigin, 'AI_TEST_BASE_ORIGIN is not set, so no fake provider may be reached')
    const provider = await startFakeProvider(Number(new URL(testOrigin).port))
    try {
      const secret = `sk-compat-${randomBytes(8).toString('hex')}`
      const saved = await api(route, {
        method: 'PUT',
        cookie: owner.cookie,
        json: { provider: 'openai-compatible', key: secret, model: 'gpt-test', base_url: `${testOrigin}/v1` },
      })
      expect(saved.status, await saved.clone().text()).toBe(201)

      const tested = await api(`${route}?action=test`, { method: 'POST', cookie: owner.cookie, json: {} })
      const text = await tested.text()
      expect(tested.status, text).toBe(200)
      expect(text).not.toContain(secret)
      const result = JSON.parse(text)
      expect(result.ok).toBe(true)
      expect(result.source).toBe('gathering')
      expect(result.provider).toBe('openai-compatible')
      expect(provider.hits.at(-1)!.auth).toBe(`Bearer ${secret}`)
      expect(provider.hits.at(-1)!.path).toBe('/v1/chat/completions')

      // A provider that refuses the key is reported, not hidden.
      provider.mode = 'unauthorized'
      const failed = await jsonOf(await api(`${route}?action=test`, { method: 'POST', cookie: owner.cookie, json: {} }))
      expect(failed.ok).toBe(false)
      expect(failed.detail).toContain('401')

      // An unknown action is refused before anything is called.
      const unknown = await api(`${route}?action=nope`, { method: 'POST', cookie: owner.cookie, json: {} })
      expect(unknown.status).toBe(400)
    } finally {
      await api(route, { method: 'DELETE', cookie: owner.cookie })
      await provider.close()
    }
  })
})

/* ─────────────────── 3b. themes never carry restricted material ─────────────────── */

test.describe('themes are built at the members tier only', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')
  test.skip(!testOrigin, 'AI_TEST_BASE_ORIGIN is not set, so no fake provider may be reached')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let sql: postgres.Sql
  let gathering: TestGathering
  let host: TestAccount
  let member: TestAccount
  let provider: FakeProvider
  const MEMBER_PHRASE = 'zqmembervisiblecompostheaps'
  const ORGANIZER_PHRASE = 'zqorganizersonlylegaladvice'
  const HIDDEN_PHRASE = 'zqhiddenbymoderationabuse'

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    gathering = await createTestGathering(sql, { tag: 'theme', status: 'proposals_open' })
    ;[host, member] = await Promise.all([createTestAccount('theme-host', { sql }), createTestAccount('theme-member', { sql })])
    await sql`
      insert into event_members (event_id, user_id, role) values
        (${gathering.id}, ${host.id}, 'owner'), (${gathering.id}, ${member.id}, 'attendee')
    `
    const add = async (title: string, phrase: string, visibility: 'members' | 'organizers', hidden: boolean) => {
      const [session] = await sql<{ id: string }[]>`
        insert into sessions (event_id, title, format, duration, host_id, status)
        values (${gathering.id}, ${title}, 'discussion', 60, ${host.id}, 'approved')
        returning id
      `
      if (hidden) await sql`update sessions set hidden_by_moderation = true where id = ${session.id}`
      const content = `[00:10] We discussed ${phrase} at length.`
      await sql`
        insert into session_transcripts (event_id, session_id, uploaded_by, source, format, content, char_count, consent_confirmed_at, visibility, status)
        values (${gathering.id}, ${session.id}, ${host.id}, 'paste', 'txt', ${content}, ${content.length}, now(), ${visibility}, 'ready')
      `
      return session.id
    }
    await add(`Members session ${gathering.slug}`, MEMBER_PHRASE, 'members', false)
    await add(`Organizers session ${gathering.slug}`, ORGANIZER_PHRASE, 'organizers', false)
    await add(`Hidden session ${gathering.slug}`, HIDDEN_PHRASE, 'members', true)
    await sql`update events set status = 'live', transcripts_enabled = true, transcripts_visibility = 'members' where id = ${gathering.id}`
    provider = await startFakeProvider(Number(new URL(testOrigin).port))
  })

  test.afterAll(async () => {
    await provider?.close()
    await gathering?.cleanup()
    await Promise.all([host, member].filter(Boolean).map((a) => a.cleanup()))
    await sql?.end()
  })

  test('an organizers-only transcript and a hidden session never reach the themes prompt', async () => {
    await withEnv({ AI_TEST_BASE_ORIGIN: provider.origin }, async () => {
      const { generateEventThemes } = await withServerOnlyShim(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../src/lib/knowledge/summaries') as typeof import('../src/lib/knowledge/summaries')
      })
      provider.reply = JSON.stringify({ themes: [{ title: 'Compost', summary: 'The members session talked about compost.', sessions: [] }] })
      const result = await generateEventThemes(
        { provider: 'openai-compatible', apiKey: 'sk-compat', model: 'gpt-test', baseUrl: provider.origin, source: 'gathering' },
        gathering.id,
      )
      const prompt = JSON.stringify(provider.hits.at(-1)!.body)
      expect(prompt).toContain(MEMBER_PHRASE)
      expect(prompt).not.toContain(ORGANIZER_PHRASE)
      expect(prompt).not.toContain(HIDDEN_PHRASE)
      expect(result?.themes[0].title).toBe('Compost')
    })
  })

  test('with the gathering narrowed to organizers, nothing is themed at all', async () => {
    await withEnv({ AI_TEST_BASE_ORIGIN: provider.origin }, async () => {
      const { generateEventThemes } = await withServerOnlyShim(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require('../src/lib/knowledge/summaries') as typeof import('../src/lib/knowledge/summaries')
      })
      await sql`update events set transcripts_visibility = 'organizers' where id = ${gathering.id}`
      const before = provider.hits.length
      try {
        const result = await generateEventThemes(
          { provider: 'openai-compatible', apiKey: 'sk-compat', model: 'gpt-test', baseUrl: provider.origin, source: 'gathering' },
          gathering.id,
        )
        expect(result).toBeNull()
        expect(provider.hits.length).toBe(before) // the provider was never asked
      } finally {
        await sql`update events set transcripts_visibility = 'members' where id = ${gathering.id}`
      }
    })
  })

  test('a member with nothing readable is offered no themes; an organizer still sees them', async () => {
    const { askAvailability } = await withServerOnlyShim(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('../src/lib/knowledge/ask') as typeof import('../src/lib/knowledge/ask')
    })
    // The themes stored by the first test are member-facing; a member who can read a transcript sees them.
    expect((await askAvailability(gathering.id, 'members')).themes.length).toBe(1)

    await sql`update events set transcripts_visibility = 'organizers' where id = ${gathering.id}`
    try {
      const asMember = await askAvailability(gathering.id, 'members')
      expect(asMember.ready_transcripts).toBe(0)
      expect(asMember.themes).toEqual([])
      const asOrganizer = await askAvailability(gathering.id, 'organizers')
      expect(asOrganizer.themes.length).toBe(1)
    } finally {
      await sql`update events set transcripts_visibility = 'members' where id = ${gathering.id}`
    }
  })
})

/* ───────────────────────────── 4. the pages ───────────────────────────── */

test.describe('Ask page and the Knowledge key form', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let sql: postgres.Sql
  let gathering: TestGathering
  let owner: TestAccount
  let member: TestAccount

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    gathering = await createTestGathering(sql, { tag: 'askui', status: 'live' })
    ;[owner, member] = await Promise.all([createTestAccount('askui-owner', { sql }), createTestAccount('askui-member', { sql })])
    await sql`
      insert into event_members (event_id, user_id, role) values
        (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${member.id}, 'attendee')
    `
    await sql`update events set transcripts_enabled = true where id = ${gathering.id}`
    // Fresh accounts get the onboarding dialog over every workspace page; these tests want the page.
    await sql`update profiles set onboarding_completed = true where id in ${sql([owner.id, member.id])}`
  })

  test.afterAll(async () => {
    if (sql) await sql`delete from event_ai_settings where event_id = ${gathering.id}`.catch(() => undefined)
    await gathering?.cleanup()
    await Promise.all([owner, member].filter(Boolean).map((a) => a.cleanup()))
    await sql?.end()
  })

  const open = async (browser: import('@playwright/test').Browser, cookie: string) => {
    const [name, ...rest] = cookie.split('=')
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } })
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    return { context, page: await context.newPage() }
  }

  test('a member sees the nav item and an explanation, never a 404', async ({ browser }) => {
    const { context, page } = await open(browser, member.cookie)
    try {
      await page.goto(`/e/${gathering.slug}/ask`)
      await expect(page.getByRole('heading', { name: 'Ask the gathering' })).toBeVisible()
      // The nav item shows because transcripts are enabled, even with nothing to answer from yet.
      await expect(page.getByRole('navigation').getByRole('link', { name: 'Ask' }).first()).toBeVisible()
      const panel = page.getByTestId('ask-unavailable')
      await expect(panel).toBeVisible()
      await expect(panel).toContainText(deploymentKey ? /once hosts add transcripts/i : /have not enabled answers yet/i)
      // Members never get the operator's environment names.
      await expect(panel).not.toContainText('ANTHROPIC_API_KEY')
      await expect(panel).not.toContainText('EMBEDDINGS_')
      // The assistant card is on the page, with the MCP URL and no token in sight.
      await expect(page.getByTestId('assistant-card-url')).toContainText('/api/mcp')
    } finally {
      await context.close()
    }
  })

  test('an organizer sees what to do about it, and the Knowledge page link', async ({ browser }) => {
    const { context, page } = await open(browser, owner.cookie)
    try {
      await page.goto(`/e/${gathering.slug}/ask`)
      const panel = page.getByTestId('ask-unavailable')
      await expect(panel).toBeVisible()
      if (!deploymentKey) {
        await expect(panel).toContainText(/No answer model yet/i)
        await expect(panel.getByRole('link', { name: /Knowledge page/i })).toBeVisible()
      } else {
        await expect(panel).toContainText(/No session has a transcript yet|not indexed yet/i)
      }
    } finally {
      await context.close()
    }
  })

  test('an owner installs a key through the Knowledge page and tests it against a fake provider', async ({ browser }) => {
    test.skip(!testOrigin, 'AI_TEST_BASE_ORIGIN is not set, so no fake provider may be reached')
    const provider = await startFakeProvider(Number(new URL(testOrigin).port))
    const { context, page } = await open(browser, owner.cookie)
    const secret = `sk-compat-${randomBytes(8).toString('hex')}`
    try {
      await page.goto(`/e/${gathering.slug}/admin/knowledge`)
      await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible()
      // The AI access card is there for attendees to be told about.
      await expect(page.getByTestId('ai-access-url')).toContainText('/api/mcp')

      const form = page.getByTestId('ai-key-form')
      await expect(form).toBeVisible()
      await form.getByTestId('ai-key-edit').click()
      await page.getByLabel('Provider').selectOption('openai-compatible')
      await page.getByLabel('Base URL').fill(`${testOrigin}/v1`)
      await page.getByLabel('Model', { exact: true }).fill('gpt-test')
      await page.getByTestId('ai-key-secret').fill(secret)

      await page.getByRole('button', { name: 'Test connection' }).first().click()
      await expect(page.getByTestId('ai-key-test-result')).toContainText(/answered/i)
      await expect(page.getByTestId('ai-key-test-result')).not.toContainText(secret)

      await page.getByRole('button', { name: 'Save key' }).click()
      await expect(form).toContainText(`••••${secret.slice(-4)}`)
      await expect(form).toContainText('OpenAI-compatible')
      await expect(page.locator('body')).not.toContainText(secret)

      // Stored sealed, and the Answers row now names the gathering's key.
      const [row] = await sql<{ last4: string; provider: string }[]>`
        select key_last4 as last4, provider from event_ai_settings where event_id = ${gathering.id}
      `
      expect(row.last4).toBe(secret.slice(-4))
      expect(row.provider).toBe('openai-compatible')

      // After a reload the Answers row names where the key came from, and the form still hides it.
      await page.reload()
      await expect(page.getByText('(this gathering’s key)')).toBeVisible()
      await expect(page.getByTestId('ai-key-form')).toContainText(`••••${secret.slice(-4)}`)
    } finally {
      await context.close()
      await provider.close()
    }
  })
})
