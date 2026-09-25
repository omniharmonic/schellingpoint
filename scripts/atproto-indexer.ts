/**
 * Jetstream consumer: the live half of the index (docs/ATPROTO_IMPLEMENTATION.md §4).
 *
 *   npm run atproto:indexer
 *
 * Subscribes to the Jetstream v1 `/subscribe` endpoint (`ATPROTO_JETSTREAM_URL`)
 * with `wantedCollections` = JETSTREAM_COLLECTIONS (ours + borrowed), resumes from the persisted
 * `at_sync_cursor('jetstream')` (unix microseconds), hands EVERY frame to `processJetstreamFrame`
 * (commits relevance-filtered and, where they change app state, verified against the author's PDS;
 * `account` frames hide/restore repos; `identity` frames evict caches and re-verify handles), drains
 * targeted reconcile requests every 30s, advances the cursor MONOTONICALLY every ~2s and on
 * shutdown (a frame that fails never holds it back), reconnects with 1s→30s backoff, logs a
 * heartbeat every 60s. Log lines carry collections and outcomes only — never a DID, handle or AT-URI (R9).
 *
 * Frame shapes (Jetstream v1 `/subscribe`, README + RFD §5.1; see `JetstreamFrame` in ingest.ts):
 *   commit    {did, time_us, kind:'commit', commit:{rev, operation, collection, rkey, cid?, record?}}
 *   identity  {did, time_us, kind:'identity', identity:{did, handle?, seq, time}}
 *   account   {did, time_us, kind:'account', account:{active, did, seq, time, status?}}
 *   v1 sends identity/account frames for every DID on the network, whatever `wantedCollections` says.
 *
 * Runs outside Next.js: `src/lib/atproto/*` is bundled on the fly with esbuild
 * (a tsx dependency) so `server-only`, `@/` paths and ESM-only packages all
 * resolve exactly as they do in the app. Env comes from `.env.local` via @next/env.
 */
import { loadEnvConfig } from '@next/env'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production')

import { JETSTREAM_COLLECTIONS } from '../src/lib/atproto/nsids'

type Ingest = typeof import('../src/lib/atproto/ingest')
type IndexStore = typeof import('../src/lib/atproto/index-store')

const CURSOR_FLUSH_MS = 2_000
const HEARTBEAT_MS = 60_000
const RECONCILE_DRAIN_MS = 30_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
const OPEN_TIMEOUT_MS = 30_000 // a handshake that neither opens nor fails within this is abandoned
/** Re-subscribe slightly behind the last frame: Jetstream replay is inclusive and ingest is idempotent. */
const RESUME_OVERLAP_US = 5_000_000

function ts(): string {
  return new Date().toISOString()
}
function log(msg: string, extra?: Record<string, unknown>): void {
  console.log(`${ts()} [indexer] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`)
}

/**
 * Bundle server-only modules from `src/` into an ESM file inside the project
 * (so bare imports still resolve against ./node_modules) and import it.
 */
async function loadServerModules(): Promise<{ ingest: Ingest; store: IndexStore }> {
  const root = process.cwd()
  const outdir = path.resolve(root, 'node_modules/.cache/schellingpoint-atproto/indexer')
  mkdirSync(outdir, { recursive: true })
  await build({
    entryPoints: {
      ingest: path.resolve(root, 'src/lib/atproto/ingest.ts'),
      'index-store': path.resolve(root, 'src/lib/atproto/index-store.ts'),
    },
    outdir,
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent',
    alias: { 'server-only': path.resolve(root, 'node_modules/next/dist/compiled/server-only/empty.js') },
  })
  const ingest = (await import(pathToFileURL(path.join(outdir, 'ingest.js')).href)) as Ingest
  const store = (await import(pathToFileURL(path.join(outdir, 'index-store.js')).href)) as IndexStore
  return { ingest, store }
}

