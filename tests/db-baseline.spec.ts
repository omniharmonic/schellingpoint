import { test, expect } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import Module from 'node:module'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import postgres from 'postgres'

// Node-side checks of db/migrations/0001_baseline.sql against the local stack
// (deploy/local/compose.yml, migrated + seeded). No dev server needed.
//   DATABASE_URL=postgres://unconference_app:…@127.0.0.1:55432/unconference
// Every write happens inside a transaction that is rolled back.
loadEnvConfig(process.cwd(), true)

const databaseUrl = process.env.DATABASE_URL || ''
const isLocal = (() => {
  try {
    const u = new URL(databaseUrl)
    return /^postgres(ql)?:$/.test(u.protocol) && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)
  } catch {
    return false
  }
})()

class Rollback extends Error {}

/** Runs fn in a transaction and always rolls it back. */
async function rolledBack(sql: postgres.Sql, fn: (t: postgres.TransactionSql) => Promise<void>) {
  await sql
    .begin(async (t) => {
      await fn(t)
      throw new Rollback()
    })
    .catch((e) => {
      if (!(e instanceof Rollback)) throw e
    })
}

async function insertAccount(t: postgres.TransactionSql, suffix = randomUUID().slice(0, 8)) {
  const [account] = await t<{ id: string }[]>`
    INSERT INTO accounts (did, handle, email, kind)
    VALUES (${`did:plc:test${suffix}`}, ${`tester-${suffix}.test`}, ${`tester-${suffix}@example.test`}, 'custodial')
    RETURNING id`
  return account.id
}

