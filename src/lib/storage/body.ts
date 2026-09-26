/** Bound actual streamed bytes, including requests without Content-Length. */
export async function readUploadBody(request: Request, limit: number): Promise<FormData> {
  const type = request.headers.get('content-type') ?? ''
  const binary = type.split(';')[0].trim().toLowerCase() === 'application/octet-stream'
  if (!binary && !/^multipart\/form-data\s*;/i.test(type)) throw new Error('InvalidBody')
  const reader = request.body?.getReader()
  if (!reader) throw new Error('IncompleteUpload')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) { await reader.cancel(); throw new Error('TooLarge') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const declared = request.headers.get('content-length')
  if (declared && Number(declared) !== length) throw new Error('IncompleteUpload')
  if (!binary) return new Response(bytes, { headers: { 'Content-Type': type } }).formData()
  const form = new FormData()
  form.append('file', new Blob([bytes]), 'image')
  const query = new URL(request.url).searchParams
  for (const key of ['event', 'purpose']) {
    if (query.has(key)) form.set(key, query.get(key)!)
  }
  return form
}
