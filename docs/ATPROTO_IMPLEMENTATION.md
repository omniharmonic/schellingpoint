# Schelling Point on ATProto — implementation (branch `atproto`)

Status: in progress, 2026-09-14. This document is the engineering companion to
`ATPROTO_MIGRATION_SPEC.md`. The spec describes the target; this file records
what is built, where, and where it deliberately deviates.

## 1. Shape of the implementation

The spec assumes Free School's stack: a Hono AppView, a self-hosted PDS,
contrail indexing, pg-boss jobs, subdomain routing behind Caddy. Schelling Point
already has a working Next.js 15 + Supabase application on Vercel with a full
organizer and attendee surface. Rebuilding that surface in a second app before
any record reaches the network would delay interoperability by months and leave
two half-products. So the ATProto layer is built **inside the existing app**,
following the spec's record design and privacy rules exactly, and its
architecture rules where they are portable:

| Spec element | Here |
|---|---|
| AppView (Hono) | Next.js route handlers under `src/app/api/atproto/*`, `src/app/oauth/*`, plus `src/lib/atproto/*` |
| Own PDS on a neutral hostname | **Not hosted.** People sign in with any ATProto account (bsky.social or elsewhere). The gathering actor is any ATProto account the organizer links — an existing bsky.social account, or one on a PDS they run. Because bsky.social repos are crawled by the relay, every record written there reaches the firehose without us running a PDS. Hosting a shared PDS remains the documented Phase-2 seam (`docs/ATPROTO_MIGRATION_SPEC.md` §12). |
| Custodial "Door 1" (email → custodial DID) | **Not built.** Email sign-in stays Supabase auth; a DID is linked optionally. Nobody is forced onto the network. |
| OAuth "Door 2" | Built. Server-side confidential client (`@atproto/oauth-client-node`, DPoP, `private_key_jwt`) on the apex; loopback client in local development. |
| Session cookie | `sp_at_session` HttpOnly cookie for the ATProto identity; the existing Supabase session is bridged so every current page and REST call keeps working. |
| `SchoolActorPort` | `GatheringActorPort` (`src/lib/atproto/actor.ts`): every write as the gathering goes through one function with role authorization and an `at_audit` row. |
| Credentials in `fs_school_credential` | `at_credentials`: an OAuth session (the organizer linked the gathering account with OAuth) or an app password wrapped with AES-256-GCM under `ATPROTO_CUSTODY_KEY`. |
| contrail + `subscribeRepos` per peer | A Jetstream consumer (`scripts/atproto-indexer.ts`) for live ingest with `wantedCollections`, plus a cron-driven reconciliation route (`/api/atproto/sync`) that `listRecords` every known repo. Vercel functions cannot hold a socket forever; the reconciliation path keeps the index correct when the consumer is not running. |
| `sp_*` app-side tables | Existing tables (votes, tickets, RSVPs, members, notifications) stay app-side, exactly as the spec's publication matrix requires. New `at_*` tables hold OAuth state, sessions, credentials, audit, cursor, indexed records. |
| Subdomain per gathering | Not changed; `/e/[slug]` routing stays. The gathering's public identity on the network is its DID and handle, not its URL. |
| Ballot-key vote unlinkability (§5.2–5.4) | Not rebuilt in this pass. Votes remain private rows (RLS: voter-only) with server-enforced budgets from `20260914000002`. The public artifact is the k-suppressed `schellingpoint.draft.tally`, written only after voting closes, exactly as §5.5–5.6 specify. The ledger-collapse design is a follow-up. |

Everything the spec says about **what may be a public record and who writes
it** is implemented as written: proposals live in the proposer's repo; the
gathering, its calendar event, venues, tracks, slot grids, slots, scheduled
session calendar events, event configs and tallies live in the gathering's repo;
co-host and endorsement records live in the co-host's or endorser's own repo;
RSVPs are app-side unless the attendee opts in; nothing public ever names a DID
its holder did not write.

## 2. Records

Lexicons are in `lexicons/` (`schellingpoint/draft/*.json` ours, CC0;
`vendor/` borrowed and never modified). `npm run lexicons:validate` checks
them. Record builders are pure functions in `src/lib/atproto/records.ts` and
are unit-tested to be lexicon-valid.