async function main(): Promise<void> {
  const { ingest, store } = await loadServerModules()
  const { processJetstreamFrame, drainReconcileRequests, jetstreamSubscribeUrl, indexStats, JETSTREAM_CURSOR_SOURCE } = ingest

  try {
    const stats = await indexStats()
    if (stats.records === 0 && !stats.reconciledAt) {
      log('WARNING: at_records is empty and reconcileAll has never run; the live tail only sees new commits. Run GET /api/atproto/sync (or wait for the hourly cron) to backfill.')
    } else {
      log('index state', stats)
    }
  } catch (e) {
    log('could not read index stats', { error: e instanceof Error ? e.message : String(e) })
  }

  const persisted = await store.getCursor(JETSTREAM_CURSOR_SOURCE)
  let lastTimeUs: number | null = persisted && /^\d+$/.test(persisted) ? Number(persisted) : null
  let flushedTimeUs: number | null = lastTimeUs
  let ws: WebSocket | null = null
  let backoff = BACKOFF_MIN_MS
  let stopping = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let frames = 0
  let ingested = 0
  let queue: Promise<void> = Promise.resolve()

  async function flushCursor(): Promise<void> {
    if (lastTimeUs === null || lastTimeUs === flushedTimeUs) return
    const value = lastTimeUs
    try {
      await ingest.persistJetstreamCursor(value)
      flushedTimeUs = value
    } catch (e) {
      log('cursor persist failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  function connect(): void {
    if (stopping) return
    const cursor = lastTimeUs !== null ? Math.max(0, lastTimeUs - RESUME_OVERLAP_US) : null
    const url = jetstreamSubscribeUrl(JETSTREAM_COLLECTIONS, cursor)
    log('connecting', { host: new URL(url).host, cursor, collections: JETSTREAM_COLLECTIONS.length })
    const socket = new WebSocket(url)
    ws = socket

    // One reconnect per socket, whichever signal arrives first. Node's WebSocket reports a
    // failed handshake (non-101 status, network error) as an `error` event that is not always
    // followed by `close`; relying on `close` alone left the indexer disconnected for hours
    // with nothing scheduled (observed 2026-09-25). A handshake that never completes at all is
    // bounded by the open timeout below.
    let settled = false
    const scheduleReconnect = (code: number, reason?: string) => {
      if (ws === socket) ws = null
      if (settled || stopping) return
      settled = true
      clearTimeout(openTimeout)
      log('disconnected', { code, reason: reason || undefined, retryInMs: backoff })
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
    const openTimeout = setTimeout(() => {
      if (socket.readyState === WebSocket.CONNECTING) {
        log('open timeout', { afterMs: OPEN_TIMEOUT_MS })
        try {
          socket.close()
        } catch {
          // never opened
        }
        scheduleReconnect(1006, 'open timeout')
      }
    }, OPEN_TIMEOUT_MS)

    socket.onopen = () => {
      clearTimeout(openTimeout)
      backoff = BACKOFF_MIN_MS
      log('connected')
    }
    socket.onmessage = (event: MessageEvent) => {
      frames++
      let frame: Parameters<typeof processJetstreamFrame>[0]
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (typeof frame?.time_us === 'number' && (lastTimeUs === null || frame.time_us > lastTimeUs)) {
        lastTimeUs = frame.time_us // monotonic
      }
      if (frame?.kind !== 'commit' && frame?.kind !== 'account' && frame?.kind !== 'identity') return
      // Serialise handling so create/update/delete for one URI (and account changes) apply in stream order.
      queue = queue
        .then(async () => {
          const res = await processJetstreamFrame(frame)
          if (!res) return
          if (res.kind === 'commit') {
            const r = res.result
            if (r.outcome === 'skipped:irrelevant' || r.outcome === 'skipped:collection') return
            ingested++
            log(`${r.operation} ${r.outcome} ${r.collection}`, {
              ...(r.sideEffects.length ? { effects: r.sideEffects.map((e) => e.split(':')[0]) } : {}),
              ...(r.warnings.length ? { warnings: r.warnings.length } : {}),
            })
            return
          }
          if (res.outcome !== 'applied') return
          ingested++
          if (res.kind === 'account') {
            log(`account ${res.status?.changed ?? 'applied'}`, { hidden: res.status?.hidden, sessionsFlagged: res.status?.sessionsFlagged, purged: res.purged })
          } else {
            log(`identity ${res.identity?.state ?? 'applied'}`)
          }
        })
        .catch((e) => log('frame failed', { kind: frame.kind, error: e instanceof Error ? e.name : 'error' }))
    }
    socket.onerror = (event: Event) => {
      log('socket error', { message: (event as ErrorEvent).message ?? 'unknown' })
      // An error on an open socket is followed by `close`, which is a no-op once settled; an
      // error during the handshake may be the only signal we get.
      if (socket.readyState !== WebSocket.OPEN) scheduleReconnect(1006, 'socket error')
    }
    socket.onclose = (event: CloseEvent) => {
      scheduleReconnect(event.code, event.reason)
    }
  }

  const flushTimer = setInterval(() => void flushCursor(), CURSOR_FLUSH_MS)
  const drainTimer = setInterval(() => {
    queue = queue
      .then(async () => {
        const r = await drainReconcileRequests(5)
        if (r.repos) log('targeted reconcile', r)
      })
      .catch((e) => log('reconcile drain failed', { error: e instanceof Error ? e.name : 'error' }))
  }, RECONCILE_DRAIN_MS)
  const heartbeatTimer = setInterval(() => {
    log('heartbeat', { connected: ws?.readyState === WebSocket.OPEN, frames, ingested, cursor: lastTimeUs, cursorAt: lastTimeUs ? new Date(lastTimeUs / 1000).toISOString() : null })
  }, HEARTBEAT_MS)

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return
    stopping = true
    log(`received ${signal}; shutting down`)
    clearInterval(flushTimer)
    clearInterval(drainTimer)
    clearInterval(heartbeatTimer)
    if (reconnectTimer) clearTimeout(reconnectTimer)
    try {
      ws?.close(1000, 'shutdown')
    } catch {
      // already closed
    }
    await queue.catch(() => undefined)
    await flushCursor()
    log('cursor persisted; bye', { cursor: lastTimeUs, frames, ingested })
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))

  connect()
}

main().catch((e) => {
  console.error(`${ts()} [indexer] fatal`, e)
  process.exit(1)
})
