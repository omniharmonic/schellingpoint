import 'server-only'
/**
 * Per-token request budget for `/api/mcp`: a fixed window, counted in this process.
 *
 * The app runs as one container behind Caddy (deploy/unconference/compose.yml), so one process is
 * the whole server and an in-memory counter is the whole truth. If the app is ever run with more
 * than one replica, each replica enforces its own window and the effective limit multiplies —
 * move this to Postgres then.
 */
export const MCP_REQUESTS_PER_MINUTE = 120
const WINDOW_MS = 60_000

interface Window {
  count: number
  resetAt: number
}

const windows = new Map<string, Window>()

export interface RateDecision {
  ok: boolean
  remaining: number
  /** Seconds until the window resets — the `Retry-After` value on a refusal. */
  retryAfter: number
  limit: number
}

/** Count one request against `key`. Sweeps expired windows as it goes (the map stays small). */
export function takeMcpRequest(key: string, now = Date.now()): RateDecision {
  let window = windows.get(key)
  if (!window || window.resetAt <= now) {
    window = { count: 0, resetAt: now + WINDOW_MS }
    windows.set(key, window)
    if (windows.size > 1000) {
      for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k)
    }
  }
  window.count += 1
  const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000))
  return {
    ok: window.count <= MCP_REQUESTS_PER_MINUTE,
    remaining: Math.max(0, MCP_REQUESTS_PER_MINUTE - window.count),
    retryAfter,
    limit: MCP_REQUESTS_PER_MINUTE,
  }
}

/** Test seam: forget every window. */
export function resetMcpRateLimits(): void {
  windows.clear()
}
