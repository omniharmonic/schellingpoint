import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { sql, tx } from '@/lib/db'
import { pushConfig, validPushEndpoint, validPushKey } from '@/lib/notifications/push'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store' } })
export async function GET(request: Request) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const [row] = await sql`select 1 from push_subscriptions where user_id = ${viewer.accountId} and session_id = ${viewer.sessionId}`
  return json({ publicKey: pushConfig()?.publicKey ?? null, subscribed: !!row })
}
export async function POST(request: Request) {
  const bad = assertSameOrigin(request); if (bad) return bad
  const viewer = await requireViewer(request); if (viewer instanceof Response) return viewer
  if (!pushConfig()) return json({ error: 'Device notifications are not configured yet.' }, 503)
  const reader = request.body?.getReader()
  if (!reader) return json({ error: 'Invalid subscription.' }, 400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 4096) { await reader.cancel(); return json({ error: 'Subscription is too large.' }, 413) }
      chunks.push(value)
    }
  } catch { return json({ error: 'Invalid subscription.' }, 400) }
  finally { reader.releaseLock() }
  const text = Buffer.concat(chunks).toString('utf8')
  let body
  try { body = JSON.parse(text) } catch { return json({ error: 'Invalid subscription.' }, 400) }
  if (!validPushEndpoint(body?.endpoint) || !validPushKey(body?.keys?.p256dh, 65) || !validPushKey(body?.keys?.auth, 16)) return json({ error: 'This browser’s push subscription is not supported.' }, 400)
  const saved = await tx(async db => {
    await db`select pg_advisory_xact_lock(hashtextextended(${`push:${viewer.accountId}`}, 0))`
    const [count] = await db`select count(*)::int as n from push_subscriptions where user_id = ${viewer.accountId}`
    const [existing] = await db`select 1 from push_subscriptions where user_id = ${viewer.accountId} and endpoint = ${body.endpoint}`
    if (count.n >= 10 && !existing) return false
    const rows = await db`
      insert into push_subscriptions (user_id, session_id, endpoint, p256dh, auth)
      values (${viewer.accountId}, ${viewer.sessionId}, ${body.endpoint}, ${body.keys.p256dh}, ${body.keys.auth})
      on conflict (endpoint) do update set session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth
        where push_subscriptions.user_id = excluded.user_id
      returning id
    `
    return rows.length > 0
  })
  return saved ? json({ subscribed: true }) : json({ error: 'Could not register this device. Disable notifications on unused devices and retry.' }, 409)
}
export async function DELETE(request: Request) {
  const bad = assertSameOrigin(request); if (bad) return bad
  const viewer = await requireViewer(request); if (viewer instanceof Response) return viewer
  await sql`delete from push_subscriptions where user_id = ${viewer.accountId} and session_id = ${viewer.sessionId}`
  return json({ subscribed: false })
}
