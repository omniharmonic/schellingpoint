/**
 * `/api/me/delete` — the person's own account.
 *
 *   GET   → what deleting would mean: the PDS outcome for this kind of account, and any
 *           gathering they must hand over first. Read-only; nothing is deleted by asking.
 *   POST  { confirm: '<their handle>' } → delete.
 *           409 { code: 'LastOwner', gatherings } while they are the only owner of a live one
 *           400 when the typed handle does not match
 *
 * Deletion is irreversible and the copy says so before the confirm, not after.
 */
import { NextResponse } from 'next/server'
import { assertSameOrigin, requireViewer } from '@/lib/auth/viewer'
import { sql } from '@/lib/db'
import { blockingOwnerships, deleteAccount, PDS_OUTCOME_SENTENCE, type PdsOutcome } from '@/lib/account/delete'
import { clearSessionCookieHeaders } from '@/lib/atproto/session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'private, no-store' }

/** What will happen to the network identity, before anything happens to it. */
async function plannedPdsOutcome(accountId: string): Promise<PdsOutcome> {
  const [row] = await sql<{ kind: string; owned_at: string | null }[]>`
    select kind, owned_at from accounts where id = ${accountId}
  `
  if (!row) return 'none'
  if (row.kind !== 'custodial') return 'not-ours'
  return row.owned_at ? 'owned-by-you' : 'deactivated'
}

export async function GET(request: Request) {
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer
  const [gatherings, pds] = await Promise.all([blockingOwnerships(viewer.accountId), plannedPdsOutcome(viewer.accountId)])
  return NextResponse.json(
    {
      handle: viewer.handle,
      did: viewer.did,
      kind: viewer.kind,
      blockingGatherings: gatherings,
      pds,
      pdsSentence: PDS_OUTCOME_SENTENCE[pds],
    },
    { headers: NO_STORE },
  )
}

export async function POST(request: Request) {
  const bad = assertSameOrigin(request)
  if (bad) return bad
  const viewer = await requireViewer(request)
  if (viewer instanceof Response) return viewer

  let body: Record<string, unknown> = {}
  try {
    const raw = await request.text()
    if (raw) body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
  }

  // Typing the handle is the confirmation: a person who cannot name the identity they are
  // deleting is not the person who meant to delete it.
  const typed = typeof body.confirm === 'string' ? body.confirm.trim().replace(/^@/, '').toLowerCase() : ''
  const expected = (viewer.handle ?? viewer.did).toLowerCase()
  if (!typed || typed !== expected) {
    return NextResponse.json(
      { error: `Type ${viewer.handle ?? viewer.did} to confirm.`, code: 'ConfirmMismatch' },
      { status: 400, headers: NO_STORE },
    )
  }

  const result = await deleteAccount(viewer.accountId)
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.gatherings.length
          ? 'You are the only owner of a gathering that is still running. Make someone else an owner first, then delete your account.'
          : 'No account for this session.',
        code: 'LastOwner',
        gatherings: result.gatherings,
      },
      { status: result.gatherings.length ? 409 : 404, headers: NO_STORE },
    )
  }

  // The session row is already gone with the account; clear the cookie so the browser stops
  // presenting a credential that resolves to nothing.
  const headers = new Headers(NO_STORE)
  for (const cookie of clearSessionCookieHeaders()) headers.append('set-cookie', cookie)
  return NextResponse.json(
    {
      deleted: true,
      removed: result.removed,
      anonymised: result.anonymised,
      pds: result.pds,
      pdsSentence: PDS_OUTCOME_SENTENCE[result.pds],
    },
    { headers },
  )
}
