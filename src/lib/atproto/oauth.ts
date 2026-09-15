import 'server-only'
/**
 * The SECONDARY door: sign in with an existing ATProto account.
 *
 * Server-side (BFF) OAuth. The browser never sees a token: the whole dance
 * happens here and ends in the `sp_at_session` HttpOnly cookie (`session.ts`).
 * Mirrors Free School's `apps/appview/src/http/oauth.ts` with the Postgres
 * stores as `sql` tagged templates instead of Drizzle.
 *
 * Two modes (`config.oauthMode()`):
 *
 *  confidential  https on a real hostname. `client_id` IS the metadata URL,
 *                `private_key_jwt` with one ES256 key we generate once and
 *                persist in `at_oauth_client_key` (or take from env).
 *  loopback      anything else (local dev). The spec's loopback client:
 *                `client_id = http://localhost?...`, `token_endpoint_auth_method: none`,
 *                redirect on `http://127.0.0.1:<port>/oauth/callback`. No keyset.
 *
 * Routes that should exist (not in this module):
 *   GET /oauth/client-metadata.json   → clientMetadata()
 *   GET /oauth/jwks.json              → jwks()
 *   GET /api/atproto/auth/start       → authorizeUrl()
 *   GET /oauth/callback               → handleCallback()
 */
import { JoseKey } from '@atproto/jwk-jose'
import {
  NodeOAuthClient,
  atprotoLoopbackClientMetadata,
  buildAtprotoLoopbackClientId,
  requestLocalLock,
  type NodeSavedSession,
  type NodeSavedSessionStore,
  type NodeSavedState,
  type NodeSavedStateStore,
  type OAuthClientMetadataInput,
  type OAuthSession,
} from '@atproto/oauth-client-node'
import { sql } from '@/lib/db'
import { safeFetch } from '@/lib/net/safe-fetch'
import { defaultPdsUrl, handleResolverUrl, oauthMode, oauthPrivateJwk, publicUrl } from './config'

export const OAUTH_SCOPE = 'atproto transition:generic'
export const OAUTH_CLIENT_KID = 'schellingpoint-1'

/* ───────────────────────────── stores ───────────────────────────── */

type Json = Parameters<typeof sql.json>[0]

function asJson(value: unknown): Json {
  return value as Json
}

/** jsonb comes back parsed; tolerate a driver configured to hand back text. */
function fromJson<T>(value: unknown): T | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return undefined
    }
  }
  return value as T
}

class PostgresStateStore implements NodeSavedStateStore {
  async get(key: string): Promise<NodeSavedState | undefined> {
    const rows = await sql<{ state: unknown }[]>`select state from at_oauth_state where key = ${key}`
    return fromJson<NodeSavedState>(rows[0]?.state)
  }
  async set(key: string, state: NodeSavedState): Promise<void> {
    await sql`
      insert into at_oauth_state (key, state) values (${key}, ${sql.json(asJson(state))})
      on conflict (key) do update set state = excluded.state
    `
  }
  async del(key: string): Promise<void> {
    await sql`delete from at_oauth_state where key = ${key}`
  }
}

class PostgresSessionStore implements NodeSavedSessionStore {
  async get(sub: string): Promise<NodeSavedSession | undefined> {
    const rows = await sql<{ session: unknown }[]>`select session from at_oauth_session where sub = ${sub}`
    return fromJson<NodeSavedSession>(rows[0]?.session)
  }
  async set(sub: string, session: NodeSavedSession): Promise<void> {
    await sql`
      insert into at_oauth_session (sub, session, updated_at) values (${sub}, ${sql.json(asJson(session))}, now())
      on conflict (sub) do update set session = excluded.session, updated_at = now()
    `
  }
  async del(sub: string): Promise<void> {
    await sql`delete from at_oauth_session where sub = ${sub}`
  }
}

/** Generated once and stored, so restarts do not invalidate every in-flight session. */
async function loadOrCreateKey(): Promise<JoseKey> {
  const configured = oauthPrivateJwk()
  if (configured) return JoseKey.fromImportable(JSON.parse(configured), OAUTH_CLIENT_KID)
  const rows = await sql<{ jwk: unknown }[]>`select jwk from at_oauth_client_key where kid = ${OAUTH_CLIENT_KID}`
  const stored = fromJson<Record<string, unknown>>(rows[0]?.jwk)
  if (stored) return JoseKey.fromImportable(stored as never, OAUTH_CLIENT_KID)
  const key = await JoseKey.generate(['ES256'], OAUTH_CLIENT_KID)
  await sql`
    insert into at_oauth_client_key (kid, jwk) values (${OAUTH_CLIENT_KID}, ${sql.json(asJson(key.privateJwk))})
    on conflict (kid) do nothing
  `
  // Another process may have won the insert; use whatever is stored now.
  const again = await sql<{ jwk: unknown }[]>`select jwk from at_oauth_client_key where kid = ${OAUTH_CLIENT_KID}`
  const winner = fromJson<Record<string, unknown>>(again[0]?.jwk)
  return winner ? JoseKey.fromImportable(winner as never, OAUTH_CLIENT_KID) : key
}

