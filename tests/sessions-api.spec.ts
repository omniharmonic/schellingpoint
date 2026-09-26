import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { signInWithEmail } from './helpers/gathering'

// Sessions & participation (work package B) end to end against the running dev server (:3001),
// the local Postgres and the local PDS. The dev server must run without a mail key so the
// email door hands back `devVerifyUrl`. Every account, event and record created here is removed.
loadEnvConfig(process.cwd(), true)

const base = process.env.SESSIONS_TEST_BASE_URL || 'http://localhost:3001'
const ownerUrl = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL || ''
const pdsUrl = (process.env.PDS_INTERNAL_URL || process.env.PDS_URL || '').replace(/\/+$/, '')
const pdsAdminPassword = process.env.PDS_ADMIN_PASSWORD || ''
const handleDomain = (process.env.PDS_HANDLE_DOMAIN || 'test').replace(/^\./, '')
const configured = Boolean(ownerUrl && pdsUrl && pdsAdminPassword)

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`
const EMAIL = (who: string) => `pkgb+${who}-${RUN}@example.test`
const ORIGIN = { origin: base }
const adminAuth = `Basic ${Buffer.from(`admin:${pdsAdminPassword}`).toString('base64')}`

interface Account { email: string; cookie: string; id: string; did: string }

async function signIn(sql: postgres.Sql, who: string): Promise<Account> {
  const email = EMAIL(who)
  const cookie = await signInWithEmail(email, base)
  const [row] = await sql<{ id: string; did: string }[]>`select id, did from accounts where email = ${email}`
  return { email, cookie: cookie!, id: row.id, did: row.did }
}

async function api(path: string, init: { method?: string; cookie?: string; json?: unknown } = {}) {
  const headers: Record<string, string> = { ...ORIGIN }
  if (init.cookie) headers.cookie = init.cookie
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  })
  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, text }
}

async function getRecord(uri: string): Promise<{ cid: string; value: Record<string, unknown> } | null> {
  const m = /^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(uri)
  if (!m) return null
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(m[1])}&collection=${m[2]}&rkey=${m[3]}`)
  if (!res.ok) return null
  return res.json()
}

test.describe.configure({ mode: 'serial', retries: 0 })

