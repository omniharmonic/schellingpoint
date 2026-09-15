import { NextResponse } from 'next/server'
import { sql, tx } from '@/lib/db'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { normalizeEnsName } from '../../profile/validate'
import { EnsResolutionError, ensRpcUrls, isSignatureHex, recoverPersonalSignAddress, resolveEnsAddress } from '../ens'

/**
 * Finish ENS verification (spec §7).
 *
 *   POST /api/me/ens/verify { name, signature } → { ens, ens_verified_at }
 *
 * Checks, in order: an unexpired challenge for this account and this name; a well-formed 65-byte
 * signature; the signer recovered from the challenge message; the name's current ENS address.
 * On a match the name is stored as the account's verified `ens`. The challenge is consumed by any
 * definite verdict (match or mismatch) and kept only when Ethereum could not be reached.
 * The address itself is not stored.
 */
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

const reply = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status, headers: NO_STORE })

export async function POST(request: Request) {
  const refused = assertSameOrigin(request)
  if (refused) return refused
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  const body = (await request.json().catch(() => null)) as { name?: unknown; signature?: unknown } | null
  const parsed = normalizeEnsName(body?.name)
  if (!parsed.ok || !parsed.value) return reply(400, parsed.ok ? 'ENS name is required' : parsed.error, { field: 'name' })
  const name = parsed.value

  const [challenge] = await sql<{ name: string; message: string; expires_at: string }[]>`
    select name, message, expires_at from ens_challenges where account_id = ${viewer.accountId}
  `
  if (!challenge || new Date(challenge.expires_at).getTime() <= Date.now()) {
    return reply(400, 'No active verification request. Start again.', { code: 'challenge_missing' })
  }
  if (challenge.name !== name) {
    return reply(400, 'This signature request was for a different name. Start again.', { code: 'challenge_name_mismatch', field: 'name' })
  }

  const consume = () => sql`delete from ens_challenges where account_id = ${viewer.accountId}`

  if (!isSignatureHex(body?.signature)) {
    return reply(400, 'Signature must be a 65-byte hex string', { code: 'bad_signature', field: 'signature' })
  }
  const signer = recoverPersonalSignAddress(challenge.message, body.signature)
  if (!signer) {
    await consume()
    return reply(400, 'That signature is not valid', { code: 'bad_signature', field: 'signature' })
  }

  let resolved: string
  try {
    resolved = await resolveEnsAddress(name, { rpcUrls: ensRpcUrls() })
  } catch (e) {
    if (e instanceof EnsResolutionError && e.kind !== 'unavailable') {
      await consume()
      return reply(400, e.message, { code: e.kind, field: 'name' })
    }
    console.error('[ens] resolution failed:', e instanceof Error ? e.message : e)
    return reply(503, 'Could not reach Ethereum to resolve that name. Try again shortly.', { code: 'unavailable' })
  }

  if (resolved !== signer) {
    await consume()
    return reply(400, `The signature was not made by the address ${name} resolves to`, { code: 'signer_mismatch', field: 'signature' })
  }

  const [row] = await tx(async (t) => {
    await t`delete from ens_challenges where account_id = ${viewer.accountId}`
    return t<{ ens: string; ens_verified_at: string }[]>`
      update profiles set ens = ${name}, ens_verified_at = now()
      where id = ${viewer.accountId}
      returning ens, ens_verified_at
    `
  })
  if (!row) return reply(404, 'Profile not found')
  return NextResponse.json(row, { headers: NO_STORE })
}
