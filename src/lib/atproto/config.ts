import 'server-only'

/**
 * Environment for the ATProto layer. Read lazily so a missing variable fails
 * the feature that needs it, not the whole process at import time.
 *
 * See `.env.example` and `src/lib/atproto/README.md` for what each does.
 */

export const DEFAULT_JETSTREAM_URL = 'wss://jetstream2.us-east.bsky.network/subscribe'
export const DEFAULT_PDS_URL = 'https://bsky.social'
export const DEFAULT_HANDLE_RESOLVER = 'https://bsky.social'

export class AtprotoConfigError extends Error {
  constructor(readonly variable: string, detail: string) {
    super(`${variable}: ${detail}`)
    this.name = 'AtprotoConfigError'
  }
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

function required(name: string): string {
  const v = env(name)
  if (!v) throw new AtprotoConfigError(name, 'is not set')
  return v
}

/** The public origin of this deployment, no trailing slash. */
export function publicUrl(): string {
  return required('NEXT_PUBLIC_APP_URL').replace(/\/+$/, '')
}

/** HMAC key for the `sp_at_session` cookie. Any long random string. */
export function sessionSecret(): string {
  const v = required('ATPROTO_SESSION_SECRET')
  if (v.length < 32) throw new AtprotoConfigError('ATPROTO_SESSION_SECRET', 'must be at least 32 characters')
  return v
}

/** 32-byte AES-256-GCM key as 64 hex characters, for `at_credentials.wrapped`. */
export function custodyKey(): string {
  const v = required('ATPROTO_CUSTODY_KEY')
  if (!/^[0-9a-fA-F]{64}$/.test(v)) {
    throw new AtprotoConfigError('ATPROTO_CUSTODY_KEY', 'must be exactly 64 hex characters (32 bytes)')
  }
  return v
}

/** Optional pre-provisioned ES256 private JWK (JSON) for the confidential OAuth client. */
export function oauthPrivateJwk(): string | undefined {
  return env('ATPROTO_OAUTH_PRIVATE_JWK')
}

export function jetstreamUrl(): string {
  return env('ATPROTO_JETSTREAM_URL') ?? DEFAULT_JETSTREAM_URL
}

/** PDS used for custodial (app-password) accounts and as the default write target. */
export function defaultPdsUrl(): string {
  return (env('ATPROTO_DEFAULT_PDS_URL') ?? DEFAULT_PDS_URL).replace(/\/+$/, '')
}

/** XRPC host used for fallback `com.atproto.identity.resolveHandle`. */
export function handleResolverUrl(): string {
  return (env('ATPROTO_HANDLE_RESOLVER') ?? DEFAULT_HANDLE_RESOLVER).replace(/\/+$/, '')
}

export type OAuthMode = 'confidential' | 'loopback'

/**
 * A confidential ATProto OAuth client cannot have an http, IP-literal or
 * localhost `client_id`. Over https on a real hostname we are confidential
 * (`private_key_jwt`); anywhere else we fall back to the loopback client the
 * spec reserves for local development.
 */
export function oauthMode(): OAuthMode {
  let url: URL
  try {
    url = new URL(publicUrl())
  } catch {
    return 'loopback'
  }
  const host = url.hostname.toLowerCase()
  const isLocal = host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  return url.protocol === 'https:' && !isLocal ? 'confidential' : 'loopback'
}

/** True when the minimum for any ATProto feature (session + custody secrets) is present. */
export function isAtprotoConfigured(): boolean {
  try {
    publicUrl()
    sessionSecret()
    custodyKey()
    return true
  } catch {
    return false
  }
}
