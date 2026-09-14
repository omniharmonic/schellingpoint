import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { custodyKey } from './config'

/**
 * AES-256-GCM wrapping for custodied secrets (`at_credentials.wrapped`).
 *
 * Wire layout: `iv (12) || tag (16) || ciphertext`. `keyVersion` names which
 * key wrapped it so a rotation can re-wrap rows one version at a time.
 */

export const CURRENT_KEY_VERSION = 'v1'

const IV_BYTES = 12
const TAG_BYTES = 16

function keyFor(version: string): Buffer {
  switch (version) {
    case 'v1':
      return Buffer.from(custodyKey(), 'hex')
    default:
      throw new Error(`unknown custody key version ${version}`)
  }
}

export function wrapSecret(plain: string): { wrapped: Buffer; keyVersion: string } {
  const key = keyFor(CURRENT_KEY_VERSION)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return { wrapped: Buffer.concat([iv, tag, body]), keyVersion: CURRENT_KEY_VERSION }
}

export function unwrapSecret(wrapped: Buffer | Uint8Array | string, keyVersion: string): string {
  const buf = typeof wrapped === 'string' ? decodeByteaText(wrapped) : Buffer.from(wrapped)
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error('wrapped secret is too short')
  const key = keyFor(keyVersion)
  const iv = buf.subarray(0, IV_BYTES)
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buf.subarray(IV_BYTES + TAG_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}

/**
 * PostgREST returns `bytea` columns as text: `\x<hex>` by default. Accept that,
 * plain hex, or base64 so callers can hand the row value straight over.
 */
export function decodeByteaText(value: string): Buffer {
  if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex')
  if (/^[0-9a-fA-F]+$/.test(value) && value.length % 2 === 0) return Buffer.from(value, 'hex')
  return Buffer.from(value, 'base64')
}

/** The form PostgREST accepts when writing a `bytea` column. */
export function encodeByteaText(buf: Buffer | Uint8Array): string {
  return `\\x${Buffer.from(buf).toString('hex')}`
}
