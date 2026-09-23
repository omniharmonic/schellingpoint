import 'server-only'
import postgres from 'postgres'

/**
 * Postgres access for the AppView (docs/ATPROTO_APPVIEW_PLAN.md §3.1).
 *
 * - `sql`        service connection (APP_DB_USER: BYPASSRLS, not superuser)
 * - `tx`         a transaction on the service connection
 * - `asAccount`  a transaction running as `authenticated` with auth.uid() = accountId,
 *                so RLS policies and participation triggers apply
 *
 * Tagged-template SQL only. Values come back shaped like the old PostgREST
 * responses: timestamps as ISO strings, `date` as 'YYYY-MM-DD', int8/numeric as
 * numbers (when they fit), jsonb as objects.
 */

export type Sql = postgres.Sql | postgres.TransactionSql
export type Row = Record<string, unknown>

const OID = {
  int8: 20,
  numeric: 1700,
  date: 1082,
  timestamp: 1114,
  timestamptz: 1184,
} as const

function serializeTimestamp(x: unknown): string {
  return x instanceof Date ? x.toISOString() : String(x)
}

/** 'YYYY-MM-DD hh:mm:ss[.ffffff]+TZ' → ISO 8601; 'infinity' etc. stay raw. */
function parseTimestamptz(x: string): string {
  const d = new Date(x)
  return Number.isNaN(d.getTime()) ? x : d.toISOString()
}

/** timestamp without time zone is read as UTC (never the Node process zone). */
function parseTimestamp(x: string): string {
  const d = new Date(`${x.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? x : d.toISOString()
}

function parseNumber(x: string): number | string {
  const n = Number(x)
  return Number.isFinite(n) && (Number.isSafeInteger(n) || !/^-?\d+$/.test(x)) ? n : x
}

/**
 * Keys override postgres.js built-ins by OID. The built-in `date` handler maps
 * 1082/1114/1184 to Date objects; every OID it claims is re-registered here.
 */
const types = {
  date: {
    to: OID.timestamptz,
    from: [OID.timestamptz],
    serialize: serializeTimestamp,
    parse: parseTimestamptz,
  },
  timestamp: {
    to: OID.timestamp,
    from: [OID.timestamp],
    serialize: serializeTimestamp,
    parse: parseTimestamp,
  },
  dateOnly: {
    to: OID.date,
    from: [OID.date],
    serialize: (x: unknown) => (x instanceof Date ? x.toISOString().slice(0, 10) : String(x)),
    parse: (x: string) => x,
  },
  bigint: {
    to: OID.int8,
    from: [OID.int8],
    serialize: (x: unknown) => String(x),
    parse: parseNumber,
  },
  numeric: {
    to: OID.numeric,
    from: [OID.numeric],
    serialize: (x: unknown) => String(x),
    parse: parseNumber,
  },
}

/** Connection options shared with tests (tests/db-baseline.spec.ts). */
export const connectionOptions = {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: true,
  transform: { undefined: null },
  types,
  onnotice: () => {},
} satisfies postgres.Options<Record<string, postgres.PostgresType>>

type GlobalWithSql = typeof globalThis & { __unconferenceSql?: postgres.Sql }

function client(): postgres.Sql {
  // Reuse across Next.js dev hot reloads so each reload does not leak a pool.
  const g = globalThis as GlobalWithSql
  if (!g.__unconferenceSql) {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL is not set')
    g.__unconferenceSql = postgres(url, connectionOptions) as unknown as postgres.Sql
  }
  return g.__unconferenceSql
}

/**
 * Service connection (RLS bypassed). Lazily created from DATABASE_URL on first
 * use, so importing this module never connects (e.g. during `next build`).
 */
export const sql: postgres.Sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  apply(_target, _this, args) {
    return (client() as unknown as (...a: unknown[]) => unknown)(...args)
  },
  get(_target, prop) {
    const c = client() as unknown as Record<PropertyKey, unknown>
    if (prop === 'end') {
      // Ending the pool forgets it, so the next query opens a fresh one instead of failing with
      // CONNECTION_ENDED. Matters for long-lived processes (tests sharing a worker, scripts).
      return async (options?: { timeout?: number }) => {
        const g = globalThis as GlobalWithSql
        if (g.__unconferenceSql === (c as unknown as postgres.Sql)) g.__unconferenceSql = undefined
        await (c.end as (o?: { timeout?: number }) => Promise<void>)(options)
      }
    }
    const value = c[prop]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(c) : value
  },
})

/** Transaction helper. */
export function tx<T>(fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin((t) => fn(t)) as Promise<T>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Run as a signed-in account so DB triggers/policies that call auth.uid() see it:
 * BEGIN; SET LOCAL ROLE authenticated; set_config('request.jwt.claims', '{"sub":id,"role":"authenticated"}', true)
 */
export function asAccount<T>(accountId: string, fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T> {
  if (!UUID.test(accountId)) {
    return Promise.reject(new Error('asAccount: accountId must be a uuid'))
  }
  const claims = JSON.stringify({ sub: accountId, role: 'authenticated' })
  return tx(async (t) => {
    await t`SET LOCAL ROLE authenticated`
    await t`SELECT set_config('request.jwt.claims', ${claims}, true)`
    return fn(t)
  })
}

/** Postgres error helpers: code '23505' unique, '23514' check/participation rule, '42501' privilege. */
export function pgErrorCode(e: unknown): string | null {
  if (e && typeof e === 'object' && 'code' in e) {
    const code = (e as { code: unknown }).code
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code
  }
  return null
}

export function pgMessage(e: unknown): string {
  return e instanceof Error && e.message ? e.message : 'Request rejected'
}

/** Maps rule/unique/privilege errors to JSON responses (403/409/400); null for anything else. */
export function dbErrorResponse(e: unknown): Response | null {
  const code = pgErrorCode(e)
  switch (code) {
    // Participation rules raise check_violation / raise_exception with a
    // human-readable message written for the person acting.
    case '23514':
    case 'P0001':
      return Response.json({ error: pgMessage(e), code }, { status: 403 })
    case '42501': {
      // Triggers raise 42501 with a readable message; RLS and GRANT failures
      // name tables and roles, which stay server-side.
      const message = pgMessage(e)
      const internal = /row-level security|permission denied/i.test(message)
      return Response.json(
        { error: internal ? 'You do not have permission to do that' : message, code },
        { status: 403 },
      )
    }
    case '23505':
      return Response.json({ error: 'Already exists', code }, { status: 409 })
    case '23503':
      return Response.json({ error: 'Related record not found', code }, { status: 400 })
    case '22P02':
      return Response.json({ error: 'Invalid input', code }, { status: 400 })
    default:
      return null
  }
}

/** First row or null. */
export function one<T = Row>(rows: readonly T[] | ArrayLike<T>): T | null {
  return rows.length > 0 ? (rows[0] as T) : null
}
