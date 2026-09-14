/**
 * Jetstream consumer: the live half of the index (docs/ATPROTO_IMPLEMENTATION.md §4).
 *
 *   npm run atproto:indexer
 *
 * Subscribes to the Jetstream v1 `/subscribe` endpoint (`ATPROTO_JETSTREAM_URL`)
 * with `wantedCollections` = INDEXED_COLLECTIONS, resumes from the persisted
 * `at_sync_cursor('jetstream')` (unix microseconds), ingests every commit
 * through `ingestFromJetstreamFrame`, persists the cursor every ~2s and on
 * shutdown, reconnects with 1s→30s backoff, logs a heartbeat every 60s.
 *
 * Frame shape (validated live against jetstream2.us-east and the Jetstream RFD §5.1):
 *   {did, time_us, kind:'commit'|'identity'|'account',
 *    commit?: {rev, operation:'create'|'update'|'delete', collection, rkey, cid?, record?}}
 *   `record`/`cid` are absent on delete; `identity`/`account` frames have no `commit`.
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

import { INDEXED_COLLECTIONS } from '../src/lib/atproto/nsids'

type Ingest = typeof import('../src/lib/atproto/ingest')
type IndexStore = typeof import('../src/lib/atproto/index-store')

const CURSOR_FLUSH_MS = 2_000
const HEARTBEAT_MS = 60_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 30_000
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
  const { ingestFromJetstreamFrame, jetstreamSubscribeUrl, indexStats, JETSTREAM_CURSOR_SOURCE } = ingest

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
      await store.setCursor(JETSTREAM_CURSOR_SOURCE, String(value))
      flushedTimeUs = value
    } catch (e) {
      log('cursor persist failed', { error: e instanceof Error ? e.message : String(e) })
    }
  }

  function connect(): void {
    if (stopping) return
    const cursor = lastTimeUs !== null ? Math.max(0, lastTimeUs - RESUME_OVERLAP_US) : null
    const url = jetstreamSubscribeUrl(INDEXED_COLLECTIONS, cursor)
    log('connecting', { url: url.replace(/cursor=\d+/, 'cursor=…'), cursor, collections: INDEXED_COLLECTIONS.length })
    const socket = new WebSocket(url)
    ws = socket

    socket.onopen = () => {
      backoff = BACKOFF_MIN_MS
      log('connected')
    }
    socket.onmessage = (event: MessageEvent) => {
      frames++
      let frame: Parameters<typeof ingestFromJetstreamFrame>[0]
      try {
        frame = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
      } catch {
        return
      }
      if (typeof frame?.time_us === 'number' && (lastTimeUs === null || frame.time_us > lastTimeUs)) {
        lastTimeUs = frame.time_us // monotonic
      }
      if (frame?.kind !== 'commit' || !frame.commit) return
      // Serialise ingestion so create/update/delete for one URI apply in stream order.
      queue = queue
        .then(async () => {
          const res = await ingestFromJetstreamFrame(frame)
          if (!res) return
          ingested++
          log(`${res.operation} ${res.outcome} ${res.uri}`, {
            ...(res.sideEffects.length ? { effects: res.sideEffects } : {}),
            ...(res.warnings.length ? { warnings: res.warnings } : {}),
          })
        })
        .catch((e) => log('ingest failed', { did: frame.did, collection: frame.commit?.collection, rkey: frame.commit?.rkey, error: e instanceof Error ? e.message : String(e) }))
    }
    socket.onerror = (event: Event) => {
      log('socket error', { message: (event as ErrorEvent).message ?? 'unknown' })
    }
    socket.onclose = (event: CloseEvent) => {
      if (ws === socket) ws = null
      if (stopping) return
      log('disconnected', { code: event.code, reason: event.reason || undefined, retryInMs: backoff })
      reconnectTimer = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
  }

  const flushTimer = setInterval(() => void flushCursor(), CURSOR_FLUSH_MS)
  const heartbeatTimer = setInterval(() => {
    log('heartbeat', { connected: ws?.readyState === WebSocket.OPEN, frames, ingested, cursor: lastTimeUs, cursorAt: lastTimeUs ? new Date(lastTimeUs / 1000).toISOString() : null })
  }, HEARTBEAT_MS)

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return
    stopping = true
    log(`received ${signal}; shutting down`)
    clearInterval(flushTimer)
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
