/**
 * Rate-limit backoff and per-repo pacing for every XRPC call we make to a PDS.
 *
 * WHAT THE REFERENCE PDS ENFORCES (verified in `@atproto/pds` 0.5.34, the `ghcr.io/bluesky-social/pds:0.4`
 * image our stack runs — `dist/rate-limits.js`, `dist/api/com/atproto/repo/*.js`):
 *   - `repo-write-hour`  5 000 points per DID per hour
 *   - `repo-write-day`  35 000 points per DID per day
 *     create = 3 points, update (putRecord) = 2, delete = 1; `applyWrites` sums its operations
 *   - `global-ip`        3 000 requests per IP per 5 minutes (reads included)
 *   - `applyWrites`      at most 200 operations per call, JSON body ≤ 1 MB, no per-record swap
 *                        (only `swapCommit`); a `create` of an existing key fails the whole batch
 * A refused call is HTTP 429 `RateLimitExceeded` with `RateLimit-Reset` (epoch SECONDS),
 * `RateLimit-Remaining`, `RateLimit-Limit`, `RateLimit-Policy` and `Retry-After` (seconds).
 * `XRPCError.headers` carries them (lower-cased by `fetch`'s Headers → the HeadersMap).
 *
 * WHAT THIS MODULE DOES
 *   - `withXrpcBackoff(fn)`: 429 → wait until `ratelimit-reset` / `Retry-After` (never less than a
 *     capped exponential backoff with jitter), bounded by a total wait budget per call (default
 *     60 s). A reset further away than the remaining budget fails immediately with
 *     `RateLimitBudgetExceededError` (typed, carries `retryAfterMs`) instead of sleeping uselessly.
 *     5xx `InternalServerError` / `UpstreamFailure` / `NotEnoughResources` / 504 are retried a few
 *     times; connection failures (no response) twice. Nothing else is retried — `InvalidSwap`,
 *     auth and validation answers go straight back to the caller.
 *   - `repoWriteGate(did, points, fn)`: at most ONE write per repo at a time in this process, and
 *     an in-process ledger of points spent per repo in the last hour/day that paces bulk loops to
 *     stay under the PDS budget (with headroom for the repo's other writers). The ledger is per
 *     process; the PDS's own 429 (handled above) is the cross-process backstop.
 *
 * No I/O of its own and no `server-only` import, so tests drive it with fake agents and clocks.
 */

export const PDS_WRITE_POINTS = { create: 3, update: 2, delete: 1 } as const
export const PDS_REPO_WRITE_HOUR_POINTS = 5_000
export const PDS_REPO_WRITE_DAY_POINTS = 35_000
/** The reference PDS refuses more; we stay well under it (and under the 1 MB body cap). */
export const PDS_APPLY_WRITES_MAX_OPS = 200
export const APPLY_WRITES_MAX_OPS = 100

export const DEFAULT_MAX_TOTAL_WAIT_MS = 60_000
const BASE_BACKOFF_MS = 250
const MAX_BACKOFF_MS = 10_000
const DEFAULT_TRANSIENT_RETRIES = 3
const DEFAULT_NETWORK_RETRIES = 2
/** Hard stop on 429 loops even when the server keeps naming a near reset. */
const MAX_RATE_LIMIT_RETRIES = 8

/** A write could not be made within its wait budget because the PDS (or our pacer) rate-limited it. */
export class RateLimitBudgetExceededError extends Error {
  readonly code = 'RateLimitBudgetExceeded'
  readonly status = 503
  constructor(
    /** How long from now the limit is expected to lift. */
    readonly retryAfterMs: number,
    /** What we already waited for this call. */
    readonly waitedMs: number,
    readonly source: 'pds' | 'pacer',
  ) {
    super(
      `rate limited by ${source === 'pds' ? 'the PDS' : 'the repo write budget'}; retry in ${Math.ceil(retryAfterMs / 1000)}s (waited ${Math.round(waitedMs / 1000)}s)`,
    )
    this.name = 'RateLimitBudgetExceededError'
  }
}

export function isRateLimitBudgetExceeded(e: unknown): e is RateLimitBudgetExceededError {
  return e instanceof RateLimitBudgetExceededError || (e as { code?: string } | undefined)?.code === 'RateLimitBudgetExceeded'
}

type HeaderBag = Record<string, string | string[] | undefined> | Headers | undefined

function header(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined
  const bag = headers as Record<string, string | string[] | undefined>
  const want = name.toLowerCase()
  for (const [k, v] of Object.entries(bag)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v
  }
  return undefined
}

