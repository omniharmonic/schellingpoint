/**
 * Loads every lexicon JSON under `lexicons/` (ours, vendored, and the strongRef
 * shim) into one `@atproto/lexicon` `Lexicons` instance and exits non-zero if
 * any document fails to parse or any cross-document `ref` is unresolvable.
 *
 * Mirrors Free School's `packages/lexicons/scripts/validate.mjs`, widened to
 * the vendored borrowed lexicons because every `schellingpoint.draft.*`
 * record that strongRefs one must validate against it.
 *
 *   npm run lexicons:validate
 */
import { Lexicons } from '@atproto/lexicon'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../lexicons/', import.meta.url))

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.json')) out.push(p)
  }
  return out
}

let failed = 0
const docs = []
for (const file of walk(root).sort()) {
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    if (doc.lexicon !== 1 || typeof doc.id !== 'string' || !doc.defs) {
      throw new Error('not a lexicon document (needs lexicon: 1, id, defs)')
    }
    docs.push({ file, doc })
  } catch (e) {
    failed++
    console.log('FAIL', file.slice(root.length), '-', e.message)
  }
}

let lex
try {
  lex = new Lexicons(docs.map((d) => d.doc))
} catch (e) {
  failed++
  console.log('FAIL', 'Lexicons()', '-', e.message)
}

if (lex) {
  for (const { file, doc } of docs) {
    try {
      // Re-adding the parsed schema is what actually runs the structural checks
      // (unknown types, malformed defs). Resolve every `ref` so a typo in a
      // cross-document reference fails here rather than at first write.
      for (const [defName, def] of Object.entries(doc.defs)) {
        const uri = `${doc.id}#${defName}`
        if (!lex.getDef(uri)) throw new Error(`def ${uri} did not register`)
      }
      for (const ref of collectRefs(doc.defs)) {
        const uri = ref.startsWith('#') ? `${doc.id}${ref}` : ref
        if (!lex.getDef(uri)) throw new Error(`unresolvable ref ${ref}`)
      }
      console.log('OK  ', doc.id.padEnd(44), file.slice(root.length))
    } catch (e) {
      failed++
      console.log('FAIL', doc.id, '-', e.message)
    }
  }
}

function collectRefs(node, acc = []) {
  if (Array.isArray(node)) node.forEach((n) => collectRefs(n, acc))
  else if (node && typeof node === 'object') {
    if (typeof node.ref === 'string') acc.push(node.ref)
    if (Array.isArray(node.refs)) acc.push(...node.refs.filter((r) => typeof r === 'string'))
    for (const v of Object.values(node)) collectRefs(v, acc)
  }
  return acc
}

console.log(failed ? `${failed} failure(s)` : `all ${docs.length} lexicons valid`)
process.exit(failed ? 1 : 0)
