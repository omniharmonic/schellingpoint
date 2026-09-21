/**
 * Chunking for the corpus export and embeddings (design §10.2): ~800 tokens (≈ 3,200 chars) on
 * paragraph boundaries with 15% overlap. Deterministic: the same paragraphs always produce the
 * same chunks, so re-chunking a transcript is idempotent.
 */
import { MARKER_RE } from './normalize'

export const CHUNK_TARGET_CHARS = 3200
export const CHUNK_OVERLAP_RATIO = 0.15

export interface TranscriptChunk {
  index: number
  text: string
  /** The first `[mm:ss]` marker in the chunk, when the transcript carries any. */
  marker: string | null
}

export interface ChunkOptions {
  targetChars?: number
  overlapRatio?: number
}

export function firstMarker(text: string): string | null {
  return MARKER_RE.exec(text)?.[0] ?? null
}

/** Split a paragraph longer than `target` on sentence ends (hard split as a last resort). */
function splitLong(paragraph: string, target: number): string[] {
  if (paragraph.length <= target) return [paragraph]
  const pieces: string[] = []
  const sentences = paragraph.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [paragraph]
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > target) {
      if (current.trim()) pieces.push(current.trim())
      current = ''
      for (let i = 0; i < sentence.length; i += target) pieces.push(sentence.slice(i, i + target).trim())
      continue
    }
    if (current.length + sentence.length > target && current.trim()) {
      pieces.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim()) pieces.push(current.trim())
  return pieces.filter(Boolean)
}

export function chunkParagraphs(paragraphs: readonly string[], options: ChunkOptions = {}): TranscriptChunk[] {
  const target = options.targetChars ?? CHUNK_TARGET_CHARS
  const overlapChars = Math.floor(target * (options.overlapRatio ?? CHUNK_OVERLAP_RATIO))
  const units = paragraphs.flatMap((p) => splitLong(p.trim(), target)).filter(Boolean)

  const chunks: TranscriptChunk[] = []
  let current: string[] = []
  let fresh = 0 // paragraphs in `current` that did not come from the previous chunk's overlap

  const size = (list: string[]) => list.reduce((n, p) => n + p.length, 0) + Math.max(0, list.length - 1) * 2

  const flush = () => {
    if (!fresh) return
    const text = current.join('\n\n')
    chunks.push({ index: chunks.length, text, marker: firstMarker(text) })
    // Carry trailing paragraphs into the next chunk, up to the overlap budget.
    const carry: string[] = []
    for (let i = current.length - 1; i >= 0; i--) {
      if (size([current[i], ...carry]) > overlapChars) break
      carry.unshift(current[i])
    }
    // The budget carried nothing (long paragraphs): still overlap by the last paragraph when it
    // is small enough not to dominate the next chunk.
    if (!carry.length && current.length > 1 && current[current.length - 1].length <= target * 0.4) carry.push(current[current.length - 1])
    // Never carry the whole chunk (a chunk made only of overlap would repeat forever).
    current = carry.length < current.length ? carry : []
    fresh = 0
  }

  for (const unit of units) {
    if (fresh > 0 && size([...current, unit]) > target) flush()
    current.push(unit)
    fresh += 1
  }
  flush()
  return chunks
}