/* ─────────────────────────── metadata ─────────────────────────── */

function loopbackRedirectUri(): string {
  const port = new URL(publicUrl()).port
  return `http://127.0.0.1${port ? `:${port}` : ''}/oauth/callback`
}

/**
 * The client metadata document. In confidential mode this is what
 * `/oauth/client-metadata.json` must serve; in loopback mode the authorization
 * server derives it from the `client_id` itself and no document is fetched.
 */
export function clientMetadata(): OAuthClientMetadataInput {
  if (oauthMode() === 'loopback') {
    return atprotoLoopbackClientMetadata(
      buildAtprotoLoopbackClientId({ redirect_uris: [loopbackRedirectUri()], scope: OAUTH_SCOPE }),
    )
  }
  const base = publicUrl()
  return {
    client_id: `${base}/oauth/client-metadata.json`,
    client_name: 'Schelling Point',
    client_uri: base,
    redirect_uris: [`${base}/oauth/callback`],
    // `transition:generic` is what lets us write records in the member's own
    // repo (their proposals, cohost acceptances, endorsements). `atproto` is mandatory.
    scope: OAUTH_SCOPE,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true,
    jwks_uri: `${base}/oauth/jwks.json`,
  }
}

/* ───────────────────────────── client ───────────────────────────── */

let clientPromise: Promise<NodeOAuthClient> | undefined

export function getOAuthClient(): Promise<NodeOAuthClient> {
  if (!clientPromise) {
    clientPromise = buildClient().catch((e) => {
      clientPromise = undefined
      throw e
    })
  }
  return clientPromise
}

async function buildClient(): Promise<NodeOAuthClient> {
  const mode = oauthMode()
  const keyset = mode === 'confidential' ? [await loadOrCreateKey()] : undefined
  return new NodeOAuthClient({
    clientMetadata: clientMetadata(),
    ...(keyset ? { keyset } : {}),
    stateStore: new PostgresStateStore(),
    sessionStore: new PostgresSessionStore(),
    handleResolver: handleResolverUrl(),
    // A local PDS speaks plain http; a hosted one never does.
    allowHttp: mode === 'loopback' && defaultPdsUrl().startsWith('http://'),
    // SSRF guard. Without this the library uses the global fetch for DID documents, protected
    // resource / authorization server metadata, PAR, token and every session request, all at
    // URLs an attacker's DID document chooses (only its own handle resolver is SSRF-wrapped).
    fetch: safeFetch,
    // Single-process deployment: an in-process lock is the correct one, and
    // passing it explicitly is also how the library stops warning. A
    // multi-instance deployment must swap this for a Postgres advisory lock.
    requestLock: requestLocalLock,
  })
}

/** Reset for tests / after rotating the client key. */
export function resetOAuthClient(): void {
  clientPromise = undefined
}

/** Public half of the signing keyset, for `/oauth/jwks.json`. Empty in loopback mode. */
export async function jwks(): Promise<{ keys: readonly unknown[] }> {
  return (await getOAuthClient()).jwks
}

/**
 * Start the flow. `state` is opaque app state stored server-side alongside
 * the PKCE verifier and handed back by `handleCallback` — use it for the
 * return path or the event the user was looking at; never trust it raw.
 */
export async function authorizeUrl(
  handleOrDid: string,
  opts: { state?: string; signal?: AbortSignal } = {},
): Promise<string> {
  const client = await getOAuthClient()
  const url = await client.authorize(handleOrDid.trim().replace(/^@/, ''), {
    scope: OAUTH_SCOPE,
    ...(opts.state !== undefined ? { state: opts.state } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  return url.toString()
}

/** Finish the flow from the callback's query string. */
export async function handleCallback(
  params: URLSearchParams,
): Promise<{ session: OAuthSession; did: string; state: string | null }> {
  const client = await getOAuthClient()
  const { session, state } = await client.callback(params)
  return { session, did: session.did, state }
}

/** Load a stored session, refreshing tokens transparently when needed. */
export async function restoreOAuthSession(did: string): Promise<OAuthSession> {
  const client = await getOAuthClient()
  return client.restore(did)
}

/** Revoke and forget a stored session (sign-out from the ATProto side). */
export async function revokeOAuthSession(did: string): Promise<void> {
  const client = await getOAuthClient()
  await client.revoke(did)
}
