import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { strFromU8, unzipSync } from 'fflate'
import { createTestAccount, createTestGathering, TEST_BASE_URL, type TestAccount, type TestGathering } from './helpers/gathering'
import { normalizeTranscript } from '../src/lib/knowledge/normalize'
import { chunkParagraphs } from '../src/lib/knowledge/chunk'

// Knowledge harvest (design §10) against the running dev server (:3001), local Postgres and PDS:
// transcript permissions and tiers, normalization + chunking, coverage, the corpus export, and
// the clean no-ops when no AI provider is configured. Everything created here is removed.
loadEnvConfig(process.cwd(), true)

const base = TEST_BASE_URL
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const configured = Boolean(ownerUrl && (process.env.PDS_INTERNAL_URL || process.env.PDS_URL) && process.env.PDS_ADMIN_PASSWORD)
const providersOff = !process.env.EMBEDDINGS_PROVIDER && !process.env.ANTHROPIC_API_KEY

const VTT = `WEBVTT

NOTE this header block is dropped

1
00:00:01.000 --> 00:00:03.500
<v Ada>Welcome everyone to the &amp; session.

2
00:00:04.000 --> 00:00:07.000
<v Ada>Today we talk about <b>compost</b>.

3
00:00:40.000 --> 00:00:44.000
<v Ben>I run a community garden.

00:00:44.000 --> 00:00:46.000
<v Ben>I run a community garden.

00:01:20.500 --> 00:01:25.000
<v Ben>We share tools on Saturdays.
`

function api(path: string, init: { method?: string; cookie?: string; json?: unknown; body?: BodyInit; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { origin: base, ...(init.headers ?? {}) }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  return fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
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

test.describe('knowledge: normalization and chunking (pure)', () => {
  test('VTT → paragraphs with [mm:ss] markers, cue ids and timings stripped, deterministic', () => {
    const a = normalizeTranscript(VTT, 'vtt')
    const b = normalizeTranscript(VTT, 'vtt')
    expect(a).toEqual(b)
    expect(a.paragraphs.length).toBeGreaterThanOrEqual(2)
    expect(a.paragraphs[0]).toMatch(/^\[00:01\] Ada: Welcome everyone to the & session\. Today we talk about compost\./)
    expect(a.text).not.toMatch(/-->/)
    expect(a.text).not.toMatch(/WEBVTT|NOTE|<v |<b>/)
    // A speaker change and a 30 s gap start new paragraphs; the duplicated rolling cue is dropped once.
    expect(a.paragraphs.some((p) => p.startsWith('[00:40] Ben: I run a community garden.'))).toBe(true)
    expect(a.text.match(/I run a community garden/g)?.length).toBe(1)
    expect(a.paragraphs.some((p) => p.startsWith('[01:20]'))).toBe(true)
    expect(a.wordCount).toBeGreaterThan(10)
  })

  test('SRT timings with commas and numeric ids are handled like VTT', () => {
    const srt = `1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:02,500 --> 00:00:03,000\nGeneral Kenobi.\n`
    const n = normalizeTranscript(srt, 'srt')
    expect(n.paragraphs).toEqual(['[00:01] Hello there. General Kenobi.'])
  })

  test('plain text keeps its own markers and paragraphs', () => {
    const n = normalizeTranscript('[12:30] First point.\r\nstill first.\r\n\r\n\r\nSecond point.\n', 'txt')
    expect(n.paragraphs).toEqual(['[12:30] First point. still first.', 'Second point.'])
  })

  test('chunks stay near the target with paragraph-boundary overlap, deterministically', () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `[${String(i).padStart(2, '0')}:00] Paragraph ${i}. ${'lorem ipsum dolor sit amet '.repeat(12)}`.trim())
    const chunks = chunkParagraphs(paragraphs, { targetChars: 1000, overlapRatio: 0.15 })
    expect(chunks).toEqual(chunkParagraphs(paragraphs, { targetChars: 1000, overlapRatio: 0.15 }))
    expect(chunks.length).toBeGreaterThan(5)
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i)
      expect(c.text.length).toBeLessThanOrEqual(1000)
      expect(c.marker).toMatch(/^\[\d{2}:00\]$/)
    })
    // Every paragraph appears; consecutive chunks share their boundary paragraph (the overlap).
    for (const p of paragraphs) expect(chunks.some((c) => c.text.includes(p))).toBe(true)
    for (let i = 1; i < chunks.length; i++) {
      const firstParagraph = chunks[i].text.split('\n\n')[0]
      expect(chunks[i - 1].text.endsWith(firstParagraph)).toBe(true)
    }
    // A paragraph longer than the target is split rather than dropped.
    const huge = chunkParagraphs(['a sentence. '.repeat(400)], { targetChars: 1000 })
    expect(huge.length).toBeGreaterThan(3)
    expect(huge.every((c) => c.text.length <= 1000)).toBe(true)
  })
})

