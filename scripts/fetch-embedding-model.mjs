#!/usr/bin/env node
/**
 * Download the local embeddings model into the Transformers.js cache so the server never reaches
 * the Hugging Face hub at runtime (design §10.3; `EMBEDDINGS_PROVIDER=local` is the default).
 *
 *   node scripts/fetch-embedding-model.mjs                 # <repo>/.models, default model
 *   EMBEDDINGS_CACHE_DIR=/models node scripts/fetch-embedding-model.mjs
 *   EMBEDDINGS_MODEL=Xenova/bge-base-en-v1.5 node scripts/fetch-embedding-model.mjs
 *
 * The Dockerfile runs this at build time into /models and the runtime image starts with
 * EMBEDDINGS_CACHE_DIR=/models and EMBEDDINGS_OFFLINE=1, so a release carries its own weights.
 *
 * It loads the pipeline once and embeds a sentence, so a build fails here rather than the first
 * time an organizer presses "Embed now".
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5'
const model = process.env.EMBEDDINGS_MODEL?.trim() || DEFAULT_MODEL
const cacheDir = process.env.EMBEDDINGS_CACHE_DIR?.trim() || path.join(repoRoot, '.models')

async function directorySize(dir) {
  let total = 0
  for (const entry of await fs.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    total += (await fs.stat(path.join(entry.parentPath ?? entry.path, entry.name))).size
  }
  return total
}

const started = Date.now()
await fs.mkdir(cacheDir, { recursive: true })
console.log(`[fetch-embedding-model] ${model} → ${cacheDir}`)

const { env, pipeline } = await import('@huggingface/transformers')
env.cacheDir = cacheDir
env.localModelPath = cacheDir
env.allowLocalModels = true
env.allowRemoteModels = true // this script is the one place that may talk to the hub

const extract = await pipeline('feature-extraction', model, { dtype: 'q8' })
const output = await extract(['a smoke-test sentence'], { pooling: 'mean', normalize: true })
const [vector] = output.tolist()
const norm = Math.sqrt(vector.reduce((n, v) => n + v * v, 0))
if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-3) {
  throw new Error(`the model produced a vector of norm ${norm}; expected a unit vector`)
}

const bytes = await directorySize(cacheDir)
console.log(
  `[fetch-embedding-model] ok: ${vector.length} dims, cache ${(bytes / 1024 / 1024).toFixed(1)} MB, ` +
    `${((Date.now() - started) / 1000).toFixed(1)}s`,
)
process.exit(0)