| Record | Repo | rkey | Written when |
|---|---|---|---|
| `schellingpoint.draft.gathering` | gathering | `self` | organizer links the actor / republishes |
| `community.lexicon.calendar.event` (the gathering) | gathering | `deterministicRkey('gathering', event.id)` | same |
| `freeschool.draft.policy` | gathering | `deterministicRkey('policy', event.id, version)` | same; re-written when voting/proposal rules change |
| `schellingpoint.draft.venue` / `.track` | gathering | `deterministicRkey('venue'|'track', row.id)` | publish / on change |
| `schellingpoint.draft.slotGrid` | gathering | `deterministicRkey('slotgrid', event.id, venue.id, day)` | publish |
| `schellingpoint.draft.proposal` | **proposer** | TID (stored in `sessions.proposal_uri`) | proposer has a linked DID and `publish_proposals` on; or clicks "Publish to my repo" |
| `schellingpoint.draft.cohost` | **co-host** | TID | co-host with a linked DID accepts an invite |
| `community.lexicon.calendar.event` (a session) + `coop.lexicon.event.config` + `schellingpoint.draft.slot` | gathering | `deterministicRkey('session'|'config'|'slot', session.id)` | schedule published; updated on move; `status: cancelled` on cancel |
| `schellingpoint.draft.tally` | gathering | `deterministicRkey('tally', event.id, round)` | voting closes (status leaves `voting_open`) |
| `schellingpoint.draft.endorsement` | **participant** | TID | participant clicks "Endorse publicly" |
| `community.lexicon.calendar.rsvp` | **attendee** | TID | attendee opts in on a scheduled session |

Deterministic rkeys make every gathering-side publish idempotent: re-running
"publish schedule" rewrites the same records (with `swapRecord` CAS) instead of
duplicating them.

## 3. Identity

- **Sign in with Bluesky**: `/login` → `GET /api/atproto/auth/start?handle=…&next=…` → PDS consent → `GET /oauth/callback`. The callback creates/loads the `at_sessions` row, sets `sp_at_session`, ensures a Supabase auth user exists for the DID (`<did-with-dashes>@atproto.schellingpoint.app`, email confirmed, never mailed), links `profiles.did`/`atproto_handle`, imports display name/avatar from the Bluesky profile on first sign-in (never overwriting edits), then mints a Supabase session server-side (`generateLink` → `verifyOtp`) and redirects to `/auth/callback#access_token=…` — the same implicit-flow landing the magic link uses, so the rest of the app is unchanged.
- **Link a DID to an existing account**: from profile settings, the same start route with `link=1`; the callback attaches the DID to the signed-in Supabase user instead of creating one.
- **Gathering actor**: `/e/[slug]/admin/atproto` — "Connect a gathering account" runs the same OAuth flow with `purpose=gathering&event=<id>`; the callback stores the OAuth session under the gathering DID and an `at_credentials(kind='oauth')` row, sets `events.actor_did`. Alternative: paste the account's handle + app password (stored wrapped).
- OAuth scope is `atproto transition:generic` so the app can write records in the user's repo. The consent screen names the app; the user can revoke from their PDS at any time.

## 4. Indexing

- `scripts/atproto-indexer.ts` — Jetstream WebSocket consumer with `wantedCollections` = our ten NSIDs + `community.lexicon.calendar.event` + `.rsvp` + `coop.lexicon.event.config` (Jetstream filters server-side; the cursor is persisted in `at_sync_cursor`). Every commit upserts `at_records`; proposals whose `gathering` URI matches one of our events become `sessions` rows (`imported_from='atproto'`, `host_did` set, status `pending`) so proposals written by any ATProto client land in the organizer's review queue.
- `GET /api/atproto/sync` (cron in `vercel.json`, hourly; `CRON_SECRET`) — reconciliation: for every gathering actor DID and every linked profile DID, `listRecords` for each of our collections and upsert. This is the at-least-once safety net and the only path when the WebSocket consumer is not deployed.

## 5. Environment

See `.env.example`. Required for ATProto features: `NEXT_PUBLIC_APP_URL`
(https in production), `ATPROTO_SESSION_SECRET`, `ATPROTO_CUSTODY_KEY` (32
random bytes as hex). Optional: `ATPROTO_OAUTH_PRIVATE_JWK` (else generated once
and stored in `at_oauth_client_key`), `ATPROTO_JETSTREAM_URL`,
`ATPROTO_DEFAULT_PDS_URL`. In local development the OAuth client runs in
loopback mode (`http://localhost` client id) which bsky.social accepts; the
callback is `http://127.0.0.1:3001/oauth/callback`.

## 6. Verification

- `npm run lexicons:validate`, `npm run typecheck`, `npm test` (includes
  `tests/atproto-records.spec.ts`), `npm run test:sql`.
- Privacy audit: `scripts/atproto-privacy-audit.ts` walks every record in
  `at_records` written by a gathering actor and fails if it contains a DID other
  than its author's (allowed exceptions listed in `records.ts`), and checks that
  `sessions.host_name` never appears in a public record.
- Manual: link a bsky.social account, connect a gathering account, publish, and
  open the records in a generic client (e.g. `https://pdsls.dev/at://<did>`).
