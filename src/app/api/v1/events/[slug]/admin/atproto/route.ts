/**
 * Gathering actor management.
 *
 * GET    /api/v1/events/[slug]/admin/atproto   status (owner/admin/moderator)
 * POST   /api/v1/events/[slug]/admin/atproto   link with handle + app password (owner)
 * DELETE /api/v1/events/[slug]/admin/atproto   unlink (owner) — published uris are kept
 *
 * The OAuth alternative starts at /api/atproto/auth/start?purpose=gathering and
 * lands in the OAuth callback, which sets the same `events.actor_*` columns.
 */
import { AtpAgent } from '@atproto/api'
import { NextResponse } from 'next/server'
import { getUserFromRequest } from '@/lib/api/getUser'
import { createAdminClient } from '@/lib/supabase/server'
import { evictAgent } from '@/lib/atproto/agent'
import { isAtprotoConfigured } from '@/lib/atproto/config'
import { encodeByteaText, wrapSecret } from '@/lib/atproto/crypto'
import { isHandle, resolveDidDoc, resolveHandle } from '@/lib/atproto/identity'
import { revokeOAuthSession } from '@/lib/atproto/oauth'

type Db = Awaited<ReturnType<typeof createAdminClient>>

interface EventRow {
  id: string
  slug: string
  name: string
  actor_did: string | null
  actor_handle: string | null
  gathering_uri: string | null
  atproto_published_at: string | null
}

const STATUS_ROLES = ['owner', 'admin', 'moderator']

