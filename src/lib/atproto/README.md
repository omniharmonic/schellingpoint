# `src/lib/atproto`

The ATProto foundation for Schelling Point: lexicons, record builders, identity,
OAuth, custody, the gathering-actor port and a public record index. Design source:
`docs/ATPROTO_MIGRATION_SPEC.md` (§3–§5, §8). Reference implementation: Free School.

Two rules bind everything here:

- **R9** — no public record may name a DID its holder did not write. Enforced by
  `assertNoForeignDid` (`records.ts`) and by the actor port before every write.
- **Sidecar** — never add a field to a borrowed lexicon. `buildSessionCalendarEvent`
  emits only what `community.lexicon.calendar.event` defines; everything else rides in
  `schellingpoint.draft.*` sidecars that strongRef it. `assertNoUnknownFields` checks it.

## Modules

| Module | Server-only | What it does |
|---|---|---|
| `nsids.ts` | no | `NSID` map of every collection, `SCHELLINGPOINT_COLLECTIONS`, `INDEXED_COLLECTIONS`, `EVENT_MODE`/`EVENT_STATUS`/`RSVP_STATUS` fragment tokens. |
| `types.ts` | no | TS shape of every record (ours and borrowed) and `StrongRef`. |
| `rkey.ts` | no | `tid()` (monotonic 13-char TID), `deterministicRkey(...parts)` (13 chars of base32 SHA-256, pure TS), `SELF_RKEY`. |
| `records.ts` | no | Pure builders `build*Record` / `buildSessionCalendarEvent` / `buildEventConfig` / `buildTallyRecord` (k-suppression) etc., plus `assertNoForeignDid`. Plain inputs, no I/O. |
| `validate.ts` | node (not `server-only`, tests import it) | Loads every JSON under `lexicons/` into `@atproto/lexicon`. `assertValidRecord`, `isValidRecord`, `lexiconRecordProperties`, `assertNoUnknownFields`. |
| `config.ts` | yes | Env readers, `oauthMode()` (`confidential` on https + real host, else `loopback`), `isAtprotoConfigured()`. |
| `crypto.ts` | yes | AES-256-GCM `wrapSecret` / `unwrapSecret` under `ATPROTO_CUSTODY_KEY`, plus bytea text helpers for PostgREST. |
| `identity.ts` | yes | `resolveHandle`, `resolveDidDoc` (`@atproto/identity` + XRPC fallback), `atUri`, `parseAtUri`. |
| `oauth.ts` | yes | `getOAuthClient()` singleton (`NodeOAuthClient`, Supabase-backed state/session stores, ES256 key in `at_oauth_client_key`), `clientMetadata`, `jwks`, `authorizeUrl`, `handleCallback`, `restoreOAuthSession`, `revokeOAuthSession`. |
| `session.ts` | yes | `sp_at_session` HttpOnly cookie: `createAtSession`, `readAtSession`, `destroyAtSession`, header helpers. |
| `agent.ts` | yes | `agentForDid` / `agentForUser` / `withAgentForDid` — app-password (custodied, cached, re-login on 401) or OAuth session → `Agent`. |
| `write.ts` | yes | `putRecord` (local validation, `validate:false` on the wire, optional CAS), `deleteRecord`, unauthenticated `getRecord` / `listRecords` via the repo's own PDS, 2-attempt retry on network errors. |
| `actor.ts` | yes | `GatheringActorPort`: `putRecordAsGathering`, `deleteRecordAsGathering`, `authorizeGatheringAction`. Authorises via `event_members`, validates + R9-checks, audits every call in `at_audit`. `DESTRUCTIVE_ACTIONS` need owner/admin. |
| `index-store.ts` | yes | `at_records` index: `upsertIndexedRecord`, `deleteIndexedRecord`, `getIndexedRecord`, `listIndexed`, `getCursor`, `setCursor`. |
| `index.ts` | yes | Re-exports everything. Client code must import the four isomorphic modules directly. |

`lexicons/` at the repo root holds the JSON: `schellingpoint/draft/*` (ours, ten
records), `vendor/*` (copied verbatim from Free School: `community.lexicon.*`,
`coop.lexicon.*`, `freeschool/{policy,approval}.json`) and `atproto/` (the
`com.atproto.repo.strongRef` def every `ref` needs). `npm run lexicons:validate`
loads them all and fails on any parse or unresolved-ref error.

## Who writes what, where

| Record | Repo | Through |
|---|---|---|
| `gathering` (`rkey=self`), `policy`, `venue`, `track`, `slotGrid`, `slot`, `tally`, the gathering's and each scheduled session's `calendar.event` + `event.config`, listings, stub proposals | gathering actor | `actor.ts` only |
| `proposal`, `timePreference` | the proposer | `agentForUser` + `write.ts` |
| `cohost`, `endorsement`, opt-in `rsvp` | the co-host / participant / attendee | `agentForUser` + `write.ts` |

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | yes | Public origin; decides `oauthMode()` and the `Secure` cookie flag. |
| `ATPROTO_SESSION_SECRET` | yes | HMAC key for the session cookie (32+ chars). |
| `ATPROTO_CUSTODY_KEY` | yes | 64 hex chars; AES-256-GCM key for `at_credentials.wrapped`. |
| `ATPROTO_OAUTH_PRIVATE_JWK` | no | Pre-provisioned ES256 private JWK; otherwise generated and stored in `at_oauth_client_key`. |
| `ATPROTO_JETSTREAM_URL` | no | Default `wss://jetstream2.us-east.bsky.network/subscribe`. |
| `ATPROTO_DEFAULT_PDS_URL` | no | Default `https://bsky.social`; PDS for custodial accounts. |
| `ATPROTO_HANDLE_RESOLVER` | no | Default `https://bsky.social`; XRPC fallback for handle → DID. |

## Local development notes

- In loopback mode the OAuth redirect is `http://127.0.0.1:<port>/oauth/callback`
  (the loopback client id requires an IP literal), so the session cookie lands on the
  `127.0.0.1` origin — open the dev server there, not on `localhost`, when testing OAuth.
- `validate.ts` reads `lexicons/` from `process.cwd()` at module init. On Vercel the
  directory must be traced into the function bundle; if a deploy ever reports the
  directory missing, add `lexicons/**` to `outputFileTracingIncludes` in `next.config.js`.
- Tables: `at_oauth_state`, `at_oauth_session`, `at_oauth_client_key`, `at_sessions`,
  `at_credentials`, `at_audit`, `at_sync_cursor`, `at_slot_grids` (RLS on, no policies →
  service role only) and `at_records` (public SELECT). Migration
  `supabase/migrations/20260916000001_atproto_foundation.sql`.
