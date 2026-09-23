import { test, expect, type APIRequestContext } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import postgres from 'postgres'
import { createTestAccount, createTestGathering, type TestAccount, type TestGathering } from './helpers/gathering'

/**
 * Proposals & scheduling, second wave (feature inventory P2-11 … P2-16):
 *
 *   room features       the vocabulary a proposal's "what the room needs" is chosen from
 *   proposal quota      visible before it is hit; a clear 409 instead of a bare 23514
 *   session mergers     request / accept / decline, who may do what, what becomes invisible
 *   merged tallies      one ballot token that backed both sessions counts once, no ×1.1 bonus
 *   round controls      open / extend / force-close, audited, ballot-key invariants untouched
 *
 * Everything is created here and removed in afterAll; the seeded gatherings are never touched.
 */
loadEnvConfig(process.cwd(), true)

const base = process.env.TEST_BASE_URL || 'http://localhost:3001'
const databaseUrl = process.env.DATABASE_URL || ''
const isLocal = (() => {
  try {
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(databaseUrl).hostname)
  } catch {
    return false
  }
})()

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

test.describe('proposals & scheduling, second wave', () => {
  test.skip(!isLocal || !process.env.PDS_URL || !process.env.PDS_ADMIN_PASSWORD, 'needs the local stack: DATABASE_URL on localhost, PDS_URL, PDS_ADMIN_PASSWORD')
  test.describe.configure({ mode: 'serial' })

  let raw: postgres.Sql
  let gathering: TestGathering
  let organizer: TestAccount
  let alice: TestAccount
  let bob: TestAccount
  let outsider: TestAccount
  /** Alice's proposal (the merge source) and Bob's (the target). */
  let sourceId = ''
  let targetId = ''
  let mergeRequestId = ''
  /** Alice's second proposal, used as a second merge source. */
  let spareId = ''
  /** The round as `PATCH …/rounds` returned it while no ballot existed. */
  let extendedWithoutBallots: Record<string, unknown> = {}

  const api = (request: APIRequestContext, method: Method, url: string, cookie?: string, data?: unknown) =>
    request.fetch(`${base}${url}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(method === 'GET' ? {} : { origin: base }) },
      ...(data !== undefined ? { data } : {}),
    })

  const join = async (request: APIRequestContext, account: TestAccount) =>
    api(request, 'POST', `/api/v1/events/${gathering.slug}/me`, account.cookie, {})

  test.beforeAll(async () => {
    test.setTimeout(240_000)
    raw = postgres(databaseUrl, { max: 4, onnotice: () => {} })
    gathering = await createTestGathering(raw, { tag: 'prop2', status: 'proposals_open', withProgram: true, policyThresholds: { feedbackK: 2 } })
    organizer = await createTestAccount('prop2-org', { sql: raw })
    alice = await createTestAccount('prop2-alice', { sql: raw })
    bob = await createTestAccount('prop2-bob', { sql: raw })
    outsider = await createTestAccount('prop2-out', { sql: raw })
    await raw`insert into event_members (event_id, user_id, role) values (${gathering.id}, ${organizer.id}, 'owner')
              on conflict (event_id, user_id) do update set role = 'owner'`
    // A small cap, so the quota is reachable inside one test.
    await raw`update events set max_proposals_per_user = 2 where id = ${gathering.id}`
  })

  test.afterAll(async () => {
    await gathering?.cleanup()
    await organizer?.cleanup()
    await alice?.cleanup()
    await bob?.cleanup()
    await outsider?.cleanup()
    await raw?.end()
  })

  /* ─────────────────────── what the room needs (P2-11) ─────────────────────── */

  test('the room-feature vocabulary is the union of the gathering’s rooms, and names no room', async ({ request }) => {
    await join(request, alice)
    const res = await api(request, 'GET', `/api/v1/events/${gathering.slug}/room-features`, alice.cookie)
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    expect(body.features).toEqual(['microphone', 'projector', 'whiteboard'])
    expect(body.suggested).toEqual([])
    const blob = await res.text()
    for (const room of ['Main Hall', 'Workshop Room', 'Garden']) expect(blob).not.toContain(room)
    expect(blob).not.toContain('capacity')
  })

  test('a proposal carries required_features through create, read and edit', async ({ request }) => {
    const created = await api(request, 'POST', '/api/v1/sessions', alice.cookie, {
      event_slug: gathering.slug,
      title: `prop2 source ${gathering.slug}`,
      format: 'talk',
      duration: 60,
      required_features: ['projector', 'a flipchart'],
    })
    expect(created.status(), await created.text()).toBe(201)
    sourceId = (await created.json()).id

    const read = await api(request, 'GET', `/api/v1/events/${gathering.slug}/sessions/${sourceId}`, alice.cookie)
    expect(read.status()).toBe(200)
    expect((await read.json()).session.required_features.sort()).toEqual(['a flipchart', 'projector'])

    // The author edits them; the field is proposal content, so only they may.
    const edited = await api(request, 'PATCH', `/api/v1/sessions/${sourceId}`, alice.cookie, { required_features: ['whiteboard'] })
    expect(edited.status(), await edited.text()).toBe(200)
    expect((await edited.json()).session.required_features).toEqual(['whiteboard'])

    await join(request, bob)
    const refused = await api(request, 'PATCH', `/api/v1/sessions/${sourceId}`, bob.cookie, { required_features: ['projector'] })
    expect(refused.status()).toBe(403)
  })

  /* ─────────────────────── the visible quota (P2-12) ─────────────────────── */

  test('the proposal quota is visible, and the cap answers 409 ProposalLimit rather than 23514', async ({ request }) => {
    const me = await api(request, 'GET', `/api/v1/events/${gathering.slug}/me`, alice.cookie)
    expect(me.status()).toBe(200)
    expect((await me.json()).proposals).toMatchObject({ used: 1, limit: 2, remaining: 1, atLimit: false })

    const second = await api(request, 'POST', '/api/v1/sessions', alice.cookie, {
      event_slug: gathering.slug, title: `prop2 spare ${gathering.slug}`, format: 'talk', duration: 60,
    })
    expect(second.status(), await second.text()).toBe(201)
    spareId = (await second.json()).id

    const atLimit = await api(request, 'GET', `/api/v1/events/${gathering.slug}/me`, alice.cookie)
    expect((await atLimit.json()).proposals).toMatchObject({ used: 2, limit: 2, remaining: 0, atLimit: true })

    const third = await api(request, 'POST', '/api/v1/sessions', alice.cookie, {
      event_slug: gathering.slug, title: `prop2 too many ${gathering.slug}`, format: 'talk', duration: 60,
    })
    expect(third.status()).toBe(409)
    const body = await third.json()
    expect(body.code).toBe('ProposalLimit')
    expect(body.error).toContain('all 2 of your proposals')
    expect(body.proposals).toMatchObject({ used: 2, limit: 2, atLimit: true })

    // A gathering with no cap reports no limit at all.
    await raw`update events set max_proposals_per_user = 0 where id = ${gathering.id}`
    const uncapped = await api(request, 'GET', `/api/v1/events/${gathering.slug}/me`, alice.cookie)
    expect((await uncapped.json()).proposals).toMatchObject({ limit: null, remaining: null, atLimit: false })
    await raw`update events set max_proposals_per_user = 5 where id = ${gathering.id}`
  })

  test('owners and admins are not capped, because the proposal trigger exempts them', async ({ request }) => {
    // `enforce_event_proposal_rules` returns early for owner/admin, so the quota has to agree:
    // a cap the database would not enforce must not be shown as one, or the form blocks a
    // submit the server would have accepted.
    await raw`update events set max_proposals_per_user = 1 where id = ${gathering.id}`
    for (const n of [1, 2]) {
      const created = await api(request, 'POST', '/api/v1/sessions', organizer.cookie, {
        event_slug: gathering.slug, title: `prop2 owner ${n} ${gathering.slug}`, format: 'talk', duration: 60,
      })
      expect(created.status(), await created.text()).toBe(201)
    }
    const owner = await api(request, 'GET', `/api/v1/events/${gathering.slug}/me`, organizer.cookie)
    expect((await owner.json()).proposals).toMatchObject({ used: 2, limit: null, remaining: null, atLimit: false })

    // An attendee at the same gathering still sees the cap.
    const attendee = await api(request, 'GET', `/api/v1/events/${gathering.slug}/me`, alice.cookie)
    expect((await attendee.json()).proposals).toMatchObject({ limit: 1, atLimit: true })

    await raw`update events set max_proposals_per_user = 5 where id = ${gathering.id}`
  })

  test('the propose form offers the room vocabulary and refuses to submit at the cap', async ({ browser }) => {
    await raw`update events set max_proposals_per_user = 2 where id = ${gathering.id}`
    // The onboarding dialog would sit over the form; this account has already been through it.
    await raw`update profiles set onboarding_completed = true where id = ${alice.id}`
    const [name, ...rest] = alice.cookie.split('=')
    const context = await browser.newContext({ baseURL: base, viewport: { width: 1280, height: 900 } })
    await context.addCookies([{ name, value: rest.join('='), url: base }])
    const page = await context.newPage()
    try {
      await page.goto(`/e/${gathering.slug}/propose`)
      await expect(page.getByRole('heading', { name: 'Propose a session' })).toBeVisible()

      // "What the room needs" is the union of this gathering's rooms, as checkbox chips.
      const features = page.getByTestId('propose-required-features')
      await expect(features).toContainText('What the room needs')
      for (const feature of ['projector', 'whiteboard', 'microphone']) {
        await expect(features.getByRole('button', { name: feature, exact: true })).toBeVisible()
      }
      await features.getByRole('button', { name: 'projector', exact: true }).click()
      await expect(features.getByRole('button', { name: 'projector', exact: true })).toHaveAttribute('aria-pressed', 'true')

      // Alice is at the cap: a plain sentence, and the submit button is not offered.
      await expect(page.getByTestId('proposal-quota')).toContainText('all 2 of your proposals')
      await expect(page.getByRole('button', { name: 'Propose a session' })).toBeDisabled()
    } finally {
      await context.close()
      await raw`update events set max_proposals_per_user = 5 where id = ${gathering.id}`
    }
  })

  /* ─────────────────────── mergers (P2-16) ─────────────────────── */

  test('only the source’s own proposer may offer a merger', async ({ request }) => {
    const created = await api(request, 'POST', '/api/v1/sessions', bob.cookie, {
      event_slug: gathering.slug, title: `prop2 target ${gathering.slug}`, format: 'talk', duration: 60,
    })
    expect(created.status(), await created.text()).toBe(201)
    targetId = (await created.json()).id

    const url = `/api/v1/sessions/${sourceId}/merge`
    expect((await api(request, 'POST', url, undefined, { target_session_id: targetId })).status()).toBe(401)
    // Bob is not the source's proposer, and neither is the organizer: curation is not authorship.
    expect((await api(request, 'POST', url, bob.cookie, { target_session_id: targetId })).status()).toBe(403)
    expect((await api(request, 'POST', url, organizer.cookie, { target_session_id: targetId })).status()).toBe(403)
    expect((await api(request, 'POST', url, alice.cookie, { target_session_id: sourceId })).status()).toBe(400)

    const cross = await request.fetch(`${base}${url}`, {
      method: 'POST',
      headers: { cookie: alice.cookie, origin: 'https://evil.example' },
      data: { target_session_id: targetId },
    })
    expect(cross.status()).toBe(403)

    const offered = await api(request, 'POST', url, alice.cookie, { target_session_id: targetId, message: 'Same ground, better together.' })
    expect(offered.status(), await offered.text()).toBe(201)
    const offer = (await offered.json()).request
    mergeRequestId = offer.id
    expect(offer).toMatchObject({ status: 'pending', source: { id: sourceId }, target: { id: targetId } })

    // One live offer per source.
    const again = await api(request, 'POST', url, alice.cookie, { target_session_id: targetId })
    expect(again.status()).toBe(409)
    expect((await again.json()).code).toBe('MergePending')

    // The target's proposer hears about it.
    const [note] = await raw<{ title: string; body: string }[]>`
      select title, body from notifications
      where event_id = ${gathering.id} and user_id = ${bob.id} and type = 'proposal_needs_review'
      order by created_at desc limit 1
    `
    expect(note?.title).toContain('merge')
    expect(note?.body).toContain('no bonus, because votes are unlinkable')
  })

  test('declining leaves both sessions alone; only the target’s proposer may answer', async ({ request }) => {
    const url = `/api/v1/sessions/${sourceId}/merge`
    // Alice offered it; she cannot also accept it.
    const selfAccept = await api(request, 'PATCH', url, alice.cookie, { request_id: mergeRequestId, action: 'accept' })
    expect(selfAccept.status()).toBe(403)
    expect((await api(request, 'PATCH', url, outsider.cookie, { request_id: mergeRequestId, action: 'decline' })).status()).toBe(403)

    const declined = await api(request, 'PATCH', url, bob.cookie, { request_id: mergeRequestId, action: 'decline', reason: 'Different audiences.' })
    expect(declined.status(), await declined.text()).toBe(200)
    expect((await declined.json()).request).toMatchObject({ status: 'declined', declineReason: 'Different audiences.' })

    const [row] = await raw<{ merged_into: string | null; is_votable: boolean }[]>`
      select merged_into, is_votable from sessions where id = ${sourceId}
    `
    expect(row.merged_into).toBeNull()
    expect(row.is_votable).toBe(true)

    // A decided offer is decided.
    const twice = await api(request, 'PATCH', url, bob.cookie, { request_id: mergeRequestId, action: 'accept' })
    expect(twice.status()).toBe(409)
    expect((await twice.json()).code).toBe('MergeDecided')
  })

  test('accepting hides the source from the lists, stops its votes, and leaves its record alone', async ({ request }) => {
    const url = `/api/v1/sessions/${sourceId}/merge`
    const offered = await api(request, 'POST', url, alice.cookie, { target_session_id: targetId })
    expect(offered.status(), await offered.text()).toBe(201)
    const second = (await offered.json()).request.id

    const accepted = await api(request, 'PATCH', url, bob.cookie, { request_id: second, action: 'accept' })
    expect(accepted.status(), await accepted.text()).toBe(200)
    expect((await accepted.json()).request.status).toBe('accepted')

    const [row] = await raw<{ merged_into: string | null; is_votable: boolean; proposal_uri: string | null }[]>`
      select merged_into, is_votable, proposal_uri from sessions where id = ${sourceId}
    `
    expect(row.merged_into).toBe(targetId)
    expect(row.is_votable).toBe(false)

    // Out of the lists for everyone else…
    const listed = await api(request, 'GET', `/api/v1/events/${gathering.slug}/sessions?status=all`, outsider.cookie)
    const ids = (await listed.json()).sessions.map((s: { id: string }) => s.id)
    expect(ids).not.toContain(sourceId)
    expect(ids).toContain(targetId)

    // …but still there for its own proposer, and still readable at its URL, saying where it went.
    const mine = await api(request, 'GET', `/api/v1/events/${gathering.slug}/sessions?status=all&mine=1`, alice.cookie)
    expect((await mine.json()).sessions.map((s: { id: string }) => s.id)).toContain(sourceId)
    const detail = await api(request, 'GET', `/api/v1/events/${gathering.slug}/sessions/${sourceId}`, outsider.cookie)
    expect(detail.status()).toBe(200)
    expect((await detail.json()).session.merged_into).toMatchObject({ id: targetId })

    // Nothing was written into Alice's repository on her behalf: the proposal record is as it was.
    const [after] = await raw<{ proposal_uri: string | null }[]>`select proposal_uri from sessions where id = ${sourceId}`
    expect(after.proposal_uri).toBe(row.proposal_uri)

    // A merged session cannot be merged again, or merged away.
    const twice = await api(request, 'POST', url, alice.cookie, { target_session_id: targetId })
    expect(twice.status()).toBe(409)
    expect((await twice.json()).code).toBe('AlreadyMerged')
  })

  test('a merge target cannot be withdrawn, and undoing a merger makes the source votable again', async ({ request }) => {
    // Deleting the target would clear `merged_into` and leave the source visible but unvotable,
    // so its votes would be dropped at close with nobody told. Both the route and the FK refuse.
    const refused = await api(request, 'DELETE', `/api/v1/sessions/${targetId}`, bob.cookie)
    expect(refused.status(), await refused.text()).toBe(409)
    const body = await refused.json()
    expect(body.code).toBe('MergeTarget')
    expect(body.mergedSources).toBe(1)
    // Nothing happened to either session.
    const [still] = await raw<{ merged_into: string | null }[]>`select merged_into from sessions where id = ${sourceId}`
    expect(still.merged_into).toBe(targetId)

    // Undoing the merger restores `is_votable` in the same statement as clearing `merged_into`.
    const accepted = await api(request, 'GET', `/api/v1/sessions/${sourceId}/merge`, alice.cookie)
    const inForce = ((await accepted.json()).requests as Array<{ id: string; status: string }>).find((r) => r.status === 'accepted')!
    expect((await api(request, 'PATCH', `/api/v1/sessions/${sourceId}/merge`, outsider.cookie, { request_id: inForce.id, action: 'unmerge' })).status()).toBe(403)

    const undone = await api(request, 'PATCH', `/api/v1/sessions/${sourceId}/merge`, alice.cookie, { request_id: inForce.id, action: 'unmerge' })
    expect(undone.status(), await undone.text()).toBe(200)
    const [restored] = await raw<{ merged_into: string | null; is_votable: boolean }[]>`
      select merged_into, is_votable from sessions where id = ${sourceId}
    `
    expect(restored.merged_into).toBeNull()
    expect(restored.is_votable).toBe(true)

    // Back in the lists, and the target may be withdrawn again (we do not actually withdraw it).
    const listed = await api(request, 'GET', `/api/v1/events/${gathering.slug}/sessions?status=all`, outsider.cookie)
    expect((await listed.json()).sessions.map((x: { id: string }) => x.id)).toContain(sourceId)

    // Put the merger back for the tally test that follows.
    const again = await api(request, 'POST', `/api/v1/sessions/${sourceId}/merge`, alice.cookie, { target_session_id: targetId })
    expect(again.status(), await again.text()).toBe(201)
    const reAccept = await api(request, 'PATCH', `/api/v1/sessions/${sourceId}/merge`, bob.cookie, {
      request_id: (await again.json()).request.id, action: 'accept',
    })
    expect(reAccept.status(), await reAccept.text()).toBe(200)
  })

  test('accepting re-checks the request-time guards under the lock', async ({ request }) => {
    const url = `/api/v1/sessions/${spareId}/merge`
    const offered = await api(request, 'POST', url, alice.cookie, { target_session_id: targetId })
    expect(offered.status(), await offered.text()).toBe(201)
    const offer = (await offered.json()).request.id

    // The source reached the published schedule while the offer was waiting.
    await raw`update sessions set calendar_event_uri = 'at://did:plc:test/community.lexicon.calendar.event/x' where id = ${spareId}`
    const published = await api(request, 'PATCH', url, bob.cookie, { request_id: offer, action: 'accept' })
    expect(published.status()).toBe(409)
    expect((await published.json()).code).toBe('MergePublished')
    await raw`update sessions set calendar_event_uri = null where id = ${spareId}`

    // The gathering moved past the phase where proposals may be rearranged.
    await raw`update events set status = 'completed' where id = ${gathering.id}`
    const closed = await api(request, 'PATCH', url, bob.cookie, { request_id: offer, action: 'accept' })
    expect(closed.status()).toBe(409)
    expect((await closed.json()).code).toBe('MergeClosed')
    await raw`update events set status = 'proposals_open' where id = ${gathering.id}`

    // Nothing was merged by either refusal.
    const [untouched] = await raw<{ merged_into: string | null }[]>`select merged_into from sessions where id = ${spareId}`
    expect(untouched.merged_into).toBeNull()

    const declined = await api(request, 'PATCH', url, bob.cookie, { request_id: offer, action: 'decline' })
    expect(declined.status(), await declined.text()).toBe(200)
  })

  /* ────────────── round controls and the merged tally (P2-14, §5.4a) ────────────── */

  test('organizer round controls: open, extend, force-close — audited, and never a count', async ({ request }) => {
    await raw`update events set status = 'voting_open' where id = ${gathering.id}`
    const url = `/api/v1/events/${gathering.slug}/rounds`

    expect((await api(request, 'GET', url, alice.cookie)).status()).toBe(403)
    expect((await api(request, 'POST', url, alice.cookie, {})).status()).toBe(403)
    expect((await api(request, 'POST', url, undefined, {})).status()).toBe(401)

    const opened = await api(request, 'POST', url, organizer.cookie, { round: 'pre' })
    expect(opened.status(), await opened.text()).toBe(201)
    const round = (await opened.json()).round
    expect(round.status).toBe('open')

    // Extending moves the close later; shortening it is refused (close the round instead).
    const later = new Date(new Date(round.closesAt).getTime() + 3_600_000).toISOString()
    const extended = await api(request, 'PATCH', url, organizer.cookie, { round: 'pre', closesAt: later })
    expect(extended.status(), await extended.text()).toBe(200)
    extendedWithoutBallots = (await extended.json()).round
    expect(new Date(extendedWithoutBallots.closesAt as string).getTime()).toBe(new Date(later).getTime())
    // Extending writes `closes_at` and nothing else: the rules of an open round are not
    // re-derived from the event behind the voters' backs.
    expect(extendedWithoutBallots).toMatchObject({
      id: round.id,
      mechanism: round.mechanism,
      credits: round.credits,
      opensAt: round.opensAt,
      finalizedAt: null,
      status: 'open',
    })
    const shortened = await api(request, 'PATCH', url, organizer.cookie, { round: 'pre', closesAt: round.closesAt })
    expect(shortened.status()).toBe(400)

    // The audit is there, and carries no count.
    const state = await api(request, 'GET', url, organizer.cookie)
    expect(state.status()).toBe(200)
    const body = await state.json()
    expect(body.actions.map((a: { action: string }) => a.action)).toEqual(['extend', 'open'])
    const blob = await state.text()
    for (const key of ['votes', 'voters', 'credits":', 'ballot']) {
      if (key === 'credits":') continue // the round's credit budget is a rule, not a count
      expect(blob).not.toContain(key)
    }
  })

  test('at close, a merged session’s votes join the target, deduplicated by ballot token, with no ×1.1 bonus', async ({ request }) => {
    const url = `/api/v1/events/${gathering.slug}/rounds`
    const [round] = await raw<{ id: string }[]>`
      select id from vote_rounds where event_id = ${gathering.id} and phase = 'pre-event' and finalized_at is null
    `
    expect(round).toBeTruthy()

    // Alice backed only the merged source (3 votes). Bob backed both — 2 on the source, 4 on the
    // target — so his single ballot token must count ONCE for the target, at the larger figure.
    // Under the PRD's arithmetic the target would read 3 + 2 + 4 = 9 votes × 1.1; here it is
    // 3 (Alice) + 4 (Bob's larger) = 7, from 2 voters.
    await raw`
      insert into credit_ledger (round_id, event_id, account_id, allocated, spent, updated_at)
      values (${round.id}, ${gathering.id}, ${alice.id}, ${raw.json({ [sourceId]: 3 })}, 9, now()),
             (${round.id}, ${gathering.id}, ${bob.id}, ${raw.json({ [sourceId]: 2, [targetId]: 4 })}, 20, now())
    `

    // Extending now — with ballots in the ledger — must answer exactly as it did without them.
    // A response whose shape or content depended on participation would tell an organizer
    // whether anyone has voted in an open round (spec §5.3 step 3).
    const laterStill = new Date(new Date(extendedWithoutBallots.closesAt as string).getTime() + 3_600_000).toISOString()
    const withBallots = await api(request, 'PATCH', url, organizer.cookie, { round: 'pre', closesAt: laterStill })
    expect(withBallots.status(), await withBallots.text()).toBe(200)
    const after = (await withBallots.json()).round as Record<string, unknown>
    expect(Object.keys(after).sort()).toEqual(Object.keys(extendedWithoutBallots).sort())
    for (const key of Object.keys(after)) {
      if (key === 'closesAt') continue
      expect(after[key], `field ${key} differs once a ballot exists`).toEqual(extendedWithoutBallots[key])
    }

    const closed = await api(request, 'DELETE', `${url}?round=pre`, organizer.cookie)
    expect(closed.status(), await closed.text()).toBe(200)
    const outcome = await closed.json()
    expect(outcome.closed).toBe(true)
    expect(outcome.ballotsCast).toBe(2)

    // The ballot-key invariants of the scheduled close hold for a forced one too.
    const [sealed] = await raw<{ ballot_key: Buffer | null; finalized_at: string | null }[]>`
      select ballot_key, finalized_at from vote_rounds where id = ${round.id}
    `
    expect(sealed.ballot_key).toBeNull()
    expect(sealed.finalized_at).not.toBeNull()
    const ledger = await raw`select 1 from credit_ledger where round_id = ${round.id}`
    expect(ledger.length).toBe(0)

    const results = await api(request, 'GET', `/api/v1/events/${gathering.slug}/rounds/${round.id}/results`, organizer.cookie)
    expect(results.status(), await results.text()).toBe(200)
    const rows: Array<{ sessionId: string; voters: number; votes: number }> = (await results.json()).results
    const target = rows.find((r) => r.sessionId === targetId)
    expect(target).toMatchObject({ voters: 2, votes: 7 })
    // No row at all for the merged source: its votes live in the target now.
    expect(rows.some((r) => r.sessionId === sourceId)).toBe(false)

    // The audit records the close, and still no count.
    const state = await api(request, 'GET', url, organizer.cookie)
    const actions = (await state.json()).actions as Array<{ action: string }>
    expect(actions[0].action).toBe('close')
  })

  test('the scheduler places the target and never the merged source', async ({ request }) => {
    await raw`update events set status = 'scheduling' where id = ${gathering.id}`
    await raw`update sessions set status = 'approved' where event_id = ${gathering.id} and merged_into is null`

    const res = await api(request, 'GET', `/api/v1/events/${gathering.slug}/admin/auto-schedule`, organizer.cookie)
    expect(res.status(), await res.text()).toBe(200)
    const body = await res.json()
    const placed = body.assignments.map((a: { sessionId: string }) => a.sessionId)
    expect(placed).toContain(targetId)
    expect(placed).not.toContain(sourceId)
    expect(body.unassigned.map((u: { sessionId: string }) => u.sessionId)).not.toContain(sourceId)
  })
})
