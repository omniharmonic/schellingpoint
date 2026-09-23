/**
 * Local lexicon validation. Our lexicons are unpublished, so every PDS write
 * goes out with `validate: false`; this module is what keeps a malformed
 * record from ever leaving the process.
 *
 * Loads every lexicon JSON under `lexicons/` (ours, vendored, strongRef shim)
 * once at module init. Node-only (reads the filesystem) but deliberately NOT
 * marked `server-only`: the Playwright unit tests import it directly and the
 * `server-only` shim throws outside a Next.js server bundle. Never import it
 * from a client component — the `window` guard below makes that loud.
 */
import { BlobRef, Lexicons, type LexiconDoc } from '@atproto/lexicon'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/atproto/validate.ts is server-only: it reads lexicons/ from disk')
}

function candidateDirs(): string[] {
  const dirs = [resolve(process.cwd(), 'lexicons')]
  // Bundlers rewrite __dirname; guard rather than trust it.
  if (typeof __dirname === 'string' && __dirname !== '/' && __dirname !== '') {
    dirs.push(resolve(__dirname, '../../../lexicons'))
  }
  return dirs
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.json')) out.push(p)
  }
  return out.sort()
}

export const LEXICONS_DIR: string = (() => {
  const found = candidateDirs().find((d) => existsSync(join(d, 'schellingpoint', 'draft')))
  if (!found) {
    throw new Error(
      `lexicons/ directory not found (looked in ${candidateDirs().join(', ')}); ` +
        'it must ship with the server bundle',
    )
  }
  return found
})()

const docs: LexiconDoc[] = walk(LEXICONS_DIR).map((file) => JSON.parse(readFileSync(file, 'utf8')) as LexiconDoc)

/** Every lexicon we know, ready to validate against. */
export const lexicons = new Lexicons(docs)

export const LOADED_LEXICON_IDS: readonly string[] = docs.map((d) => d.id)

export class RecordValidationError extends Error {
  constructor(
    readonly nsid: string,
    readonly detail: string,
  ) {
    super(`${nsid} record is invalid: ${detail}`)
    this.name = 'RecordValidationError'
  }
}

/**
 * A blob as it appears in JSON — the shape a record carries over the wire, in `at_records`, and
 * in every record this codebase builds. `{ $type: 'blob', ref: { $link: cid }, mimeType, size }`.
 */
export interface JsonBlob {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

export function isJsonBlob(value: unknown): value is JsonBlob {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const ref = v.ref as Record<string, unknown> | undefined
  return (
    v.$type === 'blob' &&
    typeof v.mimeType === 'string' &&
    typeof v.size === 'number' &&
    !!ref &&
    typeof ref === 'object' &&
    typeof ref.$link === 'string'
  )
}

/**
 * `@atproto/lexicon`'s blob validator accepts ONLY a `BlobRef` instance (`validators/blob.ts`:
 * `value instanceof BlobRef`), while every blob we hold is the JSON form above — the PDS returns
 * it that way from `getRecord`/`listRecords`, the indexer stores it that way, and the record
 * builders write it that way. Convert on the way into validation so a record carrying an avatar
 * or a link-card thumb validates instead of failing "should be a blob ref".
 *
 * Pure: the input is never mutated, and a record with no blob in it comes back as-is.
 */
export function toLexValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => toLexValue(v)) as unknown as T
  if (value && typeof value === 'object') {
    if (value instanceof BlobRef) return value
    if (isJsonBlob(value)) {
      try {
        // The untyped form is the one that takes the CID as a STRING (`BlobRef.fromJsonRef` parses
        // it); the typed form needs a `CID` instance, which JSON never carries. Only validation
        // reads the result, so the size the typed form would keep is not needed here.
        return BlobRef.fromJsonRef({ cid: value.ref.$link, mimeType: value.mimeType }) as unknown as T
      } catch {
        return value // a malformed CID: leave it, so validation reports it rather than throwing here
      }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toLexValue(v)
    return out as T
  }
  return value
}

/** Throws `RecordValidationError` with a readable message when `record` does not conform to `nsid`. */
export function assertValidRecord(nsid: string, record: unknown): void {
  const withType =
    record && typeof record === 'object' && !('$type' in record) ? { ...(record as object), $type: nsid } : record
  try {
    lexicons.assertValidRecord(nsid, toLexValue(withType))
  } catch (e) {
    throw new RecordValidationError(nsid, e instanceof Error ? e.message : String(e))
  }
}

export function isValidRecord(nsid: string, record: unknown): boolean {
  try {
    assertValidRecord(nsid, record)
    return true
  } catch {
    return false
  }
}

/** Property names the lexicon's main record object defines (plus `$type`). */
export function lexiconRecordProperties(nsid: string): string[] {
  const def = lexicons.getDefOrThrow(nsid, ['record'])
  const props = (def as { record?: { properties?: Record<string, unknown> } }).record?.properties ?? {}
  return ['$type', ...Object.keys(props)]
}

/**
 * The sidecar rule as a check: `record` may carry ONLY fields the lexicon
 * defines. Lexicon validation itself is open-world (unknown keys pass), so
 * this is a separate, stricter assertion for borrowed record types.
 */
export function assertNoUnknownFields(nsid: string, record: object): void {
  const allowed = new Set(lexiconRecordProperties(nsid))
  const extra = Object.keys(record).filter((k) => !allowed.has(k))
  if (extra.length) {
    throw new RecordValidationError(nsid, `carries fields the lexicon does not define: ${extra.join(', ')}`)
  }
}
