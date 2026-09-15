import { NextResponse } from 'next/server'

/**
 * The shared-key profile read API is gone. It exposed ENS, Telegram and `is_admin` for every
 * profile (spec §2: "that endpoint does not survive"). Profiles are app-side and members-only
 * (§10).
 *
 * What is public instead: a person's own records (proposals, co-host and endorsement records,
 * opt-in RSVPs) in their own repo on the network, and each gathering's published schedule at
 * GET /api/v1/schedule?event=<slug>, which names a host only by the DID that wrote the proposal.
 */
const BODY = {
  error: {
    code: 'GONE',
    message:
      'The profiles API has been removed. Profiles are visible only to fellow members of a gathering. ' +
      "Public data: each person's own ATProto records in their repo, and GET /api/v1/schedule?event=<slug>.",
  },
  replacement: {
    schedule: '/api/v1/schedule?event=<slug>',
    records: 'at://<did>/schellingpoint.draft.proposal',
  },
}

export function gone(): NextResponse {
  return NextResponse.json(BODY, { status: 410, headers: { 'Cache-Control': 'public, max-age=3600' } })
}