test.describe('sessions & participation API', () => {
  test.skip(!configured, 'DATABASE_MIGRATION_URL / PDS_URL / PDS_ADMIN_PASSWORD are not set')

  let sql: postgres.Sql
  let proposer: Account
  let cohost: Account
  let stranger: Account
  let organizer: Account
  let demo: { id: string; actor_did: string | null }
  let mintedGatheringDid: string | null = null
  let openSlug = ''
  let trackId = ''
  let sessionId = ''
  let privateEventId = ''
  let privateSlug = ''
  let privateScheduledId = ''
  let privateSelfHostedId = ''
  let pastSessionId = ''
  const createdSessions: string[] = []

  test.beforeAll(async () => {
    sql = postgres(ownerUrl, { max: 2, onnotice: () => {} })
    ;[proposer, cohost, stranger, organizer] = [
      await signIn(sql, 'proposer'),
      await signIn(sql, 'cohost'),
      await signIn(sql, 'stranger'),
      await signIn(sql, 'organizer'),
    ]
    // Profile details that must never reach another person's browser.
    await sql`update profiles set display_name = ${`Proposer ${RUN}`}, telegram = ${`tg_${RUN}`}, ens = ${`ens${RUN}.eth`} where id = ${proposer.id}`
    await sql`update profiles set display_name = ${`Cohost ${RUN}`}, telegram = ${`tgc_${RUN}`} where id = ${cohost.id}`

    // An open, public gathering of our own: the seeded demo-gathering's phase is shared with the
    // other packages' suites (voting tests move it on), so proposals are tested on a gathering
    // whose window this suite controls. Its DID is minted on the local PDS like any gathering's.
    openSlug = `pkgb-open-${RUN}`
    const invite = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createInviteCode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: adminAuth },
      body: JSON.stringify({ useCount: 1 }),
    }).then((r) => r.json())
    const account = await fetch(`${pdsUrl}/xrpc/com.atproto.server.createAccount`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: `pkgb-g${RUN}.${handleDomain}`,
        email: `pkgb+gathering-${RUN}@example.test`,
        password: `pw-${RUN}-${Math.random()}`,
        inviteCode: invite.code,
      }),
    }).then((r) => r.json())
    expect(account.did, JSON.stringify(account)).toMatch(/^did:/)
    mintedGatheringDid = account.did
    ;[demo] = await sql<{ id: string; actor_did: string | null }[]>`
      insert into events (slug, name, start_date, end_date, status, visibility, timezone, require_proposal_approval, actor_did, actor_handle)
      values (${openSlug}, 'Package B open', current_date + 7, current_date + 8, 'proposals_open', 'public', 'America/Denver', false,
              ${account.did}, ${`pkgb-g${RUN}.${handleDomain}`})
      returning id, actor_did
    `
    await sql`insert into event_members (event_id, user_id, role) values (${demo.id}, ${organizer.id}, 'owner')`
    await sql`insert into venues (event_id, name, capacity) values (${demo.id}, 'Main hall', 100)`
    ;[{ id: trackId }] = await sql<{ id: string }[]>`
      insert into tracks (event_id, name, slug, color) values (${demo.id}, 'Soil', 'soil', '#228833') returning id
    `

    // A private gathering with a capacity-1 venue, one scheduled session and one self-hosted one.
    privateSlug = `pkgb-private-${RUN}`
    const [ev] = await sql<{ id: string }[]>`
      insert into events (slug, name, start_date, end_date, status, visibility, timezone)
      values (${privateSlug}, 'Package B private', current_date, current_date + 1, 'proposals_open', 'private', 'America/Denver')
      returning id
    `
    privateEventId = ev.id
    for (const a of [proposer, cohost]) {
      await sql`insert into event_members (event_id, user_id, role) values (${ev.id}, ${a.id}, 'attendee')`
    }
    const [venue] = await sql<{ id: string }[]>`
      insert into venues (event_id, name, capacity) values (${ev.id}, 'Tiny room', 1) returning id
    `
    const [slot] = await sql<{ id: string }[]>`
      insert into time_slots (event_id, start_time, end_time, label)
      values (${ev.id}, now() + interval '1 day', now() + interval '1 day 1 hour', 'Morning') returning id
    `
    const [scheduled] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, status, venue_id, time_slot_id, host_id)
      values (${ev.id}, 'Tiny room talk', 'talk', 30, 'scheduled', ${venue.id}, ${slot.id}, ${proposer.id})
      returning id
    `
    privateScheduledId = scheduled.id
    const [selfHosted] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, status, is_self_hosted, custom_location,
                            telegram_group_url, self_hosted_start_time, self_hosted_end_time, host_id)
      values (${ev.id}, 'Kitchen table', 'discussion', 60, 'scheduled', true, ${`12 Secret Lane ${RUN}`},
              ${`https://t.me/pkgb_${RUN}`}, now() + interval '2 days', now() + interval '2 days 1 hour', ${proposer.id})
      returning id
    `
    privateSelfHostedId = selfHosted.id
    // Inserted through the proposal rules (window open, as the members); now program them.
    await sql`update sessions set status = 'scheduled' where id in ${sql([privateScheduledId, privateSelfHostedId])}`
    await sql`update events set status = 'live' where id = ${ev.id}`

    const [past] = await sql<{ id: string }[]>`
      select s.id from sessions s join events e on e.id = s.event_id
      where e.slug = 'past-gathering' and s.status = 'scheduled' order by s.created_at limit 1
    `
    pastSessionId = past.id
  })

  test.afterAll(async () => {
    if (!sql) return
    if (createdSessions.length) await sql`delete from sessions where id in ${sql(createdSessions)}`
    const dids = [proposer, cohost, stranger, organizer].filter(Boolean).map((a) => a.did)
    if (mintedGatheringDid) dids.push(mintedGatheringDid)
    const eventIds = [privateEventId, demo?.id].filter(Boolean) as string[]
    if (eventIds.length) await sql`delete from at_audit where event_id in ${sql(eventIds)}`
    if (dids.length) {
      await sql`delete from at_audit where actor_did in ${sql(dids)}`
      await sql`delete from at_records where did in ${sql(dids)}`
    }
    if (privateEventId) await sql`delete from events where id = ${privateEventId}`
    if (demo) await sql`delete from events where id = ${demo.id}`
    for (const did of dids) {
      await fetch(`${pdsUrl}/xrpc/com.atproto.admin.deleteAccount`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: adminAuth },
        body: JSON.stringify({ did }),
      })
    }
    await sql`delete from accounts where email like ${`pkgb+%-${RUN}@example.test`}`
    await sql`delete from auth_email_tokens where email like ${`pkgb+%-${RUN}@example.test`}`
    await sql.end()
  })

  test('a custodial proposer proposes: row, organizer notification, record in their own repo', async () => {
    const res = await api('/api/v1/sessions', {
      method: 'POST',
      cookie: proposer.cookie,
      json: {
        event_slug: openSlug,
        title: `Soil and software ${RUN}`,
        description: 'Composting as a protocol.',
        format: 'talk',
        duration: 30,
        topic_tags: ['commons'],
        host_name: 'Somebody Else',
      },
    })
    expect(res.status, res.text).toBe(201)
    sessionId = res.body.id
    createdSessions.push(sessionId)
    expect(res.body.atproto?.uri, JSON.stringify(res.body.atproto)).toMatch(/^at:\/\//)

    const [row] = await sql<{ host_id: string; host_name: string | null; status: string; proposal_uri: string; proposal_cid: string }[]>`
      select host_id, host_name, status, proposal_uri, proposal_cid from sessions where id = ${sessionId}
    `
    expect(row.host_id).toBe(proposer.id)
    expect(row.host_name, 'a free-text host name in the body is ignored').toBeNull()
    expect(row.status).toBe('approved') // the test gathering does not require approval
    expect(row.proposal_uri.startsWith(`at://${proposer.did}/schellingpoint.draft.proposal/`)).toBe(true)

    const notes = await sql`
      select 1 from notifications
      where user_id = ${organizer.id} and type = 'new_proposal' and data->>'session_id' = ${sessionId}
    `
    expect(notes.length).toBe(1)

    const record = await getRecord(row.proposal_uri)
    expect(record, 'proposal record exists on the local PDS').toBeTruthy()
    expect(record!.cid).toBe(row.proposal_cid)
    const json = JSON.stringify(record!.value)
    expect(record!.value.$type).toBe('schellingpoint.draft.proposal')
    expect(record!.value.title).toBe(`Soil and software ${RUN}`)
    expect(json).not.toContain(`Proposer ${RUN}`)
    expect(json).not.toContain('Somebody Else')
    for (const other of [cohost, stranger, organizer]) expect(json).not.toContain(other.did)
    expect(json).not.toContain('host')
  })

  test('the author edits the title: the record is rewritten with a new cid', async () => {
    const [before] = await sql<{ proposal_cid: string; proposal_uri: string }[]>`select proposal_cid, proposal_uri from sessions where id = ${sessionId}`
    const res = await api(`/api/v1/sessions/${sessionId}`, {
      method: 'PATCH',
      cookie: proposer.cookie,
      json: { title: `Soil and software, revised ${RUN}` },
    })
    expect(res.status, res.text).toBe(200)
    expect(res.body.session.title).toBe(`Soil and software, revised ${RUN}`)
    expect(res.body.atproto?.cid).toBeTruthy()
    const [after] = await sql<{ proposal_cid: string; proposal_uri: string }[]>`select proposal_cid, proposal_uri from sessions where id = ${sessionId}`
    expect(after.proposal_uri).toBe(before.proposal_uri)
    expect(after.proposal_cid).not.toBe(before.proposal_cid)
    const record = await getRecord(after.proposal_uri)
    expect(record!.cid).toBe(after.proposal_cid)
    expect(record!.value.title).toBe(`Soil and software, revised ${RUN}`)
  })

  test('a self-hosted proposal publishes only the proposer\'s public area, never the exact address', async () => {
    const exact = `1234 Secret Lane ${RUN}, Apt 5`
    const area = `Near Pearl St ${RUN}`
    const res = await api('/api/v1/sessions', {
      method: 'POST',
      cookie: proposer.cookie,
      json: {
        event_slug: openSlug,
        title: `Garden walk ${RUN}`,
        format: 'discussion',
        duration: 30,
        is_self_hosted: true,
        custom_location: exact,
        public_place: area,
      },
    })
    expect(res.status, res.text).toBe(201)
    const id = res.body.id as string
    createdSessions.push(id)
    const [row] = await sql<{ proposal_uri: string; proposal_cid: string }[]>`select proposal_uri, proposal_cid from sessions where id = ${id}`
    const record = await getRecord(row.proposal_uri)
    expect(record, 'proposal record exists on the local PDS').toBeTruthy()
    expect(record!.value.place).toBe(area)
    expect(JSON.stringify(record!.value)).not.toContain('Secret Lane')

    // Strangers see the public area but not the exact place.
    const seen = await api(`/api/v1/events/${openSlug}/sessions/${id}`, { cookie: stranger.cookie })
    expect(seen.status, seen.text).toBe(200)
    expect(seen.body.session.public_place).toBe(area)
    expect(seen.text).not.toContain('Secret Lane')

    // Changing only the exact address never touches the public record.
    const edit = await api(`/api/v1/sessions/${id}`, { method: 'PATCH', cookie: proposer.cookie, json: { custom_location: `${exact} (rear gate)` } })
    expect(edit.status, edit.text).toBe(200)
    const [after] = await sql<{ proposal_cid: string }[]>`select proposal_cid from sessions where id = ${id}`
    expect(after.proposal_cid).toBe(row.proposal_cid)
  })

  test('a non-author cannot edit; the author cannot change organizer-only columns', async () => {
    const other = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: stranger.cookie, json: { title: 'Hijacked' } })
    expect(other.status).toBe(403)

    const status = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: proposer.cookie, json: { status: 'scheduled' } })
    expect(status.status, status.text).toBe(403)
    expect(status.body.error).toMatch(/organizers/i)

    const [venue] = await sql<{ id: string }[]>`select id from venues where event_id = ${demo.id} limit 1`
    if (venue) {
      const move = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: proposer.cookie, json: { venue_id: venue.id } })
      expect(move.status, move.text).toBe(403)
    }
    const unsigned = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', json: { title: 'x' } })
    expect(unsigned.status).toBe(401)
    const [row] = await sql<{ title: string; status: string }[]>`select title, status from sessions where id = ${sessionId}`
    expect(row.status).toBe('approved')
    expect(row.title).toBe(`Soil and software, revised ${RUN}`)
  })

  test('a co-host accepts an invite: cohost record in THEIR repo strongRefs the current proposal', async () => {
    const invite = await api(`/api/sessions/${sessionId}/invites`, { method: 'POST', cookie: proposer.cookie })
    expect(invite.status, invite.text).toBe(201)
    const token = invite.body.token as string

    const strangerList = await api(`/api/sessions/${sessionId}/invites`, { cookie: stranger.cookie })
    expect(strangerList.status).toBe(403)

    const preview = await api(`/api/invite/${token}`)
    expect(preview.status).toBe(200)
    expect(preview.text).not.toContain(proposer.did)
    expect(preview.text).not.toContain(proposer.email)

    const accept = await api(`/api/invite/${token}/accept`, { method: 'POST', cookie: cohost.cookie })
    expect(accept.status, accept.text).toBe(200)
    expect(accept.body.atproto?.uri, JSON.stringify(accept.body.atproto)).toMatch(new RegExp(`^at://${cohost.did}/schellingpoint.draft.cohost/`))

    const again = await api(`/api/invite/${token}/accept`, { method: 'POST', cookie: stranger.cookie })
    expect(again.status).toBe(409)

    const [row] = await sql<{ cohost_uri: string }[]>`select cohost_uri from session_cohosts where session_id = ${sessionId} and user_id = ${cohost.id}`
    const [session] = await sql<{ proposal_uri: string; proposal_cid: string }[]>`select proposal_uri, proposal_cid from sessions where id = ${sessionId}`
    const record = await getRecord(row.cohost_uri)
    expect(record, 'cohost record exists').toBeTruthy()
    expect(record!.value.$type).toBe('schellingpoint.draft.cohost')
    expect(record!.value.proposal).toEqual({ uri: session.proposal_uri, cid: session.proposal_cid })

    const notes = await sql`select 1 from notifications where user_id = ${proposer.id} and type = 'cohost_accepted' and data->>'session_id' = ${sessionId}`
    expect(notes.length).toBe(1)
  })

  test('proposal content is the author\'s alone; organizers curate without touching the record', async () => {
    const [before] = await sql<{ proposal_cid: string; proposal_uri: string; title: string }[]>`
      select proposal_cid, proposal_uri, title from sessions where id = ${sessionId}
    `

    const organizerTitle = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: organizer.cookie, json: { title: 'Retitled by an organizer' } })
    expect(organizerTitle.status, organizerTitle.text).toBe(403)
    expect(organizerTitle.body.code).toBe('author_only')

    const cohostDescription = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: cohost.cookie, json: { description: 'Rewritten by a co-host' } })
    expect(cohostDescription.status, cohostDescription.text).toBe(403)
    const cohostTrack = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: cohost.cookie, json: { track_id: trackId } })
    expect(cohostTrack.status).toBe(403)

    const organizerTrack = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: organizer.cookie, json: { track_id: trackId } })
    expect(organizerTrack.status, organizerTrack.text).toBe(200)
    expect(organizerTrack.body.session.track.id).toBe(trackId)
    expect(organizerTrack.body.atproto, 'curation never writes into the proposer\'s repo').toBeUndefined()

    const [after] = await sql<{ proposal_cid: string; title: string; description: string | null; track_id: string }[]>`
      select proposal_cid, title, description, track_id from sessions where id = ${sessionId}
    `
    expect(after.proposal_cid).toBe(before.proposal_cid)
    expect(after.title).toBe(before.title)
    expect(after.description).toBe('Composting as a protocol.')
    expect(after.track_id).toBe(trackId)
    const record = await getRecord(before.proposal_uri)
    expect(record!.cid, 'the author\'s record is untouched').toBe(before.proposal_cid)

    const cohostTelegram = await api(`/api/v1/sessions/${sessionId}`, { method: 'PATCH', cookie: cohost.cookie, json: { telegram_group_url: `https://t.me/pkgb_cohost_${RUN}` } })
    expect(cohostTelegram.status, 'co-hosts still manage attendee logistics').toBe(200)
    expect(cohostTelegram.body.atproto).toBeUndefined()
  })

  test('an organizer asks the proposer to update instead of editing', async () => {
    const stranger403 = await api(`/api/v1/sessions/${sessionId}/request-update`, { method: 'POST', cookie: cohost.cookie, json: { message: 'x' } })
    expect(stranger403.status).toBe(403)
    const empty = await api(`/api/v1/sessions/${sessionId}/request-update`, { method: 'POST', cookie: organizer.cookie, json: { message: '  ' } })
    expect(empty.status).toBe(400)

    const ask = await api(`/api/v1/sessions/${sessionId}/request-update`, {
      method: 'POST',
      cookie: organizer.cookie,
      json: { message: `Please add what people should bring ${RUN}` },
    })
    expect(ask.status, ask.text).toBe(200)
    expect(ask.body.sent).toBe(true)
    const notes = await sql<{ body: string; data: Record<string, unknown>; action_url: string }[]>`
      select body, data, action_url from notifications
      where user_id = ${proposer.id} and type = 'proposal_needs_review' and data->>'session_id' = ${sessionId}
    `
    expect(notes.length).toBe(1)
    expect(notes[0].body).toBe(`Please add what people should bring ${RUN}`)
    expect(notes[0].action_url).toBe(`/e/${openSlug}/sessions/${sessionId}`)
    expect(JSON.stringify(notes[0].data)).not.toContain(organizer.id)
  })

  test('organizers edit a host-less session\'s content directly', async () => {
    // Inserted as the organizer (the program rules let organizers curate), then left without an author.
    const [row] = await sql<{ id: string }[]>`
      insert into sessions (event_id, title, format, duration, host_id)
      values (${demo.id}, ${`Opening circle ${RUN}`}, 'discussion', 30, ${organizer.id})
      returning id
    `
    await sql`update sessions set host_id = null, status = 'approved' where id = ${row.id}`
    createdSessions.push(row.id)

    const edit = await api(`/api/v1/sessions/${row.id}`, { method: 'PATCH', cookie: organizer.cookie, json: { title: `Opening circle, revised ${RUN}` } })
    expect(edit.status, edit.text).toBe(200)
    expect(edit.body.session.title).toBe(`Opening circle, revised ${RUN}`)
    expect(edit.body.session.unclaimed).toBe(true)
    expect(edit.body.session.viewer.can_edit_content).toBe(true)
    expect(edit.body.atproto).toBeUndefined()

    const byStranger = await api(`/api/v1/sessions/${row.id}`, { method: 'PATCH', cookie: stranger.cookie, json: { title: 'nope' } })
    expect(byStranger.status).toBe(403)
    const ask = await api(`/api/v1/sessions/${row.id}/request-update`, { method: 'POST', cookie: organizer.cookie, json: { message: 'hello' } })
    expect(ask.status).toBe(409)
  })

  test('favorites round trip', async () => {
    const put = await api(`/api/v1/events/${openSlug}/favorites/${sessionId}`, { method: 'PUT', cookie: stranger.cookie })
    expect(put.status, put.text).toBe(200)
    const listed = await api(`/api/v1/events/${openSlug}/sessions?favorites=1`, { cookie: stranger.cookie })
    expect(listed.status).toBe(200)
    expect(listed.body.sessions.map((s: { id: string }) => s.id)).toContain(sessionId)
    expect(listed.body.sessions.find((s: { id: string }) => s.id === sessionId).is_favorite).toBe(true)
    const del = await api(`/api/v1/events/${openSlug}/favorites/${sessionId}`, { method: 'DELETE', cookie: stranger.cookie })
    expect(del.status).toBe(200)
    const after = await api(`/api/v1/events/${openSlug}/sessions?favorites=1`, { cookie: stranger.cookie })
    expect(after.body.sessions.map((s: { id: string }) => s.id)).not.toContain(sessionId)
    const anonymous = await api(`/api/v1/events/${openSlug}/favorites/${sessionId}`, { method: 'PUT' })
    expect(anonymous.status).toBe(401)
  })

  test('RSVP round trip, capacity and waitlist promotion', async () => {
    const past = await api(`/api/v1/events/past-gathering/rsvps/${pastSessionId}`, { method: 'PUT', cookie: stranger.cookie, json: {} })
    expect(past.status, past.text).toBe(200)
    expect(past.body.my_rsvp.status).toBe('confirmed')
    const cancel = await api(`/api/v1/events/past-gathering/rsvps/${pastSessionId}`, { method: 'DELETE', cookie: stranger.cookie })
    expect(cancel.status).toBe(200)
    expect(cancel.body.my_rsvp).toBeNull()

    const notScheduled = await api(`/api/v1/events/${openSlug}/rsvps/${sessionId}`, { method: 'PUT', cookie: stranger.cookie, json: {} })
    expect(notScheduled.status).toBe(403)

    const first = await api(`/api/v1/events/${privateSlug}/rsvps/${privateScheduledId}`, { method: 'PUT', cookie: proposer.cookie, json: {} })
    expect(first.status, first.text).toBe(200)
    expect(first.body.my_rsvp.status).toBe('confirmed')
    const second = await api(`/api/v1/events/${privateSlug}/rsvps/${privateScheduledId}`, { method: 'PUT', cookie: cohost.cookie, json: { status: 'confirmed' } })
    expect(second.body.my_rsvp).toEqual({ status: 'waitlist', waitlist_position: 1, public: false })
    expect(second.body.rsvp_count).toBe(1)
    expect(second.body.waitlist_count).toBe(1)

    await api(`/api/v1/events/${privateSlug}/rsvps/${privateScheduledId}`, { method: 'DELETE', cookie: proposer.cookie })
    const promoted = await api(`/api/v1/events/${privateSlug}/sessions/${privateScheduledId}`, { cookie: cohost.cookie })
    expect(promoted.body.session.my_rsvp.status).toBe('confirmed')
  })

  test('private event sessions answer 404 to strangers', async () => {
    for (const path of [
      `/api/v1/events/${privateSlug}/sessions`,
      `/api/v1/events/${privateSlug}/sessions/${privateScheduledId}`,
      `/api/v1/events/${privateSlug}/tracks`,
      `/api/v1/events/${privateSlug}/sessions/${privateScheduledId}/resources`,
      `/api/v1/events/${privateSlug}/calendar`,
    ]) {
      expect((await api(path, { cookie: stranger.cookie })).status, path).toBe(404)
      expect((await api(path)).status, path).toBe(404)
    }
    expect((await api(`/api/v1/events/${privateSlug}/favorites/${privateScheduledId}`, { method: 'PUT', cookie: stranger.cookie })).status).toBe(404)
    expect((await api(`/api/v1/sessions/${privateScheduledId}`, { method: 'PATCH', cookie: stranger.cookie, json: { title: 'x' } })).status).toBe(404)
  })

  test('attendee-only details are served only to confirmed RSVPs, hosts and organizers', async () => {
    const path = `/api/v1/events/${privateSlug}/sessions/${privateSelfHostedId}`
    const member = await api(path, { cookie: cohost.cookie })
    expect(member.status).toBe(200)
    expect(member.body.session.has_private_location).toBe(true)
    expect(member.body.session.has_telegram_group).toBe(true)
    expect('custom_location' in member.body.session).toBe(false)
    expect('telegram_group_url' in member.body.session).toBe(false)
    expect(member.text).not.toContain('Secret Lane')
    expect(member.text).not.toContain(`pkgb_${RUN}`)

    const list = await api(`/api/v1/events/${privateSlug}/sessions`, { cookie: cohost.cookie })
    expect(list.text).not.toContain('Secret Lane')
    expect(list.text).not.toContain(`pkgb_${RUN}`)

    const rsvp = await api(`/api/v1/events/${privateSlug}/rsvps/${privateSelfHostedId}`, { method: 'PUT', cookie: cohost.cookie, json: {} })
    expect(rsvp.body.my_rsvp.status).toBe('confirmed')
    const confirmed = await api(path, { cookie: cohost.cookie })
    expect(confirmed.body.session.custom_location).toBe(`12 Secret Lane ${RUN}`)
    expect(confirmed.body.session.telegram_group_url).toBe(`https://t.me/pkgb_${RUN}`)

    const host = await api(path, { cookie: proposer.cookie })
    expect(host.body.session.custom_location).toBe(`12 Secret Lane ${RUN}`)

    const ics = await api(`/api/v1/events/${privateSlug}/calendar`, { cookie: cohost.cookie })
    expect(ics.status).toBe(200)
    expect(ics.text).toContain('BEGIN:VCALENDAR')
    expect(ics.text).not.toContain('Secret Lane')
  })

  test('list and detail JSON carry no vote counts, emails, Telegram/ENS or foreign DIDs', async () => {
    // Outside the membership boundary: signed out.
    const outside = [
      await api(`/api/v1/events/${openSlug}/sessions`),
      await api(`/api/v1/events/${openSlug}/sessions/${sessionId}`),
    ]
    // Inside it: members of this gathering, who may open these people's profile pages. `stranger`
    // joined earlier in this serial suite by saving a favourite, so their view is a member's.
    const inside = [
      await api(`/api/v1/events/${openSlug}/sessions`, { cookie: stranger.cookie }),
      await api(`/api/v1/events/${openSlug}/sessions/${sessionId}`, { cookie: stranger.cookie }),
      await api(`/api/v1/events/${openSlug}/sessions?sort=title`, { cookie: organizer.cookie }),
      await api(`/api/v1/events/${openSlug}/sessions/${sessionId}`, { cookie: organizer.cookie }),
    ]
    for (const v of [...outside, ...inside]) {
      expect(v.status).toBe(200)
      for (const forbidden of ['total_votes', 'voter_count', 'total_credits', 'email', 'host_name', '"telegram"', '"ens"', 'user_id', 'host_id']) {
        expect(v.text, forbidden).not.toContain(forbidden)
      }
      for (const secret of [proposer.email, cohost.email, `tg_${RUN}`, `tgc_${RUN}`, `ens${RUN}.eth`, stranger.did, organizer.did, proposer.id, cohost.id]) {
        expect(v.text, 'no private value').not.toContain(secret)
      }
    }
    for (const v of outside) {
      // No `did` field at all, and the only DID anywhere is the proposer's, inside their own
      // public proposal URI.
      expect(v.text, '"did"').not.toContain('"did"')
      expect(v.text, 'a co-host DID').not.toContain(cohost.did)
      const dids = v.text.match(/did:[a-z]+:[a-z0-9]+/g) ?? []
      for (const did of dids) expect([proposer.did, mintedGatheringDid, demo.actor_did]).toContain(did)
    }
    for (const v of inside) {
      // A member additionally gets the DID of each host and accepted co-host, so their name can
      // link to the members-only profile page at /e/[slug]/people/[did] (design §3.2). Each of
      // those DIDs is already in a record its own holder wrote (the proposal, the co-host
      // confirmation); nobody else's DID appears.
      const dids = v.text.match(/did:[a-z]+:[a-z0-9]+/g) ?? []
      expect(dids.length).toBeGreaterThan(0)
      for (const did of dids) expect([proposer.did, cohost.did, mintedGatheringDid, demo.actor_did]).toContain(did)
    }
    const detail = inside[1].body.session
    expect(detail.host.display_name).toBe(`Proposer ${RUN}`)
    expect(detail.host.handle).toMatch(new RegExp(`\\.${handleDomain}$`))
    expect(detail.cohosts).toHaveLength(1)
    expect(detail.cohosts[0].display_name).toBe(`Cohost ${RUN}`)
    expect(detail.viewer).toEqual({ is_host: false, is_cohost: false, is_organizer: false, can_edit_content: false, can_edit: false, can_manage: false })
    expect(inside[3].body.session.viewer.is_organizer).toBe(true)
    expect(inside[3].body.session.host.did).toBe(proposer.did)
    expect(inside[3].body.session.cohosts[0].did).toBe(cohost.did)
    // Signed out, the same session names nobody's DID but the proposal author's, in its URI.
    expect(outside[1].body.session.host.did).toBeUndefined()
  })

  test('a co-host steps down (deleting their record); the author withdraws the proposal', async () => {
    const [row] = await sql<{ cohost_uri: string }[]>`select cohost_uri from session_cohosts where session_id = ${sessionId} and user_id = ${cohost.id}`
    const organizerRemoval = await api(`/api/sessions/${sessionId}/cohosts/me`, { method: 'DELETE', cookie: organizer.cookie })
    expect(organizerRemoval.status).toBe(404)
    const stepDown = await api(`/api/sessions/${sessionId}/cohosts/me`, { method: 'DELETE', cookie: cohost.cookie })
    expect(stepDown.status, stepDown.text).toBe(200)
    expect(await getRecord(row.cohost_uri)).toBeNull()

    const organizerDelete = await api(`/api/v1/sessions/${sessionId}`, { method: 'DELETE', cookie: organizer.cookie })
    expect(organizerDelete.status).toBe(403)

    const [session] = await sql<{ proposal_uri: string }[]>`select proposal_uri from sessions where id = ${sessionId}`
    const withdraw = await api(`/api/v1/sessions/${sessionId}`, { method: 'DELETE', cookie: proposer.cookie })
    expect(withdraw.status, withdraw.text).toBe(200)
    expect(withdraw.body.deleted).toBe(true)
    expect(await getRecord(session.proposal_uri)).toBeNull()
    expect((await sql`select 1 from sessions where id = ${sessionId}`).length).toBe(0)
  })
})
