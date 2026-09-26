#!/usr/bin/env node
/**
 * Put MapLibre's worker where the browser can fetch it (`public/maplibre/`).
 *
 * MapLibre GL JS 6 no longer inlines its worker: `Map` starts one from a separate script whose
 * URL it derives from `import.meta.url`. Webpack rewrites `import.meta.url` to a `file://` path,
 * MapLibre's own resolver refuses anything that is not `http(s):` and returns an empty string,
 * and `new Worker('')` then loads *the current page* as the worker script. The worker dies
 * without an error event, so the style never finishes loading: the raster world outline (fetched
 * on the main thread) draws, vector tiles and glyphs — which the worker fetches — never do. That
 * is the "global map that will not zoom in" bug.
 *
 * So the two dist files are copied out of `node_modules` and served from our own origin, and
 * `src/components/map/MapCanvas.tsx` points `setWorkerUrl` at the copy. Both files are needed:
 * `maplibre-gl-worker.mjs` imports `./maplibre-gl-shared.mjs` relatively, so they must sit in
 * the same directory.
 *
 * Runs from `predev` and `prebuild`, and is idempotent (it skips a copy whose bytes already
 * match). `public/maplibre/` is generated, not committed.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const from = path.join(root, 'node_modules', 'maplibre-gl', 'dist')
const to = path.join(root, 'public', 'maplibre')

/** The worker entry plus the shared chunk it imports by relative path. */
const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function main() {
  await mkdir(to, { recursive: true })
  for (const name of FILES) {
    let source
    try {
      source = await readFile(path.join(from, name))
    } catch {
      console.error(
        `[maplibre] ${name} is not in node_modules/maplibre-gl/dist. Run npm install; the map cannot load vector tiles without it.`,
      )
      process.exitCode = 1
      return
    }
    const target = path.join(to, name)
    const current = await readFile(target).catch(() => null)
    if (current && digest(current) === digest(source)) continue
    await writeFile(target, source)
    console.log(`[maplibre] copied ${name} → public/maplibre/ (${(source.byteLength / 1024).toFixed(0)} KB)`)
  }
}

await main()
