import 'server-only'
/**
 * Transactional mail for the identity flows (magic links, reveal links).
 *
 * Resend when `RESEND_API_KEY` is set. Without it, development logs a redacted line and
 * the first URL of the body (so the link can be followed locally) and reports
 * `{ delivered: false }`; production refuses to pretend and throws.
 */
import { Resend } from 'resend'

export const DEFAULT_MAIL_FROM = 'Unconference <hello@unconference.events>'

export class MailNotConfiguredError extends Error {
  constructor() {
    super('RESEND_API_KEY is not set; refusing to drop mail in production')
    this.name = 'MailNotConfiguredError'
  }
}

let client: Resend | undefined

export async function sendMail(input: {
  to: string
  subject: string
  text: string
  html?: string
  /** Extra SMTP headers — RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post`. */
  headers?: Record<string, string>
}): Promise<{ delivered: boolean }> {
  const key = process.env.RESEND_API_KEY?.trim()
  if (!key) {
    if (process.env.NODE_ENV === 'production') throw new MailNotConfiguredError()
    const url = input.text.match(/https?:\/\/\S+/)?.[0]
    console.info(`[mail:dev] to=<redacted> subject=${JSON.stringify(input.subject)}${url ? ` url=${url}` : ''}`)
    return { delivered: false }
  }
  client ??= new Resend(key)
  const from = process.env.MAIL_FROM?.trim() || DEFAULT_MAIL_FROM
  const { error } = await client.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    ...(input.html ? { html: input.html } : {}),
    ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
  })
  if (error) throw new Error(`mail send failed: ${error.name ?? 'error'}`)
  return { delivered: true }
}
