import 'server-only'
/**
 * Handles: `<word><word><3 digits>.<domain>` — e.g. `calmotter417.unconference.events`.
 *
 * NEVER derived from the email (spec §7, R9): a handle is public forever, and an
 * email-derived handle is a permanent, unrevocable disclosure. Ported from Free School
 * `apps/appview/src/lib/handles.ts`.
 *
 * The handle namespace and the gathering namespace are ONE namespace: a gathering is
 * served at `<slug>.<domain>` and the session cookie is `Domain=.<domain>`, so a member
 * holding the handle `ethboulder.<domain>` would own a gathering's origin. Hence the
 * reserved labels, and hence every existing `events.slug` counts as reserved.
 */
import { randomInt } from 'node:crypto'
import { sql } from '@/lib/db'
import { pdsHandleDomain } from '@/lib/atproto/config'

const FIRST = [
  'calm', 'quiet', 'bright', 'open', 'warm', 'clear', 'kind', 'plain', 'steady', 'fresh',
  'wide', 'still', 'early', 'easy', 'free', 'glad', 'soft', 'true', 'newly', 'good',
]

const SECOND = [
  'otter', 'maple', 'creek', 'meadow', 'finch', 'cedar', 'willow', 'heron', 'aspen', 'wren',
  'birch', 'sparrow', 'clover', 'juniper', 'alder', 'thrush', 'laurel', 'plover', 'sorrel', 'sedge',
]

/** Total generated space: 20 x 20 x 900 = 360 000. */
export const HANDLE_SPACE = FIRST.length * SECOND.length * 900

/**
 * Labels no account (participant or gathering) may take directly under the handle
 * domain. Every existing `events.slug` is reserved too — see `isReservedLabel`.
 */
export const RESERVED_LABELS: readonly string[] = [
  'admin', 'www', 'pds', 'api', 'app', 'static', 'assets', 'internal', 'mail', 'help',
  'support', 'status', 'blog', 'docs', 'about', 'login', 'auth', 'oauth', 'xrpc', 'events',
  'e', 'gathering',
]

const RESERVED_SET: ReadonlySet<string> = new Set(RESERVED_LABELS)

/** A member-chosen handle prefix: 1 char, or 3-20 chars of `[a-z0-9-]` not starting/ending with `-`. */
export const HANDLE_PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])?$/

/** A gathering label (the event slug as a subdomain / handle label). */
export const GATHERING_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/

/** The handle domain accounts are minted under (`PDS_HANDLE_DOMAIN`), no leading dot. */
export function handleDomain(): string {
  return pdsHandleDomain()
}

/** True when `label` is in the static reserved list. No I/O. */
export function isStaticReservedLabel(label: string): boolean {
  return RESERVED_SET.has(label.trim().toLowerCase())
}

/** Static reserved list OR an existing `events.slug`. */
export async function isReservedLabel(label: string): Promise<boolean> {
  const l = label.trim().toLowerCase()
  if (RESERVED_SET.has(l)) return true
  const rows = await sql`select 1 from events where slug = ${l} limit 1`
  return rows.length > 0
}

export function isValidGatheringLabel(label: string): boolean {
  return GATHERING_LABEL_RE.test(label)
}

/**
 * A fresh handle under `domain`. Synchronous and I/O-free: a drawn prefix always ends in
 * three digits and no static reserved label does, so only an event slug could collide —
 * `custody.ts` re-checks `isReservedLabel` on the drawn label before minting.
 */
export function generateHandle(domain: string): string {
  const d = domain.trim().toLowerCase().replace(/^\.+/, '')
  for (let attempt = 0; attempt < 20; attempt++) {
    const prefix = `${FIRST[randomInt(FIRST.length)]}${SECOND[randomInt(SECOND.length)]}${randomInt(100, 1000)}`
    if (!RESERVED_SET.has(prefix)) return `${prefix}.${d}`
  }
  throw new Error('could not generate a handle outside the reserved list')
}

/**
 * The single label of `host` directly under `domain`, or null. `ethboulder.unconference.events`
 * under `unconference.events` is `ethboulder`; `a.b.unconference.events` is nothing.
 */
export function labelUnder(host: string, domain: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, '').split(':')[0] ?? ''
  const s = domain.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '')
  if (!h || !s || !h.endsWith(`.${s}`)) return null
  const label = h.slice(0, -(s.length + 1))
  return label && !label.includes('.') ? label : null
}
