/**
 * The gathering's network identity and protocol settings.
 *
 * GET    /api/v1/events/[slug]/admin/atproto    status (owner/admin/moderator): identity and credential
 *                                                health (the organiser banner), publish counts, policy
 *                                                thresholds, peers, listings, flagged sessions, audit
 * POST   /api/v1/events/[slug]/admin/atproto    body { action, ... } (owner/admin unless noted):
 *          mint                       mint the gathering DID on our PDS (idempotent)
 *          link { handle, appPassword }   owner: act as an existing account instead (app password)
 *          reset-credential           after reconnecting: clear the disabled flag and caches
 *          set-policy { thresholds }  destructiveActionStewards / feedbackK / publishRoles
 *          upsert-peer { peerDid, label?, crossListingEnabled? } / remove-peer { peerDid }
 *          restore-listing { listingId }
 *          sync-role-claims           re-evaluate every member's public role claim
 *          create-series { series: { freq, interval?, byDay?, count? | until?, exdates?, materializeAheadDays? } }
 *                                     declare the gathering recurring and materialize the look-ahead window
 *          materialize-series { seriesId }
 * DELETE /api/v1/events/[slug]/admin/atproto    owner: unlink (records already published stay)
 *
 * The OAuth alternative to `link` starts at /api/atproto/auth/start?purpose=gathering.
 */
import { AtpAgent } from '@atproto/api'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { readPolicyThresholds } from '@/lib/events/policy'
import { evictAgent } from '@/lib/atproto/agent'
import { gatheringActorHealth, mintGatheringActor, resetGatheringCredential, evictGatheringActor } from '@/lib/atproto/actors'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import { wrapSecret } from '@/lib/atproto/crypto'
import { flaggedSessions } from '@/lib/atproto/drift'
import { atprotoErrorResponse } from '@/lib/atproto/http'
import { forgetOwnRepo, isHandle, resolveDidDoc, resolveHandle } from '@/lib/atproto/identity'
import { listPeers, removePeer, restoreListing, upsertPeer } from '@/lib/atproto/listings'
import { revokeOAuthSession } from '@/lib/atproto/oauth'
import { setPolicyThresholds } from '@/lib/atproto/publish'
import { syncRoleClaimsForEvent } from '@/lib/atproto/role-claims'
import { createGatheringSeries, materializeSeries } from '@/lib/atproto/series'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
type Params = { params: Promise<{ slug: string }> }

function bad(status: number, error: string, field?: string, code?: string): Response {
  return Response.json({ error, ...(field ? { field } : {}), ...(code ? { code } : {}) }, { status, headers: NO_STORE })
}

async function statusFor(eventId: string) {
  const health = await gatheringActorHealth(eventId)
  const [[event], [counts], audit, flagged, peers, listings, [pending]] = await Promise.all([
    sql<{ gathering_uri: string | null; atproto_published_at: string | null; policy_thresholds: unknown; atproto_tags: string[] | null; status: string }[]>`
      select gathering_uri, atproto_published_at, policy_thresholds, atproto_tags, status from events where id = ${eventId}
    `,
    sql<{ venues: number; venues_published: number; tracks: number; tracks_published: number; scheduled: number; published: number; cancelled: number }[]>`
      select
        (select count(*)::int from venues where event_id = ${eventId}) as venues,
        (select count(*)::int from venues where event_id = ${eventId} and at_uri is not null) as venues_published,
        (select count(*)::int from tracks where event_id = ${eventId}) as tracks,
        (select count(*)::int from tracks where event_id = ${eventId} and at_uri is not null) as tracks_published,
        (select count(*)::int from sessions where event_id = ${eventId} and status = 'scheduled' and time_slot_id is not null) as scheduled,
        (select count(*)::int from sessions where event_id = ${eventId} and slot_uri is not null) as published,
        (select count(*)::int from sessions where event_id = ${eventId} and cancelled_at is not null) as cancelled
    `,
    sql<{ id: string; action: string; collection: string | null; rkey: string | null; uri: string | null; decision: string; reason: string; created_at: string }[]>`
      select id, action, collection, rkey, uri, decision, reason, created_at from at_audit
      where event_id = ${eventId} order by created_at desc limit 25
    `,
    flaggedSessions(eventId),
    listPeers(eventId),
    sql<{ id: string; session_id: string | null; subject_uri: string; record_uri: string | null; origin: string; status: string; tags: string[]; updated_at: string }[]>`
      select id, session_id, subject_uri, record_uri, origin, status, tags, updated_at from listings
      where event_id = ${eventId} order by updated_at desc limit 100
    `,
    sql<{ n: number }[]>`select count(*)::int as n from approval_requests where event_id = ${eventId} and status in ('pending', 'applying')`,
  ])
  const handle = health.actorHandle
  return {
    configured: isAtprotoConfigured(),
    linked: !!health.actorDid,
    actorDid: health.actorDid,
    actorHandle: handle,
    credentialKind: health.credentialKind,
    health: { state: health.state, lastOkAt: health.lastOkAt, lastErrorAt: health.lastErrorAt, banner: health.banner },
    gatheringUri: event?.gathering_uri ?? null,
    publishedAt: event?.atproto_published_at ?? null,
    tags: event?.atproto_tags ?? [],
    policy: readPolicyThresholds(event?.policy_thresholds),
    counts: {
      venues: { total: counts?.venues ?? 0, published: counts?.venues_published ?? 0 },
      tracks: { total: counts?.tracks ?? 0, published: counts?.tracks_published ?? 0 },
      sessionsScheduled: counts?.scheduled ?? 0,
      sessionsPublished: counts?.published ?? 0,
      sessionsCancelled: counts?.cancelled ?? 0,
      approvalsPending: pending?.n ?? 0,
    },
    flagged,
    peers,
    listings,
    recentAudit: audit,
    links: health.actorDid ? { pdsls: `https://pdsls.dev/at/${health.actorDid}` } : null,
  }
}

