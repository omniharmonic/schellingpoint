/**
 * Unsubscribe (inventory P2-7).
 *
 *   POST /api/unsubscribe?t=<token>   RFC 8058 one-click, called by the mail client
 *   POST /api/unsubscribe             { token } — the /unsubscribe page's button
 *
 * The token is signed and names only an account and (optionally) a gathering. Redeeming
 * it turns `email_enabled` off for every notification category at that scope; in-app
 * notifications are untouched, and nothing else about the account can be reached.
 *
 * One-click is called by a mail provider from its own origin, so this route deliberately
 * does NOT require a same-origin header or a session — the signature is the credential,
 * and the only thing it can do is stop email.
 */
import { setPreferences } from '@/lib/notifications/preferences'
import { NOTIFICATION_CATEGORIES } from '@/lib/notifications/categories'
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe'
import { sql } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

async function tokenFrom(request: Request): Promise<string | null> {
  const fromQuery = new URL(request.url).searchParams.get('t')
  if (fromQuery) return fromQuery
  const type = request.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const body = (await request.json().catch(() => null)) as { token?: unknown } | null
    return typeof body?.token === 'string' ? body.token : null
  }
  if (type.includes('form')) {
    const form = await request.formData().catch(() => null)
    const value = form?.get('token')
    return typeof value === 'string' ? value : null
  }
  return null
}

export async function POST(request: Request): Promise<Response> {
  const scope = verifyUnsubscribeToken(await tokenFrom(request))
  // A bad token is answered the same way as a good one for a deleted account: this endpoint
  // never confirms that an address, an account or a gathering exists.
  if (!scope) return Response.json({ ok: true }, { headers: NO_STORE })

  const [account] = await sql<{ id: string }[]>`select id from accounts where id = ${scope.accountId}`
  if (!account) return Response.json({ ok: true }, { headers: NO_STORE })

  let eventId: string | null = null
  let eventName: string | null = null
  if (scope.eventId) {
    const [event] = await sql<{ id: string; name: string }[]>`select id, name from events where id = ${scope.eventId}`
    if (event) {
      eventId = event.id
      eventName = event.name
    }
  }

  try {
    await setPreferences(
      scope.accountId,
      eventId,
      NOTIFICATION_CATEGORIES.map((category) => ({ category, email_enabled: false })),
    )
  } catch (err) {
    console.error('[unsubscribe] could not save preferences:', err instanceof Error ? err.name : 'error')
    return Response.json({ error: 'Could not turn these emails off. Try again.' }, { status: 500, headers: NO_STORE })
  }
  return Response.json({ ok: true, scope: eventId ? 'event' : 'global', eventName }, { headers: NO_STORE })
}

/** GET is never an unsubscribe (a scanner must not be able to trigger one); it only reports. */
export async function GET(request: Request): Promise<Response> {
  const scope = verifyUnsubscribeToken(new URL(request.url).searchParams.get('t'))
  if (!scope) return Response.json({ valid: false }, { headers: NO_STORE })
  const [event] = scope.eventId
    ? await sql<{ name: string }[]>`select name from events where id = ${scope.eventId}`
    : []
  return Response.json({ valid: true, scope: scope.eventId ? 'event' : 'global', eventName: event?.name ?? null }, { headers: NO_STORE })
}
