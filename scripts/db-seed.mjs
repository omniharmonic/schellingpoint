#!/usr/bin/env node
// Applies db/seeds/*.sql in lexical order, each in its own transaction.
// Refuses to run unless ALLOW_SEED=true, so it can never touch production by accident.
//
//   DATABASE_URL     owner connection (DATABASE_MIGRATION_URL takes precedence)
//   ALLOW_SEED=true  required
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

if (process.env.ALLOW_SEED !== 'true') {
  console.error('db:seed: refusing to seed without ALLOW_SEED=true')
  process.exit(1)
}
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL
if (!url) {
  console.error('db:seed: DATABASE_URL (or DATABASE_MIGRATION_URL) is required')
  process.exit(1)
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const seedsDir = path.join(root, 'db', 'seeds')
const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 })

try {
  const files = (await readdir(seedsDir)).filter((f) => f.endsWith('.sql')).sort()
  for (const file of files) {
    const text = await readFile(path.join(seedsDir, file), 'utf8')
    const started = Date.now()
    await sql.begin((tx) => tx.unsafe(text))
    console.log(`seed   ${file} (${Date.now() - started} ms)`)
  }
  await sql.end({ timeout: 5 })
} catch (err) {
  console.error(`db:seed failed: ${err?.message ?? err}`)
  await sql.end({ timeout: 1 }).catch(() => {})
  process.exit(1)
}
