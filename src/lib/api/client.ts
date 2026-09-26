/**
 * The browser's only way to talk to the server (plan §3.3): same-origin `/api/*` with the
 * HttpOnly session cookie. No tokens, no Authorization headers, no database URLs.
 */

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly field?: string
  constructor(message: string, status: number, code?: string, field?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.field = field
  }
}

/**
 * The array at `key` in a payload `apiFetch` returned.
 *
 * `apiFetch` hands back whatever came over the wire: `null` for an empty body, a string when a
 * proxy or a restarting server substituted an HTML page for JSON with a 200. Reading a list off
 * one of those (`data.sessions.map(…)`) throws inside render and blanks the page behind the error
 * boundary, which is not what a bad answer should cost. Checking here turns it into the load
 * failure every caller already handles.
 */
export function listFrom<T>(data: unknown, key: string): T[] {
  const value = data && typeof data === 'object' ? (data as Record<string, unknown>)[key] : undefined
  if (!Array.isArray(value)) {
    throw new ApiError('That did not load correctly. Try again.', 502, 'MalformedResponse')
  }
  return value as T[]
}

export async function apiFetch<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const h = new Headers(headers)
  if (!h.has('Accept')) h.set('Accept', 'application/json')
  let body = rest.body
  if (json !== undefined) {
    h.set('Content-Type', 'application/json')
    body = JSON.stringify(json)
  }
  const res = await fetch(path, { ...rest, body, headers: h, credentials: 'same-origin' })
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  if (!res.ok) {
    const obj = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
    const message =
      typeof obj.error === 'string' ? obj.error
        : typeof obj.message === 'string' ? obj.message
          : typeof data === 'string' && data ? data
            : `Request failed (${res.status})`
    throw new ApiError(
      message,
      res.status,
      typeof obj.code === 'string' ? obj.code : undefined,
      typeof obj.field === 'string' ? obj.field : undefined,
    )
  }
  return data as T
}
