# `src/lib/atproto`

The ATProto layer of unconference.events: our own PDS (`pds.unconference.events`; locally
`http://localhost:2583`, handles `*.test`), custodial and OAuth identities, gathering actors, and a
Postgres AppView. Design sources: `docs/ATPROTO_MIGRATION_SPEC.md` (§3, §4, §6, §8, §9, §10),
`docs/ATPROTO_APPVIEW_PLAN.md` (§6 items 4–10, 16–22, 27, 31; §7.2). Reference implementation:
Free School (`packages/school-actor`, `apps/appview/src/lib/{school-actors,events,membership-claims,tls-check}.ts`).

Three rules bind everything here:

- **R9** — no public record names a DID its holder did not write. `assertNoForeignDid` runs before
  every gathering write and every participant write. The single exemption is a
  `coop.lexicon.membership` role claim whose subject passed all three gates.
- **Sidecar** — never add a field to a borrowed lexicon (`community.lexicon.*`, `coop.lexicon.*`,
  `freeschool.draft.*`). `assertNoUnknownFields` runs on every borrowed write.
- **Every write as a gathering goes through its actor port** — validated, R9-checked, authorised,
  audited (`at_audit`, approvals included), CAS'd, and upserted into `at_records` (read-your-writes).

## Modules

| Module | What it does |
|---|---|
| `nsids.ts`, `types.ts`, `rkey.ts`, `records.ts`, `recurrence.ts` | Isomorphic. NSIDs and collection sets (`GATHERING_COLLECTIONS`, `PARTICIPANT_COLLECTIONS`, `JETSTREAM_COLLECTIONS`), record types, TIDs and `deterministicRkey`, pure builders (incl. `venueLocation` coarsening, listings, membership claims + `membershipClaimRkey`, approvals, time preferences, series/occurrence, `decideListingEdit`, `routesOnTags`), RRULE expansion. |
| `validate.ts` | Loads `lexicons/**` into `@atproto/lexicon`; `assertValidRecord`, `assertNoUnknownFields`. |
| `identity.ts` | Handle/DID resolution. A DID hosted on OUR PDS is answered by `describeOwnRepo` (internal URL); foreign DIDs via PLC (`ATPROTO_PLC_URL` optional). |
| `write.ts` | Repo I/O: `putRecord`/`deleteRecord` (local validation, `swapRecord` only when passed), unauthenticated `getRecord`/`listRecords`/`listAllRecords` (100-row pages, cursor-followed), `isInvalidSwap`. |
| `rate-limit.ts` | 429 / `RateLimit-Reset` / `Retry-After` backoff with a 60 s wait budget (`RateLimitBudgetExceededError`), 5xx retries, and `RepoWritePacer` (one write per repo, points budget under the PDS's 5 000/h and 35 000/day; create 3, put 2, delete 1). |
| `index-store.ts` | `at_records` on `sql`; cursors in `at_sync_cursor`, `advanceCursor` is monotonic. |
| `actor.ts` | `GatheringActorPort` + `AppCustodyGatheringActor` (dependency-injected): MIN_ROLE per action, destructive threshold, role-claim gates, audit, read-your-writes. |
| `actors.ts` | The registry: `actorForEvent` (LRU 64 + TTL, lazy credential), `CredentialGatheringSession` (one re-login, persistent auth failure → evict + `disabled_at` after 3), `putRecordAsGathering`/`deleteRecordAsGathering`, `mintGatheringActor`, `gatheringActorHealth` (organiser banner), `resetGatheringCredential`, `deriveGatheringRole`, `configureGatheringActors` (test seam). |
| `publish.ts` | Gathering publishing: `publishGathering`, `publishPolicy`, `setPolicyThresholds`, `publishVenues`, `publishTracks`, `publishSlotGrids`, `publishSchedule`, `republishSession`, and the destructive `moveSession`/`cancelSession`. CAS with one re-read retry; new independent records share `applyWrites` commits (creates only, ≤ 100 ops), schedule writes in phases (events, then configs + slots). |
| `publish-jobs.ts` | `publish_jobs`: schedules of > 25 sessions publish as a resumable job (`enqueueSchedulePublish`, `runDuePublishJobs`, `getPublishJob`), re-queued at the PDS's reset when rate-limited. |
| `approvals.ts` | `requestSessionMove`, `requestSessionCancel`, `requestListingRemoval`, `approveRequest`, `withdrawApproval`, `listApprovalRequests`. Approvals are `freeschool.draft.approval` records in each organiser's own repo. |
| `participant.ts` | Records in a person's own repo: proposal, co-host, endorsement, opt-in RSVP, opt-in time preference; `publishingIdentity` (OAuth linkage gate). |
| `drift.ts` | cid drift and withdrawal flags + `proposal_changed` notifications; `flaggedSessions`. |
| `listings.ts` | `coop.lexicon.event.listing` routing (sticky removal), `restoreListing`, `applyListingRemoval`, peers (`upsertPeer`, `removePeer`, `routePeerListings`). |
| `role-claims.ts` | Triple-gated `coop.lexicon.membership`: `syncRoleClaim`, `setRoleClaimOptIn`, `syncRoleClaimsForEvent`. |
| `skills.ts` | The Free School skills authority's taxonomy cached in `at_records` (24 h): `ensureSkillsFresh`, `searchSkills`, `getSkills`, `validateSkillUris`. |
| `series.ts` | Recurring gatherings: `createGatheringSeries`, `materializeSeries`, `materializeAllSeries`. |
| `repo-status.ts` | `at_repo_status`: account status (`applyRepoStatus` — hide/restore, `sessions.author_inactive_at`, `session_cohosts.cohost_inactive_at`, `proposal_changed`), identity changes (`applyIdentityChange` — cache eviction, bidirectional handle verification, NULL when invalid). |
| `ingest.ts` | `ingestRecord` (relevance filter, validation, per-record error boundary), `processJetstreamFrame` (commits with side effects verified against the author's PDS; `#account` / `#identity` frames), targeted reconcile requests, `reconcileRepo`/`reconcileAll` (our PDS via `listRepos`, OAuth accounts, actors, peers; deletion diff), `persistJetstreamCursor`. |
| `hosts.ts` | `resolveGatheringHost(host)` for middleware; `allowCertificateFor(domain)` — the on-demand TLS gate. |
| `http.ts` | `atprotoErrorResponse(e)` — one error → JSON mapping for every route. |
| `config.ts`, `crypto.ts`, `agent.ts`, `oauth.ts`, `session.ts`, `bridge.ts`, `bsky-profile.ts` | Wave-0 identity (shared, read-only for this package). |
| `tally.ts` | Package C: the k-suppressed tally, written through `publish.ts`. |

## Who writes what, where

| Record | Repo | Through |
|---|---|---|
| `gathering@self`, `freeschool.draft.policy`, `venue`, `track`, `slotGrid`, calendar events + configs (gathering and sessions), `slot`, `tally`, listings, role claims, stub proposals, series/occurrences | gathering actor | `actors.ts` port only |
| `proposal`, `timePreference` (opt-in) | the proposer | `participant.ts` |
| `cohost`, `endorsement`, `community.lexicon.calendar.rsvp` (opt-in) | the co-host / participant / attendee | `participant.ts` |
| `freeschool.draft.approval` | each approving organiser | `approvals.ts` |

## HTTP

| Route | Auth |
|---|---|
| `GET/POST/DELETE /api/v1/events/[slug]/admin/atproto` (status, mint, link, reset-credential, set-policy, peers, restore-listing, role claims, series) | organisers |
| `POST /api/v1/events/[slug]/admin/atproto/publish` `{ what }` | owner/admin |
| `POST /api/v1/events/[slug]/admin/atproto/sessions/[id]` `{ action: republish \| move \| cancel }` | owner/admin |
| `GET/POST /api/v1/events/[slug]/approvals` | owner/admin |
| `GET/POST /api/v1/events/[slug]/sessions/[id]/atproto` | public read / signed-in writes to own repo |
| `GET /api/atproto/records?event=` | public (private/draft gatherings: members only) |
| `GET /api/atproto/skills?q=` / `?uris=` | public |
| `GET /api/atproto/sync` | `Bearer $CRON_SECRET` |
| `GET /api/jobs/publish` | `Bearer $CRON_SECRET` (scheduler, every minute) |
| `GET /api/v1/events/[slug]/admin/atproto/publish?jobId=` | owner/admin (job progress) |
| `GET /internal/tls-check?domain=` | container-local (Caddy `ask`) |

## Environment

| Variable | Purpose |
|---|---|
| `PDS_URL` / `PDS_INTERNAL_URL` / `PDS_ADMIN_PASSWORD` / `PDS_HANDLE_DOMAIN` | Our PDS (public URL named by DID documents; internal URL for all I/O). |
| `ATPROTO_SESSION_SECRET`, `ATPROTO_CUSTODY_KEY` | Session cookie HMAC; AES-256-GCM custody key. |
| `ATPROTO_PLC_URL` | Optional PLC directory for foreign DIDs (default plc.directory). |
| `PDS_PLC_URL` | The PLC directory our PDS writes to; identity events re-read our accounts' DID documents from it (default plc.directory; local `http://localhost:2582`). |
| `ATPROTO_REPO_WRITE_HOUR_POINTS` / `ATPROTO_REPO_WRITE_DAY_POINTS` | Per-repo pacing budget (default 4 000 / 28 000). |
| `ATPROTO_JETSTREAM_URL` | Jetstream for `scripts/atproto-indexer.ts`. |
| `SKILLS_AUTHORITY_DID` | Default `did:plc:yekh7akcatgn7o7foedjpgj4` (Free School skills). |
| `GATHERING_ACTOR_CACHE_TTL_MS` | Port cache TTL (default 30 min). |
| `CRON_SECRET` | Scheduler bearer for `/api/atproto/sync`. |

## Tables (migration `db/migrations/0004_atproto_layer.sql`)

`approval_requests`, `approval_request_approvals`, `listings`, `peers`, `role_claims`, `time_preferences`,
`at_repo_state`, `at_series`, `at_occurrences` (RLS on, no policies); columns `sessions.{skill_uris,
public_place, proposal_drift_cid, proposal_drift_at, proposal_withdrawn_at, cancelled_at}`,
`venues.{locality, region, postal_code, country, is_private_residence}`,
`at_credentials.{consecutive_failures, disabled_at}`, `at_audit.{approvals, policy_source}`.
Policy thresholds live on `events.policy_thresholds` (0007), track skills on `tracks.skill_uris` (0006),
the role-claim opt-in on `event_members.public_role` (0008).

## Scripts and tests

- `npm run atproto:audit` — the spec §9 privacy audit (index AND live PDS). Release blocker.
- `npm run atproto:indexer` — Jetstream consumer (relevance-filtered, monotonic cursor).
- `tests/atproto-e2e.spec.ts` — the whole flow against the real local PDS; `atproto-publish`
  (port/registry failure paths, revoked credential isolation), `atproto-participant`, `atproto-ingest`,
  `atproto-records`, `atproto-auth`.