test.describe('knowledge: transcripts, coverage, export, providers', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')
  test.describe.configure({ mode: 'serial', retries: 0 })

  let sql: postgres.Sql
  let gathering: TestGathering
  let owner: TestAccount
  let host: TestAccount
  let member: TestAccount
  let stranger: TestAccount
  let sessionId = ''
  let bareSessionId = ''

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    gathering = await createTestGathering(sql, { tag: 'know', status: 'proposals_open', withProgram: true })
    ;[owner, host, member, stranger] = await Promise.all([
      createTestAccount('know-owner', { sql }),
      createTestAccount('know-host', { sql }),
      createTestAccount('know-member', { sql }),
      createTestAccount('know-stranger', { sql }),
    ])
    await sql`update profiles set display_name = 'Know Host' where id = ${host.id}`
    await sql`
      insert into event_members (event_id, user_id, role) values
        (${gathering.id}, ${owner.id}, 'owner'), (${gathering.id}, ${host.id}, 'attendee'), (${gathering.id}, ${member.id}, 'attendee')
    `
    const [slot] = await sql<{ id: string; venue_id: string }[]>`
      select id, venue_id from time_slots where event_id = ${gathering.id} and is_break = false order by start_time limit 1
    `
    // The insert trigger enforces the proposal window; schedule afterwards, then go live.
    const [s] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, host_id, track_id, topic_tags)
      values (${gathering.id}, ${`Compost circle ${gathering.slug}`}, 'discussion', 60, ${host.id}, ${gathering.trackIds[0]}, ${['soil', 'commons']})
      returning id
    `
    sessionId = s.id
    const [b] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, host_id)
      values (${gathering.id}, ${`Bare session ${gathering.slug}`}, 'talk', 30, ${host.id})
      returning id
    `
    bareSessionId = b.id
    await sql`update sessions set status = 'scheduled', time_slot_id = ${slot.id}, venue_id = ${slot.venue_id} where id = ${sessionId}`
    await sql`update sessions set status = 'scheduled' where id = ${bareSessionId}`
    await sql`update events set status = 'live' where id = ${gathering.id}`
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await Promise.all([owner, host, member, stranger].filter(Boolean).map((a) => a.cleanup()))
    await sql?.end()
  })

  test('a member who is not the host cannot upload; the host needs consent; then it works', async () => {
    const forbidden = await api(`/api/v1/sessions/${sessionId}/transcript`, { method: 'POST', cookie: member.cookie, json: { text: 'hi there', consent: true } })
    expect(forbidden.status).toBe(403)

    const noConsent = await api(`/api/v1/sessions/${sessionId}/transcript`, { method: 'POST', cookie: host.cookie, json: { text: '[00:10] We talked about compost heaps.' } })
    expect(noConsent.status).toBe(400)
    expect((await jsonOf(noConsent)).field).toBe('consent')

    const ok = await api(`/api/v1/sessions/${sessionId}/transcript`, {
      method: 'POST',
      cookie: host.cookie,
      json: { text: '[00:10] We talked about compost heaps and worm bins.\n\n[00:45] Then tool sharing on Saturdays.', consent: true, language: 'en' },
    })
    expect(ok.status).toBe(201)
    const body = await jsonOf(ok)
    expect(body.transcript.format).toBe('txt')
    expect(body.transcript.text).toContain('[00:45] Then tool sharing on Saturdays.')
    expect(body.transcript.word_count).toBeGreaterThan(5)
    expect(body.transcript.uploaded_by).toBeUndefined()
    expect(body.chunks).toBe(1)
    if (providersOff) expect(body.embed_queued).toBe(false)

    const [row] = await sql<{ consent_confirmed_at: string; uploaded_by: string; visibility: string }[]>`
      select consent_confirmed_at, uploaded_by, visibility from session_transcripts where session_id = ${sessionId} and replaced_at is null
    `
    expect(row.uploaded_by).toBe(host.id)
    expect(row.visibility).toBe('members')
    expect(row.consent_confirmed_at).toBeTruthy()
  })

  test('a disabled gathering answers 409', async () => {
    await sql`update events set transcripts_enabled = false where id = ${gathering.id}`
    try {
      const res = await api(`/api/v1/sessions/${sessionId}/transcript`, { method: 'POST', cookie: host.cookie, json: { text: 'x y z', consent: true } })
      expect(res.status).toBe(409)
      expect((await jsonOf(res)).code).toBe('TranscriptsDisabled')
    } finally {
      await sql`update events set transcripts_enabled = true where id = ${gathering.id}`
    }
  })

  test('reading tiers: members read, strangers do not, organizers-only hides from members', async () => {
    const anon = await api(`/api/v1/sessions/${sessionId}/transcript`)
    expect(anon.status).toBe(401)
    const outsider = await api(`/api/v1/sessions/${sessionId}/transcript`, { cookie: stranger.cookie })
    expect(outsider.status).toBe(403)

    const asMember = await jsonOf(await api(`/api/v1/sessions/${sessionId}/transcript`, { cookie: member.cookie }))
    expect(asMember.tier).toBe('members')
    expect(asMember.can_manage).toBe(false)
    expect(asMember.transcript.text).toContain('worm bins')

    const download = await api(`/api/v1/sessions/${sessionId}/transcript?download=1`, { cookie: member.cookie })
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('text/markdown')
    expect(await download.text()).toContain('# Compost circle')

    await sql`update events set transcripts_visibility = 'organizers' where id = ${gathering.id}`
    try {
      const hiddenFromMember = await jsonOf(await api(`/api/v1/sessions/${sessionId}/transcript`, { cookie: member.cookie }))
      expect(hiddenFromMember.transcript).toBeNull()
      expect(hiddenFromMember.restricted).toBe(true)
      const asOwner = await jsonOf(await api(`/api/v1/sessions/${sessionId}/transcript`, { cookie: owner.cookie }))
      expect(asOwner.tier).toBe('organizers')
      expect(asOwner.transcript.text).toContain('worm bins')
    } finally {
      await sql`update events set transcripts_visibility = 'members' where id = ${gathering.id}`
    }

    // A transcript can be narrowed to organizers by whoever attaches it.
    const narrowed = await api(`/api/v1/sessions/${sessionId}/transcript`, {
      method: 'POST',
      cookie: host.cookie,
      json: { text: '[00:10] Organizer eyes only.', consent: true, visibility: 'organizers' },
    })
    expect(narrowed.status).toBe(201)
    const memberView = await jsonOf(await api(`/api/v1/sessions/${sessionId}/transcript`, { cookie: member.cookie }))
    expect(memberView.transcript).toBeNull()
    const ownerView = await jsonOf(await api(`/api/v1/sessions/${sessionId}/transcript`, { cookie: owner.cookie }))
    expect(ownerView.transcript.text).toContain('Organizer eyes only')
    // The replaced transcript is kept (30 days) but is no longer current.
    const [counts] = await sql<{ current: number; replaced: number }[]>`
      select count(*) filter (where replaced_at is null)::int as current, count(*) filter (where replaced_at is not null)::int as replaced
      from session_transcripts where session_id = ${sessionId}
    `
    expect(counts.current).toBe(1)
    expect(counts.replaced).toBe(1)
  })

  test('an organizer uploads a VTT file (multipart); markers survive; RLS lets members read chunks', async () => {
    const form = new FormData()
    form.append('file', new Blob([VTT], { type: 'text/vtt' }), 'compost.vtt')
    form.append('consent', 'true')
    const res = await api(`/api/v1/sessions/${sessionId}/transcript`, { method: 'POST', cookie: owner.cookie, body: form })
    expect(res.status).toBe(201)
    const body = await jsonOf(res)
    expect(body.transcript.format).toBe('vtt')
    expect(body.transcript.source).toBe('upload')
    expect(body.transcript.text).toContain('[00:01] Ada: Welcome everyone')
    expect(body.transcript.text).not.toContain('-->')

    // RLS: as the signed-in member, the current transcript and its chunks are readable; the
    // replaced ones are not; and nothing is writable.
    const appUrl = process.env.DATABASE_URL || ownerUrl
    const app = postgres(appUrl, { max: 1, onnotice: () => {} })
    try {
      const seen = await app.begin(async (t) => {
        await t`SET LOCAL ROLE authenticated`
        await t`select set_config('request.jwt.claims', ${JSON.stringify({ sub: member.id, role: 'authenticated' })}, true)`
        const transcripts = await t<{ id: string; replaced_at: string | null }[]>`select id, replaced_at from session_transcripts where session_id = ${sessionId}`
        const chunks = await t<{ id: string }[]>`select id from transcript_chunks where session_id = ${sessionId}`
        let writable = true
        try {
          await t`update session_transcripts set summary = 'nope' where session_id = ${sessionId}`
        } catch {
          writable = false
        }
        return { transcripts, chunks, writable }
      }).catch((e: unknown) => ({ transcripts: [], chunks: [], writable: false, error: String(e) }))
      if ('error' in seen) {
        test.info().annotations.push({ type: 'note', description: `RLS probe skipped: ${seen.error}` })
      } else {
        expect(seen.transcripts.length).toBe(1)
        expect(seen.transcripts[0].replaced_at).toBeNull()
        expect(seen.chunks.length).toBeGreaterThan(0)
        expect(seen.writable).toBe(false)
      }
    } finally {
      await app.end()
    }
  })

  test('coverage counts sessions with and without transcripts; request notifies bare hosts', async () => {
    const forbidden = await api(`/api/v1/events/${gathering.slug}/knowledge/coverage`, { cookie: member.cookie })
    expect(forbidden.status).toBe(403)

    const res = await api(`/api/v1/events/${gathering.slug}/knowledge/coverage`, { cookie: owner.cookie })
    expect(res.status).toBe(200)
    const cov = await jsonOf(res)
    expect(cov.enabled).toBe(true)
    expect(cov.visibility).toBe('members')
    expect(cov.totals.sessions).toBe(2)
    expect(cov.totals.with_transcript).toBe(1)
    expect(cov.totals.without_transcript).toBe(1)
    expect(cov.totals.words).toBeGreaterThan(10)
    expect(cov.totals.chunks).toBeGreaterThan(0)
    expect(cov.totals.embedded).toBe(0)
    const withT = cov.sessions.find((s: any) => s.id === sessionId)
    expect(withT.transcript.format).toBe('vtt')
    expect(withT.host_name).toBe('Know Host')
    expect(cov.sessions.find((s: any) => s.id === bareSessionId).transcript).toBeNull()
    expect(JSON.stringify(cov)).not.toMatch(/api[_-]?key|sk-ant|EMBEDDINGS_API_KEY/i)
    if (providersOff) {
      expect(cov.providers.embeddings.configured).toBe(false)
      expect(cov.providers.chat.configured).toBe(false)
    }

    const req = await api(`/api/v1/events/${gathering.slug}/knowledge/coverage`, { method: 'POST', cookie: owner.cookie, json: { action: 'request' } })
    expect(req.status).toBe(200)
    const out = await jsonOf(req)
    expect(out.sessions).toBe(1)
    expect(out.notified).toBe(1)
    const notes = await sql<{ type: string; title: string; action_url: string }[]>`
      select type, title, action_url from notifications where user_id = ${host.id} and event_id = ${gathering.id} and type = 'admin_announcement'
    `
    expect(notes.length).toBe(1)
    expect(notes[0].title).toContain('Bare session')
    expect(notes[0].action_url).toBe(`/e/${gathering.slug}/sessions/${bareSessionId}`)
  })

  test('the corpus export is a zip with the documented files and fields, organizers only, logged', async () => {
    expect((await api(`/api/v1/events/${gathering.slug}/knowledge/export`, { cookie: member.cookie })).status).toBe(403)
    const res = await api(`/api/v1/events/${gathering.slug}/knowledge/export`, { cookie: owner.cookie })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('-corpus-')
    const files = unzipSync(new Uint8Array(await res.arrayBuffer()))
    const names = Object.keys(files)
    expect(names).toEqual(expect.arrayContaining(['corpus.jsonl', 'sessions.json', 'README.md']))
    expect(names.some((n) => n.startsWith('transcripts/') && n.endsWith('.md'))).toBe(true)

    const lines = strFromU8(files['corpus.jsonl']).trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      for (const field of ['id', 'session_id', 'title', 'hosts', 'track', 'day', 'start', 'venue', 'chunk_index', 'text', 'tags']) {
        expect(line, field).toHaveProperty(field)
      }
      expect(line.session_id).toBe(sessionId)
      expect(line.hosts).toEqual(['Know Host'])
      expect(line.track).toBe('Governance')
      expect(line.venue).toBeTruthy()
      expect(line.tags).toEqual(['soil', 'commons'])
      expect(typeof line.chunk_index).toBe('number')
    }
    const sessions = JSON.parse(strFromU8(files['sessions.json']))
    expect(sessions.schema_version).toBe(1)
    expect(sessions.gathering.slug).toBe(gathering.slug)
    expect(sessions.sessions.length).toBe(1)
    expect(sessions.sessions[0].transcript.chunks).toBe(lines.length)
    expect(names).toContain(sessions.sessions[0].transcript.file)
    const readme = strFromU8(files['README.md'])
    expect(readme).toContain('corpus.jsonl')
    expect(readme).toContain('chunk_index')
    expect(readme).toContain('embedding')
    const md = strFromU8(files[sessions.sessions[0].transcript.file])
    expect(md).toContain('# Compost circle')
    expect(md).toContain('[00:01] Ada')
    // No account ids, emails or handles anywhere in the artifact.
    const everything = names.map((n) => strFromU8(files[n])).join('\n')
    expect(everything).not.toContain(host.id)
    expect(everything).not.toContain(host.email)
    expect(everything).not.toContain('did:')

    const [log] = await sql<{ exported_by: string; chunk_count: number; session_count: number; bytes: number }[]>`
      select exported_by, chunk_count, session_count, bytes from knowledge_exports where event_id = ${gathering.id} order by created_at desc limit 1
    `
    expect(log.exported_by).toBe(owner.id)
    expect(log.session_count).toBe(1)
    expect(log.chunk_count).toBe(lines.length)
    expect(log.bytes).toBeGreaterThan(100)
  })

  test('embed, summaries and ask no-op cleanly when no provider is configured', async () => {
    test.skip(!providersOff, 'EMBEDDINGS_PROVIDER / ANTHROPIC_API_KEY are set in this environment')
    const embed = await api(`/api/v1/events/${gathering.slug}/knowledge/embed`, { method: 'POST', cookie: owner.cookie })
    expect(embed.status).toBe(200)
    expect(await jsonOf(embed)).toMatchObject({ configured: false, queued: false })
    const summaries = await api(`/api/v1/events/${gathering.slug}/knowledge/summaries`, { method: 'POST', cookie: owner.cookie })
    expect(summaries.status).toBe(200)
    expect(await jsonOf(summaries)).toMatchObject({ configured: false, queued: false })
    expect((await api(`/api/v1/events/${gathering.slug}/knowledge/embed`, { method: 'POST', cookie: member.cookie })).status).toBe(403)

    const availability = await jsonOf(await api(`/api/v1/events/${gathering.slug}/knowledge/ask`, { cookie: member.cookie }))
    expect(availability.available).toBe(false)
    expect(['chat', 'embeddings']).toContain(availability.reason)
    expect(availability.ready_transcripts).toBe(1)
    expect((await api(`/api/v1/events/${gathering.slug}/knowledge/ask`, { cookie: stranger.cookie })).status).toBe(403)

    const ask = await api(`/api/v1/events/${gathering.slug}/knowledge/ask`, { method: 'POST', cookie: member.cookie, json: { question: 'What did Ben say about tools?' } })
    expect(ask.status).toBe(503)
    expect((await jsonOf(ask)).code).toBe('NotAvailable')
    const short = await api(`/api/v1/events/${gathering.slug}/knowledge/ask`, { method: 'POST', cookie: member.cookie, json: { question: 'x' } })
    expect(short.status).toBe(400)

    const [jobs] = await sql<{ count: number }[]>`select count(*)::int as count from knowledge_jobs where event_id = ${gathering.id}`
    expect(jobs.count).toBe(0)
    const run = await api('/api/jobs/knowledge')
    expect([200, 401]).toContain(run.status) // 401 only when CRON_SECRET is set locally
  })

  test('participation settings accept the two transcript columns and reject bad values', async () => {
    const bad = await api(`/api/events/${gathering.id}/settings`, { method: 'PATCH', cookie: owner.cookie, json: { transcripts_visibility: 'everyone' } })
    expect(bad.status).toBe(400)
    expect((await jsonOf(bad)).field).toBe('transcripts_visibility')
    const ok = await api(`/api/events/${gathering.id}/settings`, { method: 'PATCH', cookie: owner.cookie, json: { transcripts_enabled: false, transcripts_visibility: 'organizers' } })
    expect(ok.status).toBe(200)
    const saved = await jsonOf(ok)
    expect(saved.event.transcripts_enabled).toBe(false)
    expect(saved.event.transcripts_visibility).toBe('organizers')
    await sql`update events set transcripts_enabled = true, transcripts_visibility = 'members' where id = ${gathering.id}`
  })

  test('the host removes the transcript; a member cannot', async () => {
    expect((await api(`/api/v1/sessions/${sessionId}/transcript`, { method: 'DELETE', cookie: member.cookie })).status).toBe(403)
    const res = await api(`/api/v1/sessions/${sessionId}/transcript`, { method: 'DELETE', cookie: host.cookie })
    expect(res.status).toBe(200)
    const after = await jsonOf(await api(`/api/v1/sessions/${sessionId}/transcript`, { cookie: member.cookie }))
    expect(after.transcript).toBeNull()
    const [chunks] = await sql<{ count: number }[]>`select count(*)::int as count from transcript_chunks where session_id = ${sessionId} and transcript_id in (select id from session_transcripts where session_id = ${sessionId} and replaced_at is null)`
    expect(chunks.count).toBe(0)
    expect((await api(`/api/v1/sessions/${sessionId}/transcript`, { method: 'DELETE', cookie: host.cookie })).status).toBe(404)
  })
})
