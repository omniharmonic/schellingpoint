#!/usr/bin/env node
// Applies db/migrations/*.sql in lexical order, one transaction per file, and
// records each in public.app_migrations. Then (optionally) provisions the
// application login role.
//
//   DATABASE_URL     owner/superuser connection used for DDL (required;
//                    DATABASE_MIGRATION_URL takes precedence when both are set)
//   APP_DB_USER      application login role to ensure (optional)
//   APP_DB_PASSWORD  its password (required with APP_DB_USER)
//
// Usage: node scripts/db-migrate.mjs   (npm run db:migrate)
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationsDir = path.join(root, 'db', 'migrations')

const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL
if (!url) {
  console.error('db:migrate: DATABASE_URL (or DATABASE_MIGRATION_URL) is required')
  process.exit(1)
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/

const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 })

function versionOf(file) {
  // 0001_baseline.sql → version "0001", name "baseline"
  const m = /^(\d+)_(.+)\.sql$/.exec(file)
  if (!m) throw new Error(`Migration file name must look like NNNN_name.sql: ${file}`)
  return { version: m[1], name: m[2] }
}

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS public.app_migrations (
      version text PRIMARY KEY,
      name text,
      applied_at timestamptz DEFAULT now()
    )`

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  const applied = new Set((await sql`SELECT version FROM public.app_migrations`).map((r) => r.version))

  let count = 0
  for (const file of files) {
    const { version, name } = versionOf(file)
    if (applied.has(version)) {
      console.log(`skip   ${file} (already applied)`)
      continue
    }
    const text = await readFile(path.join(migrationsDir, file), 'utf8')
    const started = Date.now()
    await sql.begin(async (tx) => {
      // Serialize concurrent migrators; released at commit.
      await tx`SELECT pg_advisory_xact_lock(hashtext('app_migrations'))`
      const [already] = await tx`SELECT 1 FROM public.app_migrations WHERE version = ${version}`
      if (already) return
      await tx.unsafe(text)
      await tx`INSERT INTO public.app_migrations (version, name) VALUES (${version}, ${name})`
    })
    count++
    console.log(`apply  ${file} (${Date.now() - started} ms)`)
  }
  console.log(`db:migrate: ${count} applied, ${files.length - count} already up to date`)
}

async function ensureAppRole() {
  const user = process.env.APP_DB_USER
  const password = process.env.APP_DB_PASSWORD
  if (!user) return
  if (!password) throw new Error('APP_DB_PASSWORD is required when APP_DB_USER is set')
  if (!IDENT.test(user)) throw new Error(`APP_DB_USER must be a lowercase SQL identifier, got "${user}"`)

  const [{ db }] = await sql`SELECT current_database() AS db`
  const [exists] = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${user}`
  // Role names are validated above; passwords go through quote_literal-equivalent escaping.
  const pw = `'${password.replaceAll("'", "''")}'`
  if (!exists) {
    await sql.unsafe(`CREATE ROLE ${user} LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD ${pw}`)
  } else {
    await sql.unsafe(`ALTER ROLE ${user} LOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD ${pw}`)
  }
  const statements = [
    `GRANT authenticated, anon TO ${user}`,
    `GRANT CONNECT ON DATABASE "${db.replaceAll('"', '""')}" TO ${user}`,
    `GRANT USAGE ON SCHEMA public, auth, extensions TO ${user}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${user}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${user}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${user}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO ${user}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA extensions TO ${user}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${user}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${user}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${user}`,
  ]
  await sql.begin(async (tx) => {
    for (const s of statements) await tx.unsafe(s)
  })
  console.log(`role   ${user} ${exists ? 'updated' : 'created'} (LOGIN BYPASSRLS NOSUPERUSER, member of authenticated, anon)`)
}

try {
  await migrate()
  await ensureAppRole()
  await sql.end({ timeout: 5 })
} catch (err) {
  console.error(`db:migrate failed: ${err?.message ?? err}`)
  if (err?.position && err?.query) {
    const before = err.query.slice(0, Number(err.position))
    console.error(`  at line ${before.split('\n').length} of the failing migration`)
  }
  await sql.end({ timeout: 1 }).catch(() => {})
  process.exit(1)
}
