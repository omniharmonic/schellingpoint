I have a complete picture. Here is the map.

---

# How the gathering (event) ATProto account works — and where "post to Bluesky" would fit

## 1. The gathering actor: auth, collections, audit, R9

### Identity & credential
- **Minting**: `src/lib/auth/custody.ts:615-650` `mintGatheringAccount({slug, name, createdBy})` — creates an invite code, generates a 32-char random password, wraps it AES-256-GCM (`wrapSecret`), calls `createAccount()` against our PDS (`src/lib/auth/pds.ts`), preferring handle `<slug>.<PDS_HANDLE_DOMAIN>` (`custody.ts:622`, so `ethboulder.unconference.events`), falling back to a random `<word><word><3 digits>` handle (`src/lib/auth/handles.ts:3`). It inserts into **`at_credentials`** (`custody.ts:644-647`) with `kind='app-password'`.
- Wrapped by `mintGatheringIdentity` (`src/lib/events/identity.ts`) → `mintGatheringActor` (`src/lib/atproto/actors.ts:396-405`), which stamps `events.actor_did` / `events.actor_handle` and an `at_audit` row.
- **Alternative custody**: an owner can instead point the gathering at an existing account via app password (`POST …/admin/atproto {action:'link', handle, appPassword}`, `src/app/api/v1/events/[slug]/admin/atproto/route.ts:130`) or OAuth (`/api/atproto/auth/start?purpose=gathering`). `at_credentials.kind` is `'oauth' | 'app-password'` (`db/migrations/0001_baseline.sql:1096-1109`).
- **Session/auth at write time**: `CredentialGatheringSession` (`src/lib/atproto/actors.ts:193-299`) lazily resolves the agent via `agentForDid(did)` (`src/lib/atproto/agent.ts`), refuses if `at_credentials.disabled_at` is set, retries once on `ExpiredToken`/401, records success/failure on `at_credentials.last_ok_at/last_error/consecutive_failures/disabled_at` (`actors.ts:152-176`, `DISABLE_AFTER_AUTH_FAILURES = 3` at `actors.ts:66`). It paces writes through `paceRepoWrite` (`src/lib/atproto/rate-limit.ts`) and calls `com.atproto.repo.putRecord` / `applyWrites` / `deleteRecord` with **`validate: false`** (`actors.ts:250-285`) because our lexicons are unpublished.
- Health for the organiser banner: `gatheringActorHealth()` `actors.ts:409-460` (`unlinked|ok|failing|disabled`).

### The port (only chokepoint)
- `src/lib/atproto/actor.ts:289-473` `AppCustodyGatheringActor` implements `GatheringActorPort`. Every write goes: build record with `$type` → `assertValidRecord` (`actor.ts:386`) → `assertNoUnknownFields` for borrowed NSIDs (`:387`) → `consentedSubject` R9 exemption check (`:388`) → `assertNoForeignDid` (`:389`) → `gate()` (authorize + audit row) (`:392`) → PDS write → `at_records` upsert.
- Actions enum: `GatheringAction` `actor.ts:30-52`; destructive set `actor.ts:60-65` (`cancel-slot`, `move-slot`, `remove-listing`, `delete-record`) require `policy_thresholds.destructiveActionStewards` distinct organiser approvals. Role gates: `MIN_ROLE` `actor.ts:75-99`.
- A **mandatory written reason** on every call (`actor.ts:347`).

### Collections the gathering currently writes
`src/lib/atproto/nsids.ts:84-99` `GATHERING_COLLECTIONS`:
`schellingpoint.draft.gathering`, `freeschool.draft.policy`, `community.lexicon.calendar.event`, `coop.lexicon.event.config`, `coop.lexicon.event.listing`, `coop.lexicon.membership`, `schellingpoint.draft.{venue,track,slotGrid,slot,tally,proposal (stubs only)}`, `freeschool.draft.{series,occurrence}`.
Written by `src/lib/atproto/publish.ts` — `publishGathering:550`, `publishPolicy:495`, `publishVenues:672`, `publishTracks:714`, `publishSlotGrids:762`, `publishSchedule:1112`, `writeSession:996`, `moveSession:1423`, `cancelSession:1323`; plus `tally.ts`, `listings.ts`, `series.ts`, `role-claims.ts`.

