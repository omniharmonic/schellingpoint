import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { pdsInternalUrl } from '@/lib/atproto/config'

/**
 * GET /api/health — liveness for the deploy (spec §12, plan §7.2).
 *
 * → 200 { status: 'ok',       checks: { db: 'ok', pds: 'ok' } }
 * → 503 { status: 'degraded', checks: { db: 'ok' | 'error', pds: 'ok' | 'error' } }
 *
 * Each check has a 2 s budget. Nothing about the failure (hosts, messages, versions) is
 * returned: the details go to the server log only.
 */

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const TIMEOUT_MS = 2_000

type CheckResult = 'ok' | 'error'

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

async function checkDb(): Promise<CheckResult> {
  try {
    const rows = await withTimeout(sql<{ ok: number }[]>`select 1 as ok`, 'db')
    return rows[0]?.ok === 1 ? 'ok' : 'error'
  } catch (e) {
    console.error('[health] db check failed:', e instanceof Error ? e.message : e)
    return 'error'
  }
}

async function checkPds(): Promise<CheckResult> {
  try {
    const res = await fetch(`${pdsInternalUrl()}/xrpc/_health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      console.error(`[health] pds check failed: HTTP ${res.status}`)
      return 'error'
    }
    await res.body?.cancel()
    return 'ok'
  } catch (e) {
    console.error('[health] pds check failed:', e instanceof Error ? e.name : e)
    return 'error'
  }
}

export async function GET() {
  const [db, pds] = await Promise.all([checkDb(), checkPds()])
  const healthy = db === 'ok' && pds === 'ok'
  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', checks: { db, pds } },
    { status: healthy ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  )
}