async function loadEvent(request: Request, slug: string) {
  const user = await getUserFromRequest(request)
  if (!user) return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  const db = await createAdminClient()
  const { data: event } = await db
    .from('events')
    .select('id, slug, name, actor_did, actor_handle, gathering_uri, atproto_published_at')
    .eq('slug', slug)
    .maybeSingle()
  if (!event) return { response: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  const { data: member } = await db.from('event_members').select('role').eq('event_id', event.id).eq('user_id', user.id).maybeSingle()
  return { user, db, event: event as EventRow, role: (member?.role as string | undefined) ?? null }
}

async function statusFor(db: Db, event: EventRow) {
  const did = event.actor_did
  const [credential, venues, venuesPublished, tracks, tracksPublished, scheduled, published, audit] = await Promise.all([
    did ? db.from('at_credentials').select('kind, identifier, last_ok_at, last_error_at, last_error').eq('did', did).maybeSingle() : null,
    db.from('venues').select('id', { count: 'exact', head: true }).eq('event_id', event.id),
    db.from('venues').select('id', { count: 'exact', head: true }).eq('event_id', event.id).not('at_uri', 'is', null),
    db.from('tracks').select('id', { count: 'exact', head: true }).eq('event_id', event.id),
    db.from('tracks').select('id', { count: 'exact', head: true }).eq('event_id', event.id).not('at_uri', 'is', null),
    db.from('sessions').select('id', { count: 'exact', head: true }).eq('event_id', event.id).eq('status', 'scheduled').not('time_slot_id', 'is', null),
    db.from('sessions').select('id', { count: 'exact', head: true }).eq('event_id', event.id).not('slot_uri', 'is', null),
    db
      .from('at_audit')
      .select('id, action, collection, rkey, uri, decision, reason, created_at')
      .eq('event_id', event.id)
      .order('created_at', { ascending: false })
      .limit(20),
  ])
  const handle = event.actor_handle ?? (credential?.data?.identifier as string | undefined) ?? null
  return {
    configured: isAtprotoConfigured(),
    linked: !!did,
    actorDid: did,
    actorHandle: handle,
    credentialKind: (credential?.data?.kind as 'oauth' | 'app-password' | undefined) ?? (did ? 'oauth' : null),
    credentialHealth: credential?.data
      ? { lastOkAt: credential.data.last_ok_at, lastErrorAt: credential.data.last_error_at, lastError: credential.data.last_error }
      : null,
    gatheringUri: event.gathering_uri,
    publishedAt: event.atproto_published_at,
    counts: {
      venues: { total: venues.count ?? 0, published: venuesPublished.count ?? 0 },
      tracks: { total: tracks.count ?? 0, published: tracksPublished.count ?? 0 },
      sessionsScheduled: scheduled.count ?? 0,
      sessionsPublished: published.count ?? 0,
    },
    recentAudit: audit.data ?? [],
    links: did
      ? { pdsls: `https://pdsls.dev/at/${did}`, bsky: handle ? `https://bsky.app/profile/${handle}` : `https://bsky.app/profile/${did}` }
      : null,
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await loadEvent(request, slug)
  if ('response' in ctx) return ctx.response
  if (!ctx.role || !STATUS_ROLES.includes(ctx.role)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  return NextResponse.json(await statusFor(ctx.db, ctx.event))
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await loadEvent(request, slug)
  if ('response' in ctx) return ctx.response
  if (ctx.role !== 'owner') return NextResponse.json({ error: 'Only the event owner can connect a gathering account.' }, { status: 403 })
  if (!isAtprotoConfigured()) {
    return NextResponse.json({ error: 'ATProto is not configured on this deployment (missing ATPROTO_* environment).' }, { status: 503 })
  }

  const body = (await request.json().catch(() => null)) as { handle?: unknown; appPassword?: unknown } | null
  const handle = typeof body?.handle === 'string' ? body.handle.trim().replace(/^@/, '').toLowerCase() : ''
  const appPassword = typeof body?.appPassword === 'string' ? body.appPassword : ''
  if (!handle || !isHandle(handle)) return NextResponse.json({ error: 'Enter the account handle, like gathering.bsky.social.', field: 'handle' }, { status: 400 })
  if (!appPassword.trim()) return NextResponse.json({ error: 'Enter an app password.', field: 'appPassword' }, { status: 400 })

  let did: string
  let pds: string
  let declaredHandle: string | null
  try {
    did = await resolveHandle(handle)
    const doc = await resolveDidDoc(did)
    pds = doc.pds
    declaredHandle = doc.handle
  } catch {
    return NextResponse.json({ error: 'That handle could not be resolved. Check the spelling and try again.', field: 'handle' }, { status: 400 })
  }

  // Verify the credential against the account's own PDS before storing it.
  // The password is never logged and never leaves this handler unwrapped.
  try {
    const agent = new AtpAgent({ service: pds })
    await agent.login({ identifier: handle, password: appPassword })
  } catch {
    return NextResponse.json({ error: 'Sign-in failed. Create an app password in the account settings and paste it here.', field: 'appPassword' }, { status: 400 })
  }

  const { wrapped, keyVersion } = wrapSecret(appPassword)
  const now = new Date().toISOString()
  const { error: credentialError } = await ctx.db.from('at_credentials').upsert(
    {
      did,
      kind: 'app-password',
      identifier: handle,
      wrapped: encodeByteaText(wrapped),
      key_version: keyVersion,
      pds_url: pds,
      created_by: ctx.user.id,
      rotated_at: now,
      last_ok_at: now,
      last_error_at: null,
      last_error: null,
    },
    { onConflict: 'did' },
  )
  if (credentialError) {
    console.error('[atproto] at_credentials upsert failed:', credentialError.message)
    return NextResponse.json({ error: 'Could not store the credential. Try again.' }, { status: 500 })
  }
  evictAgent(did)

  const { error: eventError } = await ctx.db.from('events').update({ actor_did: did, actor_handle: declaredHandle ?? handle }).eq('id', ctx.event.id)
  if (eventError) {
    console.error('[atproto] events actor update failed:', eventError.message)
    return NextResponse.json({ error: 'Could not link the account to this event. Try again.' }, { status: 500 })
  }
  return NextResponse.json(await statusFor(ctx.db, { ...ctx.event, actor_did: did, actor_handle: declaredHandle ?? handle }))
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const ctx = await loadEvent(request, slug)
  if ('response' in ctx) return ctx.response
  if (ctx.role !== 'owner') return NextResponse.json({ error: 'Only the event owner can disconnect the gathering account.' }, { status: 403 })

  const did = ctx.event.actor_did
  const { error } = await ctx.db.from('events').update({ actor_did: null, actor_handle: null }).eq('id', ctx.event.id)
  if (error) {
    console.error('[atproto] events actor clear failed:', error.message)
    return NextResponse.json({ error: 'Could not disconnect the account. Try again.' }, { status: 500 })
  }

  if (did) {
    // Drop the credential only when no other event still acts as this DID.
    const { count } = await ctx.db.from('events').select('id', { count: 'exact', head: true }).eq('actor_did', did)
    if (!count) {
      const { data: credential } = await ctx.db.from('at_credentials').select('kind').eq('did', did).maybeSingle()
      if (credential?.kind === 'oauth') await revokeOAuthSession(did).catch(() => undefined)
      await ctx.db.from('at_credentials').delete().eq('did', did)
      evictAgent(did)
    }
  }
  return NextResponse.json(await statusFor(ctx.db, { ...ctx.event, actor_did: null, actor_handle: null }))
}