/**
 * Milliseconds until a rate limit lifts, from `RateLimit-Reset` (epoch seconds; a small value is
 * read as delta seconds, per the IETF draft) or `Retry-After` (seconds or an HTTP date). `null`
 * when neither header is usable.
 */
export function retryAfterMsFromHeaders(headers: HeaderBag, now = Date.now()): number | null {
  const candidates: number[] = []
  const reset = header(headers, 'ratelimit-reset')
  if (reset && /^\d+(\.\d+)?$/.test(reset.trim())) {
    const n = Number(reset)
    // An epoch in seconds is ~1.7e9; anything below a year's worth of seconds is a delta.
    candidates.push(n > 31_536_000 ? n * 1000 - now : n * 1000)
  }
  const retryAfter = header(headers, 'retry-after')
  if (retryAfter) {
    const trimmed = retryAfter.trim()
    if (/^\d+(\.\d+)?$/.test(trimmed)) candidates.push(Number(trimmed) * 1000)
    else {
      const at = Date.parse(trimmed)
      if (Number.isFinite(at)) candidates.push(at - now)
    }
  }
  if (!candidates.length) return null
  return Math.max(0, Math.max(...candidates))
}

interface ErrorShape {
  status?: number
  error?: string
  headers?: HeaderBag
  code?: string
  cause?: { code?: string }
  message?: string
}

export type XrpcFailureKind = 'rate-limit' | 'transient' | 'network' | 'other'

/** Classify an error from `@atproto/api` / `@atproto/xrpc` (duck-typed, so fakes work too). */
export function classifyXrpcError(e: unknown): XrpcFailureKind {
  const err = (e ?? {}) as ErrorShape
  if (err.status === 429 || err.error === 'RateLimitExceeded') return 'rate-limit'
  if (err.error === 'InternalServerError' || err.error === 'UpstreamFailure' || err.error === 'NotEnoughResources' || err.error === 'UpstreamTimeout') return 'transient'
  if (typeof err.status === 'number' && [500, 502, 503, 504].includes(err.status)) return 'transient'
  // ResponseType.Unknown (1) is what XRPCError uses when no HTTP response arrived.
  if (err.status === 1) return 'network'
  if (e instanceof TypeError && /fetch failed|network/i.test(e.message)) return 'network'
  const code = err.code ?? err.cause?.code
  if (typeof code === 'string' && /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR)/.test(code)) return 'network'
  return 'other'
}

export interface BackoffOptions {
  /** Total time this call may spend sleeping before it gives up (default 60 s). */
  maxTotalWaitMs?: number
  /** 5xx retries (default 3). */
  transientRetries?: number
  /** Connection-failure retries (default 2). */
  networkRetries?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  random?: () => number
  /** Observability hook; never receives record bodies. */
  onRetry?: (info: { kind: XrpcFailureKind; attempt: number; waitMs: number }) => void
}

export const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Full-jitter exponential backoff, capped. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(ceiling / 2 + random() * (ceiling / 2))
}

/** Run one XRPC call with rate-limit / 5xx / network backoff (see module doc). */
export async function withXrpcBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const maxWait = opts.maxTotalWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS
  const sleep = opts.sleep ?? realSleep
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  const limits = { 'rate-limit': MAX_RATE_LIMIT_RETRIES, transient: opts.transientRetries ?? DEFAULT_TRANSIENT_RETRIES, network: opts.networkRetries ?? DEFAULT_NETWORK_RETRIES }
  const used = { 'rate-limit': 0, transient: 0, network: 0 }
  let waited = 0
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const kind = classifyXrpcError(e)
      if (kind === 'other') throw e
      const remaining = maxWait - waited
      if (kind === 'rate-limit') {
        const named = retryAfterMsFromHeaders((e as ErrorShape).headers, now())
        // Wait at least the server's reset (plus a little jitter so many writers do not stampede).
        const wait = Math.max(named ?? 0, backoffMs(used['rate-limit'] + 1, random)) + Math.round(random() * 250)
        if (used['rate-limit'] >= limits['rate-limit'] || wait > remaining) {
          throw new RateLimitBudgetExceededError(named ?? wait, waited, 'pds')
        }
        used['rate-limit']++
        opts.onRetry?.({ kind, attempt, waitMs: wait })
        await sleep(wait)
        waited += wait
        continue
      }
      if (used[kind] >= limits[kind]) throw e
      const wait = Math.min(backoffMs(used[kind] + 1, random), Math.max(0, remaining))
      if (wait <= 0 && remaining <= 0) throw e
      used[kind]++
      opts.onRetry?.({ kind, attempt, waitMs: wait })
      await sleep(wait)
      waited += wait
    }
  }
}

