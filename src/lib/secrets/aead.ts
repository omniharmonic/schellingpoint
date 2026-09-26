import 'server-only'
/**
 * Sealed secrets at rest (design 2026-09-25 §2.1).
 *
 * One deployment key, `APP_SECRETS_KEY` (32 bytes, base64 — `openssl rand -base64 32`), seals the
 * credentials organizers paste into the app: today the per-gathering answer-model key
 * (`event_ai_settings.key_ciphertext`). AES-256-GCM, a fresh 12-byte nonce per seal, and the owning
 * row's id as associated data, so a sealed blob is bound to the row it belongs to: copied to
 * another gathering it fails to open instead of decrypting to a usable key.
 *
 * Layout: `version(1) || nonce(12) || ciphertext || tag(16)`.
 *
 * FAIL CLOSED. Without the env there is no sealing and no opening: `secretsAvailable()` is false,
 * `seal`/`open` throw `SecretsUnavailableError`, and the server logs why once. Callers turn that
 * into "the operator has not configured secret storage" — never a 500, and never a fallback to
 * storing the secret in the clear.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'

const VERSION = 1
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const ENV_NAME = 'APP_SECRETS_KEY'

/** Raised whenever `APP_SECRETS_KEY` is missing or unusable. Never carries key material. */
export class SecretsUnavailableError extends Error {
  readonly code = 'SecretsUnavailable'
  constructor(detail: string) {
    super(`Secret storage is not configured: ${detail}`)
    this.name = 'SecretsUnavailableError'
  }
}

/** Raised when a sealed value does not open (tampered, wrong key, wrong owner). */
export class SealedValueError extends Error {
  readonly code = 'SealedValueUnreadable'
  constructor(detail: string) {
    super(`Sealed value could not be opened: ${detail}`)
    this.name = 'SealedValueError'
  }
}

let logged = false

function complain(detail: string): SecretsUnavailableError {
  if (!logged) {
    logged = true
    console.error(
      `[secrets] ${ENV_NAME} is not usable (${detail}). Organizer-supplied keys cannot be stored or read. ` +
        `Generate one with \`openssl rand -base64 32\` and set ${ENV_NAME}; see deploy/unconference/README.md.`,
    )
  }
  return new SecretsUnavailableError(detail)
}

/** The deployment key, or null when it is missing or the wrong length. Never logged. */
function readKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env[ENV_NAME]?.trim()
  if (!raw) return null
  let decoded: Buffer
  try {
    decoded = Buffer.from(raw, 'base64')
  } catch {
    return null
  }
  // Buffer.from is lenient: check the round trip so a truncated or mistyped value is refused here
  // rather than producing a short key.
  if (decoded.length !== KEY_BYTES) return null
  return decoded
}

/** Whether this deployment can seal and open secrets at all. Cheap; safe to call per request. */
export function secretsAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return readKey(env) !== null
}

function requireKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const key = readKey(env)
  if (!key) throw complain(process.env[ENV_NAME]?.trim() ? `${ENV_NAME} is not 32 base64-encoded bytes` : `${ENV_NAME} is not set`)
  return key
}

/**
 * Seal `plaintext` for the row identified by `owner` (an event id today). The result is the bytea
 * to store; it is different on every call (fresh nonce) even for the same input.
 */
export function seal(plaintext: string, owner: string, env: NodeJS.ProcessEnv = process.env): Buffer {
  if (!plaintext) throw new SealedValueError('nothing to seal')
  if (!owner) throw new SealedValueError('no owner for the associated data')
  const key = requireKey(env)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(associatedData(owner))
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()])
}

/**
 * Open a sealed value for `owner`. Throws `SealedValueError` when the bytes were tampered with,
 * were sealed under another key, or belong to another owner; `SecretsUnavailableError` when the
 * deployment key is missing.
 */
export function open(sealed: Uint8Array | Buffer, owner: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = requireKey(env)
  const buf = Buffer.isBuffer(sealed) ? sealed : Buffer.from(sealed)
  if (buf.length < 1 + NONCE_BYTES + TAG_BYTES + 1) throw new SealedValueError('too short')
  if (buf[0] !== VERSION) throw new SealedValueError(`unsupported version ${buf[0]}`)
  const nonce = buf.subarray(1, 1 + NONCE_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)
  const body = buf.subarray(1 + NONCE_BYTES, buf.length - TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(associatedData(owner))
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    // GCM does not say which of "wrong key", "wrong owner" or "tampered" it was, and neither do we.
    throw new SealedValueError('authentication failed')
  }
}

function associatedData(owner: string): Buffer {
  return Buffer.from(owner, 'utf8')
}

/** The last four characters of a secret, for "which key is installed?" displays. */
export function last4(secret: string): string {
  return secret.slice(-4)
}

/** Constant-time comparison of two secrets of the same length (helper for future callers). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}
