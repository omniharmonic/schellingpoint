import 'server-only'
/**
 * A custodial person's OWN `app.bsky.actor.profile` (release design §5.5, decision §12.3).
 *
 * Opt-in, off by default. When `profiles.publish_profile` is true the person's display name and
 * bio are written as `app.bsky.actor.profile` at rkey `self` in THEIR repo on our PDS, with the
 * person's own custodial credential (`agentForAccount`) — never the gathering actor, never the
 * audited port. Turning the flag off deletes the record: their choice, their repo.
 *
 *   publishPersonProfile(accountId)   write/rewrite the record (CAS on the cid we hold, one re-read
 *                                     retry), store `profile_record_uri/cid`
 *   retractPersonProfile(accountId)   delete the record (CAS on the cid we hold), clear both columns
 *   syncPersonProfileRecord(...)      best-effort rewrite for `after()` hooks (never throws)
 *
 * Not for OAuth accounts (`not_custodial`: they manage their profile where they signed up) and not
 * once custody ended (`relink_atproto`: `agentForAccount` refuses an owned account — the record they
 * may already have stays in their repo, theirs to keep or delete).
 *
 * The avatar: their own image, uploaded as a blob to their own repo (`blobs.ts`), and only when it
 * sits in our own upload store — their upload, or the copy mirrored from their own Bluesky repo at
 * import. An image hosted elsewhere is never re-published on their behalf, and a failed upload
 * leaves the record text-only. The record is not indexed into `at_records` — like the gathering's
 * profile it is outside `INDEXED_COLLECTIONS`; the privacy audit reads it live from the PDS and
 * checks it exists only behind the opt-in.
 */
import { sql } from '@/lib/db'
import { agentForAccount, NoActorCredentialError } from './agent'
import { personAvatarBlob } from './blobs'
import { NSID } from './nsids'
import { assertNoForeignDid, buildPersonProfileRecord } from './records'
import { deleteRecord, getRecord, isInvalidSwap, putRecord, type WriteResult } from './write'

export type PersonProfileErrorCode = 'not_found' | 'not_custodial' | 'relink_atproto' | 'not_opted_in'

export class PersonProfileError extends Error {
  readonly status: number
  constructor(
    readonly code: PersonProfileErrorCode,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'PersonProfileError'
    this.status = code === 'not_found' ? 404 : 409
  }
}

const SELF = 'self'

interface Row {
  id: string
  did: string
  kind: 'custodial' | 'oauth'
  owned_at: string | null
  created_at: string
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  publish_profile: boolean
  profile_record_uri: string | null
  profile_record_cid: string | null
}

async function load(accountId: string): Promise<Row> {
  const rows = await sql<Row[]>`
    select a.id, a.did, a.kind, a.owned_at, a.created_at,
           p.display_name, p.bio, p.avatar_url, coalesce(p.publish_profile, false) as publish_profile,
           p.profile_record_uri, p.profile_record_cid
    from accounts a left join profiles p on p.id = a.id
    where a.id = ${accountId}
  `
  const row = rows[0]
  if (!row) throw new PersonProfileError('not_found', 'No such account')
  if (row.kind !== 'custodial') {
    throw new PersonProfileError('not_custodial', 'Only an account created here can publish its profile through this app; you manage your own profile where you signed up.')
  }
  if (row.owned_at) {
    throw new PersonProfileError('relink_atproto', 'You took ownership of this identity, so this app no longer holds its credential. Manage your profile record from your PDS.')
  }
  return row
}

async function agentFor(row: Row) {
  try {
    return await agentForAccount(row.id)
  } catch (e) {
    if (e instanceof NoActorCredentialError) throw new PersonProfileError('relink_atproto', 'This app no longer holds a credential for your identity.')
    throw e
  }
}

/**
 * Write (or rewrite) the person's profile record from their current display name and bio.
 * The caller decides whether the person opted in (`requireOptIn`, default true, checks the flag).
 */
export async function publishPersonProfile(accountId: string, opts: { requireOptIn?: boolean } = {}): Promise<WriteResult> {
  const row = await load(accountId)
  if (opts.requireOptIn !== false && !row.publish_profile) throw new PersonProfileError('not_opted_in', 'This person has not opted in to a public profile record.')
  const avatar = await personAvatarBlob({ accountId: row.id, did: row.did, url: row.avatar_url })
  const record = buildPersonProfileRecord({ displayName: row.display_name, bio: row.bio, avatar, createdAt: row.created_at })
  assertNoForeignDid(record, row.did)
  const agent = await agentFor(row)
  const base = { repo: row.did, collection: NSID.actorProfile, rkey: SELF, record: record as unknown as Record<string, unknown> }
  let result: WriteResult
  try {
    // `putRecord` validates against the lexicon and the sidecar rule before anything goes out.
    result = await putRecord(agent, { ...base, swapRecord: row.profile_record_cid })
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    // The person's repo moved on (a record we never tracked, or one already rewritten): re-read once.
    const live = await getRecord(row.did, NSID.actorProfile, SELF)
    result = await putRecord(agent, { ...base, swapRecord: live?.cid ?? null })
  }
  await sql`
    update profiles set profile_record_uri = ${result.uri}, profile_record_cid = ${result.cid} where id = ${row.id}
  `
  return result
}

/** Delete the person's profile record and forget it. No record → nothing to do (`{ deleted: false }`). */
export async function retractPersonProfile(accountId: string): Promise<{ deleted: boolean }> {
  const row = await load(accountId)
  const live = await getRecord(row.did, NSID.actorProfile, SELF)
  if (!live) {
    await sql`update profiles set profile_record_uri = null, profile_record_cid = null where id = ${row.id}`
    return { deleted: false }
  }
  const agent = await agentFor(row)
  const input = { repo: row.did, collection: NSID.actorProfile, rkey: SELF }
  try {
    await deleteRecord(agent, { ...input, swapRecord: row.profile_record_cid ?? live.cid })
  } catch (e) {
    if (!isInvalidSwap(e)) throw e
    await deleteRecord(agent, { ...input, swapRecord: live.cid })
  }
  await sql`update profiles set profile_record_uri = null, profile_record_cid = null where id = ${row.id}`
  return { deleted: true }
}

/**
 * Keep an opted-in person's record in step with their app-side profile. For `after()` hooks:
 * a person who has not opted in, or whose custody ended, is left alone; failures are logged.
 */
export async function syncPersonProfileRecord(accountId: string): Promise<void> {
  try {
    await publishPersonProfile(accountId)
  } catch (e) {
    if (e instanceof PersonProfileError) return
    console.warn('[atproto] person profile sync failed:', e instanceof Error ? e.message : String(e))
  }
}