export async function GET(request: Request, { params }: Params) {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, ['owner', 'admin', 'moderator'])
  if (auth instanceof Response) return auth
  return Response.json(await statusFor(auth.event.id), { headers: NO_STORE })
}

export async function POST(request: Request, { params }: Params) {
  const denied = assertSameOrigin(request)
  if (denied) return denied
  const { slug } = await params
  const auth = await requireEventRole(request, slug, ['owner', 'admin'])
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const action = typeof body?.action === 'string' ? body.action : ''
  const eventId = auth.event.id
  const caller = auth.viewer.accountId

  try {
    switch (action) {
      case 'mint': {
        if (!isAtprotoConfigured()) return bad(503, 'ATProto is not configured on this deployment.')
        const out = await mintGatheringActor(eventId, caller)
        return Response.json({ minted: out.minted, ...(await statusFor(eventId)) }, { headers: NO_STORE })
      }
      case 'link': {
        if (auth.role !== 'owner') return bad(403, 'Only the event owner can connect a gathering account.')
        const handle = typeof body?.handle === 'string' ? body.handle.trim().replace(/^@/, '').toLowerCase() : ''
        const appPassword = typeof body?.appPassword === 'string' ? body.appPassword : ''
        if (!handle || !isHandle(handle)) return bad(400, 'Enter the account handle, like gathering.bsky.social.', 'handle')
        if (!appPassword.trim()) return bad(400, 'Enter an app password.', 'appPassword')
        let did: string
        let pds: string
        let declared: string | null
        try {
          did = await resolveHandle(handle)
          const doc = await resolveDidDoc(did)
          pds = doc.pds
          declared = doc.handle
        } catch {
          return bad(400, 'That handle could not be resolved. Check the spelling and try again.', 'handle')
        }
        const member = await sql`select 1 from accounts where did = ${did}`
        if (member.length) return bad(409, 'That account belongs to a person on this site. A gathering needs its own account.', 'handle')
        try {
          await new AtpAgent({ service: pds }).login({ identifier: handle, password: appPassword })
        } catch {
          return bad(400, 'Sign-in failed. Create an app password in the account settings and paste it here.', 'appPassword')
        }
        const { wrapped, keyVersion } = wrapSecret(appPassword)
        await sql.begin(async (t) => {
          await t`
            insert into at_credentials (did, kind, identifier, wrapped, key_version, pds_url, created_by, rotated_at, last_ok_at, last_error, last_error_at, consecutive_failures, disabled_at)
            values (${did}, 'app-password', ${handle}, ${wrapped}, ${keyVersion}, ${pds}, ${caller}, now(), now(), null, null, 0, null)
            on conflict (did) do update set
              kind = excluded.kind, identifier = excluded.identifier, wrapped = excluded.wrapped, key_version = excluded.key_version,
              pds_url = excluded.pds_url, created_by = excluded.created_by, rotated_at = now(), last_ok_at = now(),
              last_error = null, last_error_at = null, consecutive_failures = 0, disabled_at = null
          `
          await t`update events set actor_did = ${did}, actor_handle = ${declared ?? handle} where id = ${eventId}`
          await t`
            insert into at_audit (event_id, actor_did, caller_user_id, action, decision, reason)
            values (${eventId}, ${did}, ${caller}, 'link-identity', 'allow', 'owner connected an existing account as the gathering (app password)')
          `
        })
        evictAgent(did)
        evictGatheringActor(eventId)
        forgetOwnRepo(did)
        return Response.json(await statusFor(eventId), { headers: NO_STORE })
      }
      case 'reset-credential':
        await resetGatheringCredential(eventId)
        return Response.json(await statusFor(eventId), { headers: NO_STORE })
      case 'set-policy': {
        const out = await setPolicyThresholds(eventId, caller, (body?.thresholds ?? {}) as Record<string, never>)
        if (body?.thresholds && typeof body.thresholds === 'object' && 'publishRoles' in body.thresholds) {
          await syncRoleClaimsForEvent(eventId)
        }
        return Response.json({ policy: out.thresholds, results: out.results }, { headers: NO_STORE })
      }
      case 'upsert-peer': {
        const out = await upsertPeer({
          eventId,
          callerUserId: caller,
          peerDid: typeof body?.peerDid === 'string' ? body.peerDid : '',
          label: typeof body?.label === 'string' ? body.label : null,
          crossListingEnabled: typeof body?.crossListingEnabled === 'boolean' ? body.crossListingEnabled : undefined,
        })
        return Response.json(out, { headers: NO_STORE })
      }
      case 'remove-peer': {
        const results = await removePeer({ eventId, callerUserId: caller, peerDid: typeof body?.peerDid === 'string' ? body.peerDid : '' })
        return Response.json({ results }, { headers: NO_STORE })
      }
      case 'restore-listing': {
        const results = await restoreListing({ eventId, listingId: typeof body?.listingId === 'string' ? body.listingId : '', callerUserId: caller })
        return Response.json({ results }, { headers: NO_STORE })
      }
      case 'sync-role-claims':
        return Response.json({ outcomes: await syncRoleClaimsForEvent(eventId) }, { headers: NO_STORE })
      case 'create-series': {
        const s = (body?.series ?? {}) as Record<string, unknown>
        const created = await createGatheringSeries({
          eventId,
          callerUserId: caller,
          freq: s.freq as never,
          interval: typeof s.interval === 'number' ? s.interval : undefined,
          byDay: Array.isArray(s.byDay) ? (s.byDay as never) : undefined,
          count: typeof s.count === 'number' ? s.count : undefined,
          until: typeof s.until === 'string' ? s.until : undefined,
          exdates: Array.isArray(s.exdates) ? (s.exdates.filter((d) => typeof d === 'string') as string[]) : undefined,
          materializeAheadDays: typeof s.materializeAheadDays === 'number' ? s.materializeAheadDays : undefined,
        })
        const results = await materializeSeries({ eventId, seriesId: created.seriesId, callerUserId: caller })
        return Response.json({ seriesId: created.seriesId, uri: created.uri, results }, { headers: NO_STORE })
      }
      case 'materialize-series': {
        const seriesId = typeof body?.seriesId === 'string' ? body.seriesId : ''
        return Response.json({ results: await materializeSeries({ eventId, seriesId, callerUserId: caller }) }, { headers: NO_STORE })
      }
      default:
        return bad(400, 'action must be one of mint, link, reset-credential, set-policy, upsert-peer, remove-peer, restore-listing, sync-role-claims, create-series, materialize-series', 'action')
    }
  } catch (e) {
    return atprotoErrorResponse(e, 'admin/atproto')
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const denied = assertSameOrigin(request)
  if (denied) return denied
  const { slug } = await params
  const auth = await requireEventRole(request, slug, ['owner'])
  if (auth instanceof Response) return auth
  const did = auth.event.actor_did
  await sql`update events set actor_did = null, actor_handle = null where id = ${auth.event.id}`
  evictGatheringActor(auth.event.id)
  if (did) {
    const others = await sql`select 1 from events where actor_did = ${did} limit 1`
    if (!others.length) {
      const [credential] = await sql<{ kind: string }[]>`select kind from at_credentials where did = ${did}`
      // A minted gathering account keeps its credential: unlinking must not strand a DID we custody.
      if (credential?.kind === 'oauth') {
        await revokeOAuthSession(did).catch(() => undefined)
        await sql`delete from at_credentials where did = ${did}`
      }
      evictAgent(did)
    }
    await sql`
      insert into at_audit (event_id, actor_did, caller_user_id, action, decision, reason)
      values (${auth.event.id}, ${did}, ${auth.viewer.accountId}, 'unlink-identity', 'allow', 'owner disconnected the gathering account; published records stay')
    `
  }
  return Response.json(await statusFor(auth.event.id), { headers: NO_STORE })
}
