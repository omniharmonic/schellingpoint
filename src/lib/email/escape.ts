/**
 * Escaping for values interpolated into email HTML. Everything a person typed (session
 * titles, names, reasons, event names) is text, never markup.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

/** Plain text → HTML paragraphs (escaped, newlines kept). */
export function textToHtml(value: string): string {
  return value
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin: 0 0 16px 0;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** A URL safe to put in an href: http(s) only, attribute-escaped; otherwise null. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return escapeHtml(parsed.toString())
  } catch {
    return null
  }
}

/** A CSS hex colour, or the fallback. */
export function safeHexColor(value: string | null | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) ? value : fallback
}