**There is no `app.bsky.feed.post` and no `app.bsky.actor.profile` anywhere in the repo** (only `app.bsky.actor.getProfile` is *read*, `src/lib/atproto/bsky-profile.ts:30-32`).

### Audit trail (table names)
- **`at_audit`** — `db/migrations/0001_baseline.sql:1079-1092` (`event_id, actor_did, caller_user_id, action, collection, rkey, uri, decision allow|deny, reason, created_at`; `approvals`/`policy_source` added by a later migration and written at `actors.ts:73-81`). Sink: `PostgresAuditSink` `actors.ts:71-88` (`write` + `amend`).
- **`at_credentials`** — credential + health, `0001_baseline.sql:1096`.
- **`at_records`** — read-your-writes index, `0001_baseline.sql:1138`; `src/lib/atproto/index-store.ts`.
- **`at_repo_status`** (migration 0011), **`at_sessions`**, **`at_sync_cursor`**, **`at_oauth_*`**, **`at_slot_grids`**, **`at_series`/`at_occurrences`** (0004).
- **`publish_jobs`** (migration 0011) — resumable schedule publishes.

### `assertNoForeignDid`
`src/lib/atproto/records.ts:930-956`. Walks every string in the record:
- `at://…` URIs are always allowed (record references, not claims about a person) — `records.ts:933`, documented `records.ts:890-893`.
- A bare DID (`BARE_DID_RE` `records.ts:901`) is allowed only if it equals `authorDid`; or it's `subject` and equals `opts.consentedSubjectDid`; or the field is in `FOREIGN_DID_ALLOWED_FIELDS` (`records.ts:894-899`): `school: 'gathering'`, `addedBy: 'gathering'`, `gathering: 'gathering'`, `peers: 'any'` (peers are organisations, never people).
- DIDs smuggled inside free text are caught by `EMBEDDED_DID_RE` (`records.ts:902`, `:942-944`).
- Throws `ForeignDidError`, message: `` `R9: record names DID ${did} at ${path}, but its author is ${authorDid}` `` (`records.ts:904-912`).
- The **only** exemption: `coop.lexicon.membership#subject` via `consentedSubjectDid`, gated in `actor.ts:372-382` (action must be `publish-role-claim`, subject must be the caller, `policy.publishRoles`, `event_members.public_role`, derived role ≥ Host).
- Enforced again offline by `scripts/atproto-privacy-audit.ts` (assertion 1: `at_records` rows **and** live `listRecords` of every gathering repo, per `GATHERING_COLLECTIONS`).

### R9, quoted
The spec states R9 as a §3 "principles carried over" row, `docs/ATPROTO_MIGRATION_SPEC.md:93`:

