import { randomBytes } from 'node:crypto'
import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { publicUrl } from '@/lib/atproto/config'
import { normalizeEnsName } from '../../profile/validate'
import { ensChallengeMessage } from '../ens'

/**
 * Start ENS verification (spec §7).
 *
 *   POST /api/me/ens/challenge { name } → { name, nonce, message, expiresAt }
 *
 * The wallet the name resolves to signs `message` with `personal_sign`, then the client calls
 * POST /api/me/ens/verify. One outstanding challenge per account; a new one replaces the old.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }
const TTL_MS = 10 * 60 * 1000

function appHost(): string {
  try {
    return new URL(publicUrl()).host
  } catch {
    return 'this app'
  }
}

export async function POST(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const body = (await request.json().catch(() => null)) as { name?: unknown } | null
  const parsed = normalizeEnsName(body?.name)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, field: 'name' }, { status: 400, headers: NO_STORE })
  if (!parsed.value) return NextResponse.json({ error: 'ENS name is required', field: 'name' }, { status: 400, headers: NO_STORE })

  const name = parsed.value
  const nonce = randomBytes(16).toString('hex')
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString()
  const message = ensChallengeMessage({ host: appHost(), name, did: viewer.did, nonce, expiresAt })

  await sql`
    insert into ens_challenges (account_id, name, nonce, message, expires_at)
    values (${viewer.accountId}, ${name}, ${nonce}, ${message}, ${expiresAt})
    on conflict (account_id) do update
      set name = excluded.name, nonce = excluded.nonce, message = excluded.message,
          expires_at = excluded.expires_at, created_at = now()
  `
  return NextResponse.json({ name, nonce, message, expiresAt }, { headers: NO_STORE })
}
