/**
 * GET /api/v1/invitations/[token] — what an invitation link is for (public: the token is the credential).
 *
 * Shows the event's name, dates and the offered role, and whether the link can still be used.
 * Never shows who sent it or who else was invited.
 */
import { sql } from '@/lib/db'
import { errorResponse, fail, json } from '@/lib/scheduling/admin-api'

export const dynamic = 'force-dynamic'

const TOKEN = /^[0-9a-f]{64}$/

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  if (!TOKEN.test(token)) return fail(404, 'Invalid invitation')
  try {
    const [row] = await sql<{
      email: string | null; role: string; expires_at: string; accepted_at: string | null; revoked_at: string | null
      max_uses: number | null; use_count: number; expired: boolean
      name: string; slug: string; description: string | null; start_date: string; end_date: string
    }[]>`
      select i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at, i.max_uses, i.use_count,
             i.expires_at <= now() as expired,
             e.name, e.slug, e.description, e.start_date, e.end_date
      from event_invitations i join events e on e.id = i.event_id
      where i.token = ${token}
    `
    if (!row) return fail(404, 'Invalid invitation')
    const isEmailInvite = Boolean(row.email)
    return json({
      event: { name: row.name, slug: row.slug, description: row.description, start_date: row.start_date, end_date: row.end_date },
      role: row.role,
      expires_at: row.expires_at,
      email_bound: isEmailInvite,
      is_expired: row.expired,
      is_used: isEmailInvite && Boolean(row.accepted_at),
      is_revoked: Boolean(row.revoked_at),
      max_uses: row.max_uses,
      use_count: row.use_count,
      exhausted: !isEmailInvite && row.max_uses !== null && row.use_count >= row.max_uses,
    })
  } catch (e) {
    return errorResponse(e, 'invitation info')
  }
}