> | **No public record may name a DID its holder did not write** | This is the rule that reshapes the app. Casualties: `sessions.host_name` (a proposer or an admin typing a speaker's name), `tracks.lead_name`/`lead_email`, `session_cohosts` written on someone's behalf, CSV speaker import, `event_members`, and every vote. Each has a replacement in §4 and §9. |

Supporting statements elsewhere in the same file:
- `docs/ATPROTO_MIGRATION_SPEC.md:61` — "`lead_name`/`lead_email`/`lead_user_id` → **app-side only** (R9: names a person who did not write it)."
- `:130` — proposal lexicon description: "Carries no co-host DIDs (R9: a co-host writes their own `schellingpoint.draft.cohost`)…"
- `:166` — "*R9 check:* names only its author's own DID (implicitly, by repo). No co-host, no speaker name, no attendee. `host_name` has no successor field — the host **is** the repo owner."
- `:580` — "Under R9 those [free-text speaker] names cannot reach a public record we write."
- Next-door restatement in `CLAUDE.md:30-32`: "Never put a DID, name or handle into a public record unless its holder wrote that record (`assertNoForeignDid`). Never publish exact addresses, `host_name`/listed-as names, vote counts outside the tally, or attendee-only details."
- And `docs/ATPROTO_APPVIEW_PLAN.md:34`: "Nothing public names a DID its holder did not write."

**Direct consequence for your feature:** a post from the gathering account mentioning a host's DID/handle is a foreign-DID claim in a public record. `assertNoForeignDid` would throw on a bare DID in a facet feature (`app.bsky.richtext.facet#mention.did`), and an `@handle` in `post.text` would pass the DID regex but still violate the rule's intent — and the privacy audit's assertion 2 ("host-name") checks that no gathering-written record equals a host's or co-host's display name. Any mention needs a new, explicitly consented allowance (the `coop.lexicon.membership` pattern in `actor.ts:372-382` + `role-claims.ts` is the precedent: policy flag + per-gathering subject opt-in + derived role).

### `app.bsky.actor.profile` / discoverability
- **No profile record is ever written.** The gathering account has no display name, avatar, or description on Bluesky; `bsky.app/profile/<handle>` would show a bare handle. The settings UI already links there: `src/app/e/[slug]/admin/settings/_components/NetworkSection.tsx:38` (`https://bsky.app/profile/${network.handle}`).
- **Relay crawl is configured in production**: `deploy/unconference/compose.yml:50-52` `PDS_CRAWLERS: ${PDS_CRAWLERS:-https://bsky.network}` ("Announce to the relay so every public record reaches the firehose"), `.env.example:26`; AppView `PDS_BSKY_APP_VIEW_URL: https://api.bsky.app`, `PDS_BSKY_APP_VIEW_DID: did:web:api.bsky.app` (`compose.yml:46-47`). Verify with `https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=…` (`deploy/unconference/README.md:121`). **Locally there is no relay**: `deploy/local/compose.yml:72-73` `PDS_CRAWLERS: ""`.
- Handle `<slug>.unconference.events` resolves via the Caddy wildcard inversion (`/.well-known/atproto-did` and `/xrpc/*` → PDS, everything else → app): `docs/ATPROTO_APPVIEW_PLAN.md:19-21`, gate in `src/lib/atproto/hosts.ts:1-20`.
- So: records reach the firehose today, but the account is **not** a usable Bluesky profile (no profile record) and writes nothing in `app.bsky.*`. Following it in the Bluesky app would currently show an empty feed.

---

## 2. When the schedule is published / a session is confirmed

### `sessions.status` values
`db/migrations/0001_baseline.sql:1467`: `CHECK (status IN ('pending','approved','rejected','scheduled'))`. Also relevant columns: `time_slot_id`, `venue_id`, `published_slot_id` (0006), `cancelled_at`, `calendar_event_uri/cid`, `slot_uri/cid`, `atproto_published_at`, `host_id`, `host_did`, `proposal_uri/cid` (`0001_baseline.sql:1422-1468`).

### Transitions & handlers
| Transition | Handler |
|---|---|
| `pending → approved / rejected` | `src/app/api/v1/sessions/[id]/route.ts:107` (notification map `approved → session_approved`); bulk: `src/app/api/v1/events/[slug]/sessions/batch/route.ts:106` |
| `approved → scheduled` (slot assignment) | `src/app/api/v1/events/[slug]/admin/sessions/[id]/schedule/route.ts` — PUT at `:57`; guard "only approved sessions can be scheduled" `:75-77`; the update `:115-118`; `notifyPlacement(... kind: 'scheduled' | 'rescheduled')` `:121-127`. Already-on-network sessions become destructive and go to `requestMove`/`requestCancel` (`src/lib/scheduling/destructive.ts`), returning `awaiting_approval` (202). |
| `scheduled → approved` (unschedule) | same file, `DELETE` at `:155` |
| bulk auto-schedule | `src/app/api/v1/events/[slug]/admin/auto-schedule/route.ts` |
| **schedule published** | `src/app/api/v1/events/[slug]/admin/publish-schedule/route.ts` — `POST` at `:92`: one transaction stamps `events.schedule_published_at` (`:106`), `notify(… 'schedule_published')` to every member (`:110-119`), sets `sessions.published_slot_id` (`:121-126`); **after commit** calls `publishSchedule` or enqueues a job (`:141-190`) |
| **network publish (per-record)** | `src/app/api/v1/events/[slug]/admin/atproto/publish/route.ts` — `POST {what: 'gathering'|'policy'|'venues'|'tracks'|'grids'|'schedule'|'all'}` (`:44`), `ALL_ORDER` `:41`; `GET ?jobId=` returns `{job}` (`:84`) |
| gathering-level publish on settings save | `src/lib/events/network.ts:40-48` (`publishGatheringRecords`, `publishPolicyRecord`), called from `src/app/api/events/[eventId]/settings/route.ts` after commit |

Notification types (the natural list of "activity" events to mirror as posts) are constrained at `db/migrations/0001_baseline.sql:1330`: `session_submitted, session_approved, session_rejected, session_scheduled, session_rescheduled, session_cancelled, vote_milestone, cohost_invited/accepted/declined, voting_opened, voting_closed, schedule_published, event_reminder, admin_announcement, new_proposal, proposal_needs_review`. Emission helper: `notify(sql, …)` `src/lib/notifications/`, called inside the action's transaction (`src/lib/scheduling/program.ts:356-378`).

### The job mechanism
- `src/lib/atproto/publish-jobs.ts` (258 lines) over table **`publish_jobs`** (migration 0011). `JOB_THRESHOLD_SESSIONS = 25` (`:23`), `needsJob()` `:96`, `enqueueSchedulePublish()` `:104` (one live job per `(event_id, kind)`, `kind='schedule'`), `getPublishJob()` `:122`, `claimJob()` `:130` (`for update skip locked`, `STALE_LOCK_MS` 10 min), `runDuePublishJobs()` `:176`, `runClaimed()` `:188` — chunks of `SCHEDULE_BATCH_SESSIONS = 25` (`publish.ts:1163`), rate-limit requeue `:216-226`, exponential backoff up to `MAX_ATTEMPTS = 6` `:250`.
- Drained by `src/app/api/jobs/publish/route.ts` (scheduler curl, every minute) and kicked off inline via `after()` (`publish/route.ts:69`, `publish-schedule/route.ts:150`).
- `kind` is a column on `publish_jobs` — **a `kind='bluesky-post'` job would drop into this machinery with almost no new infrastructure** (the unique partial index is on `(event_id, kind) where status in ('queued','running')`, `publish-jobs.ts:109`).
- UI: `src/components/PublishJobProgress.tsx` — polls `statusUrl` every 2 s (`:26`), renders a `Progress` bar, treats rate-limited as "waiting" (`:61`), calls `onDone` on terminal status.

### Admin page
`src/app/e/[slug]/admin/atproto/page.tsx` (client component): identity + credential health banner, `PUBLISH_BUTTONS` (`:80-87`), a plain-language `PUBLIC_RECORDS` disclosure table (`:89-98`) — **this is exactly where a "what gets posted" disclosure row and a publish button would go** — approvals queue, flagged sessions (cid drift / withdrawn / author-inactive), peers, listings, and the recent `at_audit` rows. It already embeds `PublishJobProgress` (`:20`). Backing API: `src/app/api/v1/events/[slug]/admin/atproto/route.ts` (GET status; POST `mint|link|reset-credential|set-policy|upsert-peer|remove-peer|restore-listing|sync-role-claims|create-series|materialize-series`; DELETE unlink) — documented at `:1-20`.

---

## 3. Per-account consent flags & account identity

**Accounts** (`db/migrations/0001_baseline.sql:90-103`): `id, did UNIQUE NOT NULL, handle, email, kind CHECK IN ('custodial','oauth'), wrapped_password, key_version, email_verified_at, owned_at, created_at`. So yes — **`did`, `handle`, and `kind`** (the `auth_kind` you asked about) are all stored. `Viewer` carries them: `docs/ATPROTO_APPVIEW_PLAN.md:117`, `src/lib/auth/viewer.ts`.

Consent flags, in order of relevance to "may we name this person publicly":

| Flag | Where | Meaning |
|---|---|---|
| **`event_members.public_role`** | `db/migrations/0008_people.sql:91`, comment `:95-96` | *"Subject opt-in for a public `coop.lexicon.membership` role claim in this gathering (one of three gates; spec §4.1, §10)."* **Boolean, default false, per gathering.** This is the existing "you may name me publicly as a host of this gathering" consent. Read by `postgresRoles.publicRoleOptIn` (`actors.ts:104-109`) and `role-claims.ts:54-63`. |
| **`events.policy_thresholds.publishRoles`** | `db/migrations/0007_gathering_policy.sql:16-18`, default `false` | Organiser-side gate: does this gathering publish role claims at all. |
| derived role ≥ Host | `deriveGatheringRole` `actors.ts:118-133`, `LADDER` `actor.ts:70` | Third gate. |
| **`profiles.publish_proposals`** | `0001_baseline.sql:1353`, default false | The OAuth-door "hard confirm" of permanent public linkage before we write into a brought account's own repo. Read at `src/app/api/v1/sessions/_lib/atproto.ts:51-58`, `api/atproto/me/route.ts:25-26`; toggled by `PATCH /api/atproto/me`. Custodial accounts skip it (`kind === 'custodial' || publish_proposals`). |
| **`event_members.directory_listing`** | `0008_people.sql:91`, default **true** (opt-out) | Members-only directory only; never public. |
| **`session_rsvps.rsvp_uri`** | `0001_baseline.sql:1416` | Per-RSVP opt-in to write `community.lexicon.calendar.rsvp` into the attendee's own repo (`participant.ts`). |
| **`session_host_listings.host_name`** | `db/migrations/0006_organizer_admin.sql:22-33` | The "listed as" you asked about: *"Organizer-typed 'listed as' names for host-less sessions (R9). Organizer-only; never served publicly, never written to any record."* RLS: organisers only (`:37-44`). |
| `profiles.show_ens` / `ens_verified_at` | `0008_people.sql:29-31` | Members-only display of a verified ENS. |

The whole three-gate consent machine lives in `src/lib/atproto/role-claims.ts:1-17` (doc comment) with `syncRoleClaimsForEvent` exposed at `POST …/admin/atproto {action:'sync-role-claims'}`. **This is the pattern to copy for "may the gathering mention me in a post"** — most likely a fourth boolean on `event_members` (e.g. `public_mention`) plus a policy threshold, since `policy_thresholds` has an exact-3-keys CHECK (`0007:31`) that would need widening.

Note also `src/lib/atproto/repo-status.ts`: a hidden/suspended/deactivated repo must not be named — sessions get `author_inactive_at`, "the published schedule shows no `host`" (`repo-status.ts:12-14`). Any mention logic must respect `visibleRepoSql` (`repo-status.ts:49-51`).

---

## 4. Existing `app.bsky.feed.post` / facets / RichText usage

**None.** Concretely:
- `grep app.bsky` across `src scripts lexicons tests db` returns exactly two hits, both in `src/lib/atproto/bsky-profile.ts:30` and `:32` — a read-only unauthenticated `app.bsky.actor.getProfile` against `https://public.api.bsky.app` used to borrow display name/avatar/bio into `profiles` on first Bluesky sign-in (`importBskyProfile` `:58`, `applyBskyProfile` `:70`, background wrapper `:120`; avatar re-encoded via sharp to 512px webp `:88-92`; fetched with the SSRF-safe `safeFetch`).
- `grep "feed.post|RichText|richtext|facets"` across `src scripts tests` → **zero hits**.
- `package.json:20` has **`@atproto/api ^0.20.44`**, which ships `RichText` and `AppBskyFeedPost` — available, just unused. Also `@atproto/lexicon ^0.7.14` (`:22`), `@atproto/identity`, `@atproto/oauth-client-node`, `@atproto/syntax`.
- The agent used for writes is `Agent` from `@atproto/api` (`actors.ts:23`, `src/lib/atproto/agent.ts`), and only `com.atproto.repo.*` methods are called.

**Blockers you'd hit:**
1. `assertValidRecord` (`src/lib/atproto/validate.ts:67-77`) validates against lexicons loaded **from disk** at `lexicons/**` (`:39-52`). `app.bsky.feed.post` is not vendored there, so `lexicons.assertValidRecord('app.bsky.feed.post', …)` throws `RecordValidationError`. You'd need to vendor `app.bsky.feed.post.json` + `app.bsky.richtext.facet.json` (+ `app.bsky.embed.*` if you embed) under `lexicons/vendor/`, and `npm run lexicons:validate` (`scripts/validate-lexicons.mjs`).
2. `isBorrowedNsid` (`nsids.ts:120-122`) only matches `community.lexicon.`, `coop.lexicon.`, `freeschool.draft.` — `app.bsky.` is **not** covered, so `assertNoUnknownFields` (the sidecar rule) would not run on a post. Given `app.bsky.feed.post` is the most borrowed lexicon there is, add the prefix.
3. `GatheringAction` (`actor.ts:30-52`) + `MIN_ROLE` (`:75-99`) need a new action (e.g. `publish-post`), and probably `delete-post` in `DESTRUCTIVE_ACTIONS` (a post is something people rely on).
4. `GATHERING_COLLECTIONS` / `INDEXED_COLLECTIONS` / `JETSTREAM_COLLECTIONS` (`nsids.ts:48-118`) and the reconciliation + privacy audit (`scripts/atproto-privacy-audit.ts:177`) iterate `GATHERING_COLLECTIONS` — decide deliberately whether posts are in scope (they should be, for the foreign-DID assertion).
5. `agent.com.atproto.repo.putRecord(..., validate: false)` (`actors.ts:251-263`) — fine, but note posts use `tid` rkeys (`src/lib/atproto/rkey.ts:tid`) rather than the deterministic rkeys everything else uses, so the existing CAS/idempotency story (`putWithCas` `publish.ts:321`) doesn't apply; you'd need an app-side "already posted" ledger keyed by (event, kind, subject) to make re-runs idempotent.

---

## 5. Event-level settings: columns and UI

### `events` columns (`db/migrations/0001_baseline.sql:1230-1280`)
`id, slug, name, tagline, description, start_date, end_date, timezone (default 'America/Denver'), location_name, location_address, location_geo, status, vote_credits_per_user, voting_opens_at, voting_closes_at, proposals_open_at, proposals_close_at, allowed_formats[], allowed_durations[], max_proposals_per_user, require_proposal_approval, max_attendees, theme jsonb, logo_url, banner_url, favicon_url, created_by, is_featured, visibility, created_at, updated_at, schedule_published_at, last_schedule_change_at, ticketing_enabled, stripe_account_id, suggested_topics[], voting_mechanism, actor_did, actor_handle, gathering_uri, gathering_cid, calendar_event_uri, calendar_event_cid, policy_uri, atproto_published_at, atproto_tags[]`
+ CHECKs: `status IN (draft, published, proposals_open, voting_open, scheduling, live, completed, archived)` (`:1277`), `visibility IN (public, unlisted, private)` (`:1278`), `voting_mechanism IN (quadratic, linear, approval)` (`:1279`).

Later additions:
- `0007_gathering_policy.sql:14` — `require_proposal_approval` default flipped to **false**; `:16-18` — **`policy_thresholds jsonb NOT NULL DEFAULT '{"destructiveActionStewards":2,"feedbackK":3,"publishRoles":false}'`**, with `valid_policy_thresholds()` (`:21-32`) enforcing **exactly 3 keys** — widening this is required if a Bluesky flag lives in the policy record.
- `0014_platform_contributions.sql:3` — `platform_fee_percent numeric(5,2) NOT NULL DEFAULT 1`.

### Settings UI
`src/app/e/[slug]/admin/settings/page.tsx` — sections list `:23-32`, rendered `:68-77`:
`LifecycleSection`, **`NetworkSection`**, `BasicsSection`, `DatesSection`, `ParticipationSection`, `VotingSection`, `SafeguardsSection`, `BrandingSection`, `DangerZone` — all in `src/app/e/[slug]/admin/settings/_components/`.

**Best fit for a "Post to Bluesky" toggle:**
- **`NetworkSection.tsx`** (`_components/NetworkSection.tsx`) — already titled "Network identity", shows the handle/DID, "View on the network" → `bsky.app/profile/<handle>` (`:38`), "Inspect the record" → pdsls (`:39`), and a link to the admin atproto page (`:73`). A toggle here reads as "this account also posts". It receives `network: EventNetwork | null` from `useEventNetwork()` (`src/contexts/EventContext`).
- Or **`SafeguardsSection.tsx`**, which already renders `policy_thresholds` (`page.tsx:75`, `thresholds={network?.thresholds}`) — the right home if the flag is a *privacy* gate rather than a feature switch.

**Backing route**: `src/app/api/events/[eventId]/settings/route.ts` — `ALLOWED_KEYS` allowlist at `:138-144` (any new column must be added there), per-key validation, then post-commit network writes via `publishGatheringRecords` / `publishPolicyRecord` (`src/lib/events/network.ts:40-48`). The route doc comment `:19-39` describes the exact ordering contract (transaction first, network after, never inside).

---

## Suggested seams (concrete)

1. **New action** `'publish-post'` in `GatheringAction` (`actor.ts:30`), `MIN_ROLE: 'steward'` (`actor.ts:75`), optional `'delete-post'` in `DESTRUCTIVE_ACTIONS` (`actor.ts:60`).
2. **Vendor** `app.bsky.feed.post` + `app.bsky.richtext.facet` into `lexicons/vendor/`; add `'app.bsky.'` to `BORROWED_PREFIXES` (`nsids.ts:118`) and `NSID.post` (`nsids.ts:11`); add to `GATHERING_COLLECTIONS` (`nsids.ts:84`).
3. **Builder** `buildGatheringPost(...)` in `records.ts` next to `buildSessionCalendarEvent`, emitting `{text, facets, createdAt, langs}` with a link facet to `${appUrl()}/e/<slug>/sessions/<id>` (URL helper `publish.ts:269`, `sessionUrl` used at `publish.ts:978`). No mention facets unless the consent gate passes.
4. **Consent**: new `event_members.public_mention boolean NOT NULL DEFAULT false` mirroring `public_role` (`0008_people.sql:91`), plus an `assertNoForeignDid` allowance analogous to `consentedSubjectDid` (`actor.ts:372-382`, `records.ts:917-923`) restricted to facet `features[].did` for accounts that (a) opted in, (b) are the session's host/co-host by their own record, (c) are not a hidden repo (`repo-status.ts:49`). Note mentions also require the mentioned account to be an *existing Bluesky-visible* account — only `accounts.kind='oauth'` (or a custodial account the relay has crawled) will render.
5. **Event flag**: either a new `events.bluesky_posts boolean` (+ `ALLOWED_KEYS` at `settings/route.ts:138`) or a 4th `policy_thresholds` key (requires editing `valid_policy_thresholds` `0007:21-32` and `src/lib/events/policy.ts`).
6. **Delivery**: a `publish_jobs` row with `kind='bluesky-post'` (`publish-jobs.ts:107`) reusing `claimJob`/backoff/rate-limit handling, surfaced by `PublishJobProgress`; hook points are the post-commit blocks in `publish-schedule/route.ts:141` (schedule published) and `admin/sessions/[id]/schedule/route.ts:121` (session confirmed on schedule), plus `publish.ts:writeSession:1080` (network confirmation).
7. **Audit/disclosure**: nothing extra needed for `at_audit` (the port writes a row per call), but add a row to `PUBLIC_RECORDS` in `src/app/e/[slug]/admin/atproto/page.tsx:89` describing exactly what a post contains, and extend `scripts/atproto-privacy-audit.ts` assertion 2 (host-name) to cover post text.