/* ───────────────────────────── per-repo pacing ───────────────────────────── */

export interface PacerOptions {
  /** Points we allow ourselves per repo per hour (default 80 % of the PDS's 5 000). */
  hourPoints?: number
  /** Points per repo per day (default 80 % of 35 000). */
  dayPoints?: number
  /** How long a write may wait for the budget before failing with `RateLimitBudgetExceededError`. */
  maxWaitMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function envNumber(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

/**
 * Serialises writes per repo and keeps each repo under a points budget. One instance per process
 * (`repoWritePacer`); tests build their own with a fake clock.
 */
export class RepoWritePacer {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly spent = new Map<string, Array<{ at: number; points: number }>>()
  private readonly hourPoints: number
  private readonly dayPoints: number
  private readonly maxWaitMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: PacerOptions = {}) {
    this.hourPoints = opts.hourPoints ?? envNumber('ATPROTO_REPO_WRITE_HOUR_POINTS', Math.floor(PDS_REPO_WRITE_HOUR_POINTS * 0.8))
    this.dayPoints = opts.dayPoints ?? envNumber('ATPROTO_REPO_WRITE_DAY_POINTS', Math.floor(PDS_REPO_WRITE_DAY_POINTS * 0.8))
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_TOTAL_WAIT_MS
    this.now = opts.now ?? Date.now
    this.sleep = opts.sleep ?? realSleep
  }

  /** Points spent by `did` inside the window ending now. */
  spentIn(did: string, windowMs: number): number {
    const cutoff = this.now() - windowMs
    return (this.spent.get(did) ?? []).reduce((sum, e) => (e.at > cutoff ? sum + e.points : sum), 0)
  }

  /** How long until `points` more fit in both windows (0 = now; Infinity = never, the write is too big). */
  waitFor(did: string, points: number): number {
    if (points > this.hourPoints || points > this.dayPoints) return Infinity
    const entries = (this.spent.get(did) ?? []).slice().sort((a, b) => a.at - b.at)
    const now = this.now()
    let wait = 0
    for (const [windowMs, budget] of [[HOUR_MS, this.hourPoints], [DAY_MS, this.dayPoints]] as const) {
      let inWindow = entries.filter((e) => e.at > now - windowMs)
      let total = inWindow.reduce((s, e) => s + e.points, 0)
      let w = 0
      while (total + points > budget && inWindow.length) {
        const oldest = inWindow.shift()!
        total -= oldest.points
        w = oldest.at + windowMs - now
      }
      wait = Math.max(wait, w)
    }
    return Math.max(0, wait)
  }

  private record(did: string, points: number): void {
    const now = this.now()
    const list = (this.spent.get(did) ?? []).filter((e) => e.at > now - DAY_MS)
    list.push({ at: now, points })
    this.spent.set(did, list)
  }

  /** Run `fn` as the only write to `did` in flight, after the budget has room for `points`. */
  async run<T>(did: string, points: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(did) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => (release = resolve))
    const tail = previous.then(() => mine)
    this.tails.set(did, tail)
    await previous.catch(() => undefined)
    try {
      const wait = this.waitFor(did, points)
      if (wait > this.maxWaitMs) throw new RateLimitBudgetExceededError(wait, 0, 'pacer')
      if (wait > 0) await this.sleep(wait)
      // Charge before the call: a write that fails at the PDS still usually consumed points.
      this.record(did, points)
      return await fn()
    } finally {
      release()
      if (this.tails.get(did) === tail) this.tails.delete(did)
    }
  }

  reset(): void {
    this.tails.clear()
    this.spent.clear()
  }
}

/** The process-wide pacer every repo write goes through. */
export const repoWritePacer = new RepoWritePacer()

/** `repoWritePacer.run(did, points, () => withXrpcBackoff(fn))`. */
export function paceRepoWrite<T>(did: string, points: number, fn: () => Promise<T>, opts?: BackoffOptions): Promise<T> {
  return repoWritePacer.run(did, points, () => withXrpcBackoff(fn, opts))
}

/** Split `items` into chunks of at most `max` (an `applyWrites` call never exceeds the cap). */
export function chunk<T>(items: readonly T[], max: number): T[][] {
  const size = Math.max(1, Math.min(Math.trunc(max), PDS_APPLY_WRITES_MAX_OPS))
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
