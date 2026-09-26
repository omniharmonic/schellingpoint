import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, TEST_BASE_URL, type TestAccount, type TestGathering } from './helpers/gathering'

// The remote MCP server (/api/mcp) and the assistant tokens behind it, against the running dev
// server (:3001), local Postgres and PDS. Covers minting / listing / revoking, the auth contract,
// the MCP handshake, and that every tool stays inside what the token's account may read.
// Everything created here is removed; the seeded gatherings are never touched.
loadEnvConfig(process.cwd(), true)

const base = TEST_BASE_URL
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const configured = Boolean(ownerUrl && (process.env.PDS_INTERNAL_URL || process.env.PDS_URL) && process.env.PDS_ADMIN_PASSWORD)

const TRANSCRIPT = '[00:10] We talked about compost heaps and worm bins.\n\n[00:45] Then tool sharing on Saturdays.'

/* ───────────────────────────── helpers ───────────────────────────── */

function api(path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { origin: base }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
}

async function jsonOf(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

/** Mint a token through the same route the Account panel uses. */
async function mintToken(cookie: string, name: string): Promise<string> {
  const res = await api('/api/me/assistant-tokens', { method: 'POST', cookie, json: { name } })
  const body = await jsonOf(res)
  if (res.status !== 201) throw new Error(`minting "${name}" failed: ${res.status} ${JSON.stringify(body)}`)
  return body.token as string
}

let rpcId = 0

interface RpcResult {
  status: number
  headers: Headers
  body: any
}

async function rpc(token: string | null, method: string, params: unknown = {}, extraHeaders: Record<string, string> = {}): Promise<RpcResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
  }
  if (token) headers.authorization = `Bearer ${token}`
  const res = await fetch(`${base}/api/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  return { status: res.status, headers: res.headers, body: await jsonOf(res) }
}

interface ToolOutcome {
  isError: boolean
  text: string
  /** The text parsed as JSON, when the tool returned structured data. */
  data: any
}

async function callTool(token: string, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome> {
  const res = await rpc(token, 'tools/call', { name, arguments: args })
  expect(res.status, `${name} → HTTP ${res.status}: ${JSON.stringify(res.body)}`).toBe(200)
  const result = res.body?.result
  expect(result, `${name} returned no result: ${JSON.stringify(res.body)}`).toBeTruthy()
  const text = (result.content ?? []).map((c: any) => (c.type === 'text' ? c.text : '')).join('\n')
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    /* plain prose result */
  }
  return { isError: !!result.isError, text, data }
}

/* ───────────────────────────── tokens ───────────────────────────── */

test.describe('assistant tokens', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let sql: postgres.Sql
  let person: TestAccount
  let other: TestAccount

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    ;[person, other] = await Promise.all([createTestAccount('mcp-tokens', { sql }), createTestAccount('mcp-tokens-2', { sql })])
  })

  test.afterAll(async () => {
    await Promise.all([person, other].filter(Boolean).map((a) => a.cleanup()))
    await sql?.end()
  })

  test('the routes need a signed-in viewer', async () => {
    expect((await api('/api/me/assistant-tokens')).status).toBe(401)
    expect((await api('/api/me/assistant-tokens', { method: 'POST', json: { name: 'nope' } })).status).toBe(401)
    expect((await api('/api/me/assistant-tokens?id=00000000-0000-0000-0000-000000000000', { method: 'DELETE' })).status).toBe(401)
  })

  test('a token is shown once, listed afterwards without its secret, and never leaves the account', async () => {
    const created = await api('/api/me/assistant-tokens', { method: 'POST', cookie: person.cookie, json: { name: 'Claude on my laptop' } })
    expect(created.status).toBe(201)
    const body = await jsonOf(created)
    expect(body.token).toMatch(/^unc_[A-Za-z0-9_-]{20,}$/)
    expect(body.assistant_token.name).toBe('Claude on my laptop')
    expect(body.mcp_url).toContain('/api/mcp')

    const listed = await jsonOf(await api('/api/me/assistant-tokens', { cookie: person.cookie }))
    expect(listed.limit).toBe(5)
    expect(listed.tokens).toHaveLength(1)
    expect(listed.tokens[0].id).toBe(body.assistant_token.id)
    // The secret is not stored, so it cannot be listed — only its sha256 is in the row.
    expect(JSON.stringify(listed)).not.toContain(body.token)
    const [row] = await sql<{ token_hash: string; account_id: string; scopes: string[] }[]>`
      select token_hash, account_id, scopes from assistant_tokens where id = ${body.assistant_token.id}
    `
    expect(row.account_id).toBe(person.id)
    expect(row.scopes).toEqual(['read'])
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(row.token_hash).not.toContain(body.token)

    // Somebody else's list never shows it, and they cannot revoke it.
    const theirs = await jsonOf(await api('/api/me/assistant-tokens', { cookie: other.cookie }))
    expect(theirs.tokens).toHaveLength(0)
    const stolen = await api(`/api/me/assistant-tokens?id=${body.assistant_token.id}`, { method: 'DELETE', cookie: other.cookie })
    expect(stolen.status).toBe(404)
  })

  test('a name is required, and five live tokens is the limit', async () => {
    const unnamed = await api('/api/me/assistant-tokens', { method: 'POST', cookie: person.cookie, json: { name: '   ' } })
    expect(unnamed.status).toBe(400)
    expect((await jsonOf(unnamed)).field).toBe('name')

    // One already exists from the previous test; fill up to five.
    for (let i = 2; i <= 5; i++) await mintToken(person.cookie, `Assistant ${i}`)
    const sixth = await api('/api/me/assistant-tokens', { method: 'POST', cookie: person.cookie, json: { name: 'One too many' } })
    expect(sixth.status).toBe(409)
    expect((await jsonOf(sixth)).code).toBe('TokenLimit')

    const listed = await jsonOf(await api('/api/me/assistant-tokens', { cookie: person.cookie }))
    expect(listed.tokens).toHaveLength(5)
  })

  test('revoking is immediate: the token stops working at /api/mcp', async () => {
    const token = await mintToken(other.cookie, 'Short-lived')
    const before = await rpc(token, 'tools/list')
    expect(before.status).toBe(200)

    const listed = await jsonOf(await api('/api/me/assistant-tokens', { cookie: other.cookie }))
    const id = listed.tokens[0].id
    const revoked = await api(`/api/me/assistant-tokens?id=${id}`, { method: 'DELETE', cookie: other.cookie })
    expect(revoked.status).toBe(200)

    const after = await rpc(token, 'tools/list')
    expect(after.status).toBe(401)
    expect(after.headers.get('www-authenticate')).toContain('Bearer')
    // Revoking twice is not a second success, and the list is empty again.
    expect((await api(`/api/me/assistant-tokens?id=${id}`, { method: 'DELETE', cookie: other.cookie })).status).toBe(404)
    expect((await jsonOf(await api('/api/me/assistant-tokens', { cookie: other.cookie }))).tokens).toHaveLength(0)
  })

  test('using a token records it, at most once a minute', async () => {
    const token = await mintToken(other.cookie, 'Used once')
    expect((await rpc(token, 'tools/list')).status).toBe(200)
    await expect
      .poll(async () => {
        const [row] = await sql<{ last_used_at: string | null }[]>`
          select last_used_at from assistant_tokens where account_id = ${other.id} and revoked_at is null
        `
        return row?.last_used_at
      }, { timeout: 5000 })
      .toBeTruthy()
  })
})

/* ───────────────────────────── the MCP server ───────────────────────────── */

test.describe('mcp server', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let sql: postgres.Sql
  let gathering: TestGathering
  let elsewhere: TestGathering
  let owner: TestAccount
  let member: TestAccount
  let stranger: TestAccount
  /** Belongs to `elsewhere` and hosts its session, so none of the three above is a member there. */
  let outsider: TestAccount
  let ownerToken = ''
  let memberToken = ''
  let strangerToken = ''
  let sessionId = ''
  let elsewhereSessionId = ''
  let embeddingsConfigured = false

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    ;[gathering, elsewhere] = await Promise.all([
      createTestGathering(sql, { tag: 'mcp', status: 'proposals_open', withProgram: true }),
      createTestGathering(sql, { tag: 'mcpelse', status: 'proposals_open' }),
    ])
    ;[owner, member, stranger, outsider] = await Promise.all([
      createTestAccount('mcp-owner', { sql }),
      createTestAccount('mcp-member', { sql }),
      createTestAccount('mcp-stranger', { sql }),
      createTestAccount('mcp-outsider', { sql }),
    ])
    await sql`update profiles set display_name = 'MCP Host' where id = ${member.id}`
    await sql`
      insert into event_members (event_id, user_id, role) values
        (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${member.id}, 'attendee'),
        (${elsewhere.id}, ${outsider.id}, 'owner')
    `
    const [slot] = await sql<{ id: string; venue_id: string }[]>`
      select id, venue_id from time_slots where event_id = ${gathering.id} and is_break = false order by start_time limit 1
    `
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, host_id, track_id, topic_tags)
      values (${gathering.id}, ${`Compost circle ${gathering.slug}`}, 'discussion', 60, ${member.id}, ${gathering.trackIds[0]}, ${['soil', 'commons']})
      returning id
    `
    sessionId = s.id
    await sql`update sessions set status = 'scheduled', time_slot_id = ${slot.id}, venue_id = ${slot.venue_id} where id = ${sessionId}`
    const [e] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, host_id)
      values (${elsewhere.id}, ${`Somewhere else ${elsewhere.slug}`}, 'talk', 30, ${outsider.id})
      returning id
    `
    elsewhereSessionId = e.id
    await sql`update sessions set status = 'approved' where id = ${elsewhereSessionId}`
    await sql`update events set status = 'live' where id = ${gathering.id}`
    ;[ownerToken, memberToken, strangerToken] = await Promise.all([
      mintToken(owner.cookie, 'Owner assistant'),
      mintToken(member.cookie, 'Member assistant'),
      mintToken(stranger.cookie, 'Stranger assistant'),
    ])

    // The organizer attaches a transcript through the normal route.
    const attached = await api(`/api/v1/sessions/${sessionId}/transcript`, {
      method: 'POST',
      cookie: owner.cookie,
      json: { text: TRANSCRIPT, consent: true, language: 'en' },
    })
    expect(attached.status).toBe(201)

    const coverage = await jsonOf(await api(`/api/v1/events/${gathering.slug}/knowledge/coverage`, { cookie: owner.cookie }))
    embeddingsConfigured = !!coverage?.providers?.embeddings?.configured
  })

  test.afterAll(async () => {
    await Promise.all([gathering, elsewhere].filter(Boolean).map((g) => g.cleanup()))
    await Promise.all([owner, member, stranger, outsider].filter(Boolean).map((a) => a.cleanup()))
    await sql?.end()
  })

  test('no token, a junk token and a cookie alone are all refused with WWW-Authenticate', async () => {
    const anonymous = await rpc(null, 'tools/list')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toMatch(/^Bearer/)
    expect(anonymous.body.error.message).toContain('Account')

    expect((await rpc('unc_not-a-real-token-at-all-000000000000', 'tools/list')).status).toBe(401)
    expect((await rpc('sk-some-other-scheme', 'tools/list')).status).toBe(401)

    // A session cookie is not a credential here: this route never reads one.
    const withCookie = await fetch(`${base}/api/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: member.cookie },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(withCookie.status).toBe(401)
  })

  test('initialize and tools/list over HTTP with a token', async () => {
    const init = await rpc(memberToken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'unconference-tests', version: '1.0.0' },
    })
    expect(init.status).toBe(200)
    expect(init.body.result.serverInfo.name).toBe('unconference')
    expect(init.body.result.protocolVersion).toBeTruthy()
    expect(init.body.result.instructions).toContain('Read-only')
    // Stateless: no session id is issued, so no client has to carry one.
    expect(init.headers.get('mcp-session-id')).toBeNull()
    // Browser-based clients can reach it.
    expect(init.headers.get('access-control-allow-origin')).toBe('*')

    const tools = await rpc(memberToken, 'tools/list')
    expect(tools.status).toBe(200)
    const names = tools.body.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual([
      'export_corpus',
      'get_schedule',
      'get_session',
      'get_transcript',
      'list_my_gatherings',
      'list_sessions',
      'search_knowledge',
    ])
    for (const tool of tools.body.result.tools) expect(tool.description.length).toBeGreaterThan(40)
  })

  test('the CORS preflight passes and the metadata probe answers JSON, not HTML', async () => {
    const preflight = await fetch(`${base}/api/mcp`, {
      method: 'OPTIONS',
      headers: { origin: 'https://claude.ai', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization')

    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource`)
    expect(metadata.status).toBe(200)
    expect(metadata.headers.get('content-type')).toContain('application/json')
    const body = await jsonOf(metadata)
    expect(body.resource).toContain('/api/mcp')
    expect(body.authorization_servers).toEqual([])
    expect(body.resource_documentation).toContain('/help/assistants')
  })

  test('list_my_gatherings shows only memberships', async () => {
    const mine = await callTool(memberToken, 'list_my_gatherings')
    expect(mine.isError).toBe(false)
    const slugs = mine.data.map((g: any) => g.slug)
    expect(slugs).toContain(gathering.slug)
    expect(slugs).not.toContain(elsewhere.slug)
    expect(mine.data.find((g: any) => g.slug === gathering.slug).role).toBe('attendee')

    const asOwner = await callTool(ownerToken, 'list_my_gatherings')
    expect(asOwner.data.find((g: any) => g.slug === gathering.slug).role).toBe('owner')

    const none = await callTool(strangerToken, 'list_my_gatherings')
    expect(none.data).toBeNull()
    expect(none.text).toContain('not a member of any gathering')

    // And a non-member cannot reach the gathering through any other tool either.
    const denied = await callTool(strangerToken, 'get_schedule', { slug: gathering.slug })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain('list_my_gatherings')
  })

  test('get_schedule and list_sessions stay inside the read model', async () => {
    const schedule = await callTool(memberToken, 'get_schedule', { slug: gathering.slug })
    expect(schedule.isError).toBe(false)
    const sessions = schedule.data.days.flatMap((d: any) => d.sessions)
    const scheduled = sessions.find((s: any) => s.id === sessionId)
    expect(scheduled.title).toContain('Compost circle')
    expect(scheduled.start).toMatch(/^\d{2}:\d{2}$/)
    expect(scheduled.room).toBeTruthy()
    expect(scheduled.hosts[0].display_name).toBe('MCP Host')
    // Every host carries a link to their profile in this gathering (design §3.2).
    // Absolute, so an assistant can open it; the origin is whatever NEXT_PUBLIC_APP_URL says.
    expect(scheduled.hosts[0].profile_url).toMatch(/^https?:\/\//)
    expect(scheduled.hosts[0].profile_url).toContain(`/e/${gathering.slug}/people/${encodeURIComponent(member.did)}`)
    // Never anybody's identifiers — the host's own DID appears only inside that profile URL, and
    // only percent-encoded as a path segment (hence the `%3A` unescaping before the match).
    const decoded = schedule.text.replace(/%3A/gi, ':')
    const dids = new Set(decoded.match(/did:(?:plc|web):[A-Za-z0-9._:-]+/g) ?? [])
    expect([...dids], `unexpected DIDs: ${[...dids].join(', ')}`).toEqual([member.did])
    expect(schedule.text).not.toContain(member.email)
    expect(schedule.text).not.toContain(member.id)

    const listed = await callTool(memberToken, 'list_sessions', { slug: gathering.slug, query: 'compost' })
    expect(listed.data.sessions).toHaveLength(1)
    expect(listed.data.sessions[0].id).toBe(sessionId)
    const nothing = await callTool(memberToken, 'list_sessions', { slug: gathering.slug, query: 'zzzz-nothing-matches' })
    expect(nothing.text).toContain('No sessions')
  })

  test('get_session answers not-found for another gathering’s session', async () => {
    const ok = await callTool(memberToken, 'get_session', { slug: gathering.slug, session_id: sessionId })
    expect(ok.isError).toBe(false)
    expect(ok.data.transcript.available).toBe(true)
    expect(ok.data.hosts[0].profile_url).toContain(`/e/${gathering.slug}/people/${encodeURIComponent(member.did)}`)

    const crossEvent = await callTool(memberToken, 'get_session', { slug: gathering.slug, session_id: elsewhereSessionId })
    expect(crossEvent.isError).toBe(true)
    expect(crossEvent.text).toMatch(/No session/)

    const nonsense = await callTool(memberToken, 'get_session', { slug: gathering.slug, session_id: 'not-a-uuid' })
    expect(nonsense.isError).toBe(true)

    const otherGathering = await callTool(memberToken, 'get_transcript', { slug: elsewhere.slug, session_id: elsewhereSessionId })
    expect(otherGathering.isError).toBe(true)
    expect(otherGathering.text).toContain(elsewhere.slug)
  })

  test('get_transcript respects the organizers-only tier', async () => {
    const asMember = await callTool(memberToken, 'get_transcript', { slug: gathering.slug, session_id: sessionId })
    expect(asMember.isError).toBe(false)
    expect(asMember.text).toContain('worm bins')

    await sql`update events set transcripts_visibility = 'organizers' where id = ${gathering.id}`
    try {
      const refused = await callTool(memberToken, 'get_transcript', { slug: gathering.slug, session_id: sessionId })
      expect(refused.isError).toBe(true)
      expect(refused.text).toContain('organizers')
      expect(refused.text).not.toContain('worm bins')

      const allowed = await callTool(ownerToken, 'get_transcript', { slug: gathering.slug, session_id: sessionId })
      expect(allowed.isError).toBe(false)
      expect(allowed.text).toContain('worm bins')

      // The member is told a transcript exists, but not what is in it.
      const detail = await callTool(memberToken, 'get_session', { slug: gathering.slug, session_id: sessionId })
      expect(detail.data.transcript.available).toBe(false)
      expect(detail.data.transcript.reason).toContain('organizers')
    } finally {
      await sql`update events set transcripts_visibility = 'members' where id = ${gathering.id}`
    }
  })

  test('search_knowledge says plainly what it can and cannot do', async () => {
    const result = await callTool(memberToken, 'search_knowledge', { slug: gathering.slug, query: 'what did people say about compost?' })
    expect(result.isError).toBe(false)
    if (!embeddingsConfigured) {
      expect(result.data).toBeNull()
      expect(result.text).toMatch(/embeddings (switched off|provider)/i)
      expect(result.text).toContain('list_sessions')
    } else {
      // Either ranked excerpts, or an honest "nothing scores above the threshold".
      const ranked = result.data?.results
      if (ranked) {
        expect(ranked.length).toBeGreaterThan(0)
        expect(ranked[0].session_title).toContain('Compost circle')
        expect(ranked[0].link).toContain(`/sessions/${ranked[0].session_id}`)
      } else {
        expect(result.text).toContain('relevance threshold')
      }
    }
  })

  test('export_corpus is for organizers, and is logged', async () => {
    const refused = await callTool(memberToken, 'export_corpus', { slug: gathering.slug })
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('organizers')

    const exported = await callTool(ownerToken, 'export_corpus', { slug: gathering.slug })
    expect(exported.isError).toBe(false)
    const firstLine = JSON.parse(exported.text.split('\n')[0])
    expect(firstLine.session_id).toBe(sessionId)
    expect(firstLine.text).toContain('worm bins')
    expect(firstLine.hosts).toEqual(['MCP Host'])
    expect(exported.text).toContain('whole corpus')

    const [log] = await sql<{ exported_by: string; chunk_count: number }[]>`
      select exported_by, chunk_count from knowledge_exports where event_id = ${gathering.id} order by created_at desc limit 1
    `
    expect(log.exported_by).toBe(owner.id)
    expect(log.chunk_count).toBeGreaterThan(0)
  })

  test('the schedule resource lists and reads', async () => {
    const list = await rpc(memberToken, 'resources/templates/list')
    expect(list.status).toBe(200)
    expect(list.body.result.resourceTemplates[0].uriTemplate).toBe('unconference://gatherings/{slug}/schedule')

    const read = await rpc(memberToken, 'resources/read', { uri: `unconference://gatherings/${gathering.slug}/schedule` })
    expect(read.status).toBe(200)
    const contents = JSON.parse(read.body.result.contents[0].text)
    expect(contents.gathering.slug).toBe(gathering.slug)
    expect(contents.sessions.some((s: any) => s.id === sessionId)).toBe(true)
  })
})

/* ───────────────────────────── rate limit ───────────────────────────── */

test.describe('mcp rate limit', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let sql: postgres.Sql
  let burst: TestAccount

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 1, onnotice: () => {} })
    burst = await createTestAccount('mcp-burst', { sql })
  })

  test.afterAll(async () => {
    await burst?.cleanup()
    await sql?.end()
  })

  test('past 120 requests a minute a token gets 429 with Retry-After', async () => {
    const token = await mintToken(burst.cookie, 'Chatty assistant')
    const statuses: number[] = []
    let limited: RpcResult | null = null
    for (let batch = 0; batch < 7 && !limited; batch++) {
      const results = await Promise.all(Array.from({ length: 20 }, () => rpc(token, 'tools/list')))
      for (const r of results) {
        statuses.push(r.status)
        if (r.status === 429 && !limited) limited = r
      }
    }
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true)
    expect(limited, `no 429 in ${statuses.length} requests`).toBeTruthy()
    expect(Number(limited!.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(limited!.body.error.message).toContain('120')
  })
})
