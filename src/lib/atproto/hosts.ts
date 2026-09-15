import 'server-only'
/**
 * Hostnames this stack serves (plan §1, spec §8 routing, Free School multi-school §3):
 *
 *   {web host}, www.{web host}      the app (sign-in, OAuth client documents, every API)
 *   {PDS host}                      the PDS, whole
 *   <label>.{PDS_HANDLE_DOMAIN}     a gathering (when <label> is an event slug) AND a member handle
 *                                   host (`/.well-known/atproto-did`, `/xrpc/*` go to the PDS)
 *
 * `resolveGatheringHost` is what `src/middleware.ts` (package A) routes on; it delegates to A's
 * cached resolver so there is one answer per host. `allowCertificateFor` is the on-demand TLS gate
 * behind `/internal/tls-check`.
 *
 * TLS GATE — closed sets only, never a pattern (Let's Encrypt allows 50 certificates per
 * registered domain per week; a pattern-based gate spends that on the first bot scan):
 *   1. `www.<web host>` and the web host itself, and the PDS host — no I/O
 *   2. an existing gathering slug directly under the handle domain — a primary-key lookup
 *   3. a single label under the handle domain that OUR PDS vouches for (its `/tls-check`)
 *   everything else NO, and so is a database or PDS that does not answer (PDS: 3 s timeout).
 * The domain is never logged, echoed or carried into an error (R9: it names a member's handle).
 */
import { sql } from '@/lib/db'
import { labelUnder } from '@/lib/auth/handles'
import { resolveGatheringHost as resolveHost } from '@/lib/events/hosts'
import { pdsInternalUrl } from './config'

export const PDS_TLS_CHECK_TIMEOUT_MS = 3000
const DB_TIMEOUT_MS = 3000

/** The event slug a request `Host` routes to, or null (apex, infrastructure label, unknown label). */
export async function resolveGatheringHost(host: string | null): Promise<string | null> {
  const r = await resolveHost(host)
  return r.kind === 'gathering' ? r.slug : null
}

function hostnameOf(url: string | undefined): string | null {
  if (!url?.trim()) return null
  try {
    return new URL(url.trim()).hostname.toLowerCase()
  } catch {
    return null
  }
}

function handleDomainOrNull(): string | null {
  const d = (process.env.PDS_HANDLE_DOMAIN ?? '').trim().replace(/^\.+/, '').replace(/\.+$/, '').toLowerCase()
  return d || null
}

export function normalizeDomain(domain: string | null | undefined): string | null {
  const host = (domain ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || host.includes('..') || host.startsWith('.') || host.startsWith('-')) return null
  return host
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

async function isGatheringSlug(label: string): Promise<boolean> {
  try {
    const rows = await withTimeout(sql`select 1 from events where slug = ${label} limit 1`, DB_TIMEOUT_MS)
    return rows.length > 0
  } catch {
    return false
  }
}

async function pdsVouchesFor(host: string): Promise<boolean> {
  try {
    const url = new URL('/tls-check', `${pdsInternalUrl()}/`)
    url.searchParams.set('domain', host)
    const res = await fetch(url, { signal: AbortSignal.timeout(PDS_TLS_CHECK_TIMEOUT_MS), cache: 'no-store' })
    return res.ok
  } catch {
    // Deliberately silent: the only thing to say names the domain.
    return false
  }
}

export type CertificateDecision = 'web' | 'pds' | 'gathering' | 'handle' | 'deny'

/** The decision and why (the reason is for tests; the route answers only 200/403). */
export async function certificateDecision(domain: string | null | undefined): Promise<CertificateDecision> {
  const host = normalizeDomain(domain)
  if (!host) return 'deny'

  const web = hostnameOf(process.env.NEXT_PUBLIC_APP_URL)
  if (web && (host === web || host === `www.${web.replace(/^www\./, '')}` || host === web.replace(/^www\./, ''))) return 'web'
  const pds = hostnameOf(process.env.PDS_URL) ?? hostnameOf(process.env.ATPROTO_DEFAULT_PDS_URL)
  if (pds && host === pds) return 'pds'

  const domainSuffix = handleDomainOrNull()
  if (!domainSuffix) return 'deny'
  const label = labelUnder(host, domainSuffix)
  if (!label) return 'deny'
  if (await isGatheringSlug(label)) return 'gathering'
  return (await pdsVouchesFor(host)) ? 'handle' : 'deny'
}

export async function allowCertificateFor(domain: string | null | undefined): Promise<boolean> {
  return (await certificateDecision(domain)) !== 'deny'
}