test.describe('database baseline', () => {
  test.skip(!isLocal, 'DATABASE_URL is not a localhost Postgres (run the local stack, see deploy/local/README.md)')

  // `src/lib/db` starts with `import 'server-only'`, which throws outside the
  // react-server bundle. Resolve it to Next's empty stub so the real module is
  // exercised here instead of a copy of its type configuration.
  type Resolver = (request: string, ...rest: unknown[]) => string
  const moduleWithResolver = Module as unknown as { _resolveFilename: Resolver }
  const originalResolve = moduleWithResolver._resolveFilename
  let db: typeof import('../src/lib/db')
  let raw: postgres.Sql

  test.beforeAll(async () => {
    const stub = path.join(path.dirname(require.resolve('next/package.json')), 'dist/compiled/server-only/empty.js')
    moduleWithResolver._resolveFilename = function (request: string, ...rest: unknown[]) {
      return request === 'server-only' ? stub : originalResolve.call(this, request, ...rest)
    }
    // require (not import()) so Playwright's TypeScript loader handles the file.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    db = require('../src/lib/db') as typeof import('../src/lib/db')
    raw = postgres(databaseUrl, { max: 1, onnotice: () => {} })
  })

  test.afterAll(async () => {
    moduleWithResolver._resolveFilename = originalResolve
    await raw?.end({ timeout: 5 })
    await db?.sql.end({ timeout: 5 })
  })

  test('connects as a non-superuser app role with BYPASSRLS', async () => {
    const [role] = await raw`
      SELECT current_user AS name, r.rolsuper, r.rolbypassrls,
             pg_has_role(current_user, 'authenticated', 'MEMBER') AS in_authenticated
      FROM pg_roles r WHERE r.rolname = current_user`
    expect(role.rolsuper).toBe(false)
    expect(role.rolbypassrls).toBe(true)
    expect(role.in_authenticated).toBe(true)
  })

  test('core tables exist and no Supabase schema leaked in', async () => {
    const expected = ['accounts', 'profiles', 'events', 'sessions', 'votes', 'at_records', 'auth_email_tokens', 'app_migrations']
    const rows = await raw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ${raw(expected)}`
    expect(rows.map((r) => r.table_name).sort()).toEqual([...expected].sort())

    const [leftovers] = await raw`
      SELECT
        (SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('auth', 'storage'))::int AS auth_tables,
        (SELECT count(*) FROM pg_publication)::int AS publications,
        (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'supabase%')::int AS supabase_roles`
    expect(leftovers).toEqual({ auth_tables: 0, publications: 0, supabase_roles: 0 })

    const [kinds] = await raw`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'at_sessions_kind_check'`
    expect(kinds.def).toContain("'custodial'")
    expect(kinds.def).not.toContain('app-password')
  })

  test('inserting an account creates its profile', async () => {
    await rolledBack(raw, async (t) => {
      const suffix = randomUUID().slice(0, 8)
      const id = await insertAccount(t, suffix)
      const [profile] = await t`SELECT email, display_name FROM profiles WHERE id = ${id}`
      expect(profile).toEqual({ email: `tester-${suffix}@example.test`, display_name: `tester-${suffix}` })
    })
  })

  test('asAccount-style transaction makes auth.uid() the account', async () => {
    await rolledBack(raw, async (t) => {
      const id = await insertAccount(t)
      const [before] = await t`SELECT auth.uid() AS uid, current_user AS who`
      expect(before.uid).toBeNull()

      await t`SET LOCAL ROLE authenticated`
      await t`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: id, role: 'authenticated' })}, true)`
      const [after] = await t`SELECT auth.uid() AS uid, current_user AS who`
      expect(after).toEqual({ uid: id, who: 'authenticated' })

      // RLS applies now: the account sees its own row, and never wrapped_password.
      const own = await t`SELECT id FROM accounts`
      expect(own.map((r) => r.id)).toEqual([id])
      await expect(t`SELECT wrapped_password FROM accounts`).rejects.toMatchObject({ code: '42501' })
    })
    // After the transaction the setting is '' on this connection, not NULL.
    const [reset] = await raw`SELECT auth.uid() AS uid`
    expect(reset.uid).toBeNull()
  })

  test('participation rule fires for a signed-in account (vote on a completed gathering)', async () => {
    const [session] = await raw`
      SELECT s.id, s.event_id FROM sessions s JOIN events e ON e.id = s.event_id
      WHERE e.slug = 'past-gathering' LIMIT 1`
    test.skip(!session, 'seed not applied (ALLOW_SEED=true npm run db:seed)')

    const accountId = await raw.begin(async (t) => insertAccount(t))
    try {
      const error = await db
        .asAccount(accountId, async (t) => {
          await t`
            INSERT INTO votes (user_id, session_id, event_id, vote_count, credits_spent)
            VALUES (${accountId}, ${session.id}, ${session.event_id}, 1, 1)`
        })
        .then(() => null, (e: unknown) => e)
      expect(db.pgErrorCode(error)).toBe('23514')
      const response = db.dbErrorResponse(error)
      expect(response?.status).toBe(403)
      expect(await response?.json()).toEqual({ error: 'Voting is not open for this event', code: '23514' })
    } finally {
      await raw`DELETE FROM accounts WHERE id = ${accountId}`
    }
    const [gone] = await raw`SELECT count(*)::int AS n FROM profiles WHERE id = ${accountId}`
    expect(gone.n).toBe(0)
  })

  test('src/lib/db returns PostgREST-shaped values', async () => {
    const [row] = await db.sql`
      SELECT
        timestamptz '2026-09-29 09:00:00.123456-06' AS at,
        timestamp '2026-09-29 15:00:00' AS naive,
        date '2026-09-29' AS day,
        count(*) AS n,
        numeric '12.50' AS amount,
        '{"a": [1, 2]}'::jsonb AS doc,
        ${undefined as unknown as null}::text AS missing -- transform.undefined → null
      FROM generate_series(1, 3)`
    expect(row).toEqual({
      at: '2026-09-29T15:00:00.123Z',
      naive: '2026-09-29T15:00:00.000Z',
      day: '2026-09-29',
      n: 3,
      amount: 12.5,
      doc: { a: [1, 2] },
      missing: null,
    })

    // Dates and ISO strings round-trip as parameters.
    const [params] = await db.sql`
      SELECT ${new Date('2026-01-02T03:04:05.000Z')}::timestamptz AS from_date,
             ${'2026-01-02T03:04:05Z'}::timestamptz AS from_string,
             ${'2026-01-02'}::date AS day`
    expect(params).toEqual({ from_date: '2026-01-02T03:04:05.000Z', from_string: '2026-01-02T03:04:05.000Z', day: '2026-01-02' })

    const demo = db.one(await db.sql`SELECT slug, start_date, created_at FROM events WHERE slug = 'demo-gathering'`)
    if (demo) {
      expect(demo.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(demo.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
    expect(db.one([])).toBeNull()

    // Helpers reached through the lazy proxy: sql(array) for IN, sql.json for jsonb.
    const [helpers] = await db.sql`
      SELECT ${db.sql.json({ nested: { ok: true } })}::jsonb AS doc,
             (SELECT count(*) FROM events WHERE slug IN ${db.sql(['demo-gathering', 'past-gathering'])}) AS seeded`
    expect(helpers.doc).toEqual({ nested: { ok: true } })
    expect(typeof helpers.seeded).toBe('number')
  })

  test('dbErrorResponse maps unique and foreign-key violations', async () => {
    const accountId = randomUUID()
    const fk = await db
      .tx((t) => t`INSERT INTO profiles (id, email) VALUES (${accountId}, 'nobody@example.test')`)
      .then(() => null, (e: unknown) => e)
    expect(db.dbErrorResponse(fk)?.status).toBe(400)

    const dup = await db
      .tx((t) => t`INSERT INTO events (slug, name, start_date, end_date) VALUES ('demo-gathering', 'x', '2026-01-01', '2026-01-01')`)
      .then(() => null, (e: unknown) => e)
    const response = db.dbErrorResponse(dup)
    expect(response?.status).toBe(409)
    expect(await response?.json()).toEqual({ error: 'Already exists', code: '23505' })
    expect(db.dbErrorResponse(new Error('boom'))).toBeNull()
  })
})
