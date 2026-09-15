/**
 * Admin ticketing settings (owner or admin).
 *
 *   GET  → { ticketing_enabled, stripe_account_id, platform_stripe_configured, webhook_configured }
 *   POST { ticketing_enabled?: boolean, stripe_account_id?: string | null } → same shape
 */
import { assertSameOrigin, requireEventRole } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { jsonError, TICKET_ADMIN_ROLES } from '@/lib/tickets'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function settingsBody(row: { ticketing_enabled: boolean; stripe_account_id: string | null }) {
  return {
    ticketing_enabled: row.ticketing_enabled,
    stripe_account_id: row.stripe_account_id,
    platform_stripe_configured: Boolean(process.env.STRIPE_SECRET_KEY),
    webhook_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth
  const [row] = await sql<{ ticketing_enabled: boolean; stripe_account_id: string | null }[]>`
    select ticketing_enabled, stripe_account_id from events where id = ${auth.event.id}
  `
  return Response.json(settingsBody(row), { headers: NO_STORE })
}

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const crossOrigin = assertSameOrigin(request)
  if (crossOrigin) return crossOrigin
  const { slug } = await params
  const auth = await requireEventRole(request, slug, TICKET_ADMIN_ROLES)
  if (auth instanceof Response) return auth

  let body: { ticketing_enabled?: unknown; stripe_account_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return jsonError(400, 'Invalid JSON body')
  }

  const setEnabled = typeof body.ticketing_enabled === 'boolean'
  const setAccount = body.stripe_account_id !== undefined
  if (setAccount && body.stripe_account_id !== null) {
    if (typeof body.stripe_account_id !== 'string' || !/^acct_[A-Za-z0-9]{6,64}$/.test(body.stripe_account_id)) {
      return jsonError(400, "stripe_account_id must look like 'acct_…'", { field: 'stripe_account_id' })
    }
  }
  if (!setEnabled && !setAccount) return jsonError(400, 'No updates provided')

  const enabled = setEnabled ? (body.ticketing_enabled as boolean) : null
  const account = setAccount ? ((body.stripe_account_id as string | null) ?? null) : null
  const [row] = await sql<{ ticketing_enabled: boolean; stripe_account_id: string | null }[]>`
    update events
    set ticketing_enabled = ${setEnabled ? sql`${enabled}` : sql`ticketing_enabled`},
        stripe_account_id = ${setAccount ? sql`${account}` : sql`stripe_account_id`},
        updated_at = now()
    where id = ${auth.event.id}
    returning ticketing_enabled, stripe_account_id
  `
  return Response.json(settingsBody(row), { headers: NO_STORE })
}
