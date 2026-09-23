# Feature inventory and gap list — `atproto` @ b428cd0

Written 2026-09-22, read-only. Sources of truth, in the order they win where they disagree:

1. `docs/ATPROTO_MIGRATION_SPEC.md` §4, §5, §6–§11 — the privacy rules are requirements.
2. `docs/ATPROTO_APPVIEW_PLAN.md` §6 — the 31-item spec-compliance checklist.
3. `docs/superpowers/specs/2026-09-21-collective-intelligence-release-design.md` — this release's scope; §0 carries the non-goals, §12 the decisions, §14 the open items.
4. `.claude/schelling_point_PRD.md` (v3.0, 2301 lines), mapped by `docs/design/audits/2026-09-21-prd-extraction.md`.
5. `docs/MULTI_TENANT_EVOLUTION_STRATEGY.md` §3–§12.
6. `docs/STRIPE_ACTIVATION.md` and `deploy/unconference/README.md` "Payments activation" for the payments hold.

`docs/IMPLEMENTATION_HANDOFF.md` describes the Supabase product on `main` and is **not** evidence about this branch; every claim below is checked against code on `atproto`.

A note on tooling that affects any future audit: four source files contain literal NUL bytes, so plain `grep` silently skips them — use `grep -a`. They are `src/components/SettingsModal.tsx`, `src/hooks/useVoting.tsx`, `src/lib/knowledge/normalize.ts`, `src/app/api/me/profile/validate.ts`.

> **Working-tree caveat, recorded during the audit.** The inventory below is of committed `atproto` @ `b428cd0`. Partway through, the working tree stopped being clean: ten Stripe-related files are modified and four are new and uncommitted — `db/migrations/0029_checkout_references.sql`, `src/lib/payments/{merchant,references,webhook}.ts`. That work implements most of the payments P1 cluster: direct charges created with `{ stripeAccount }` and **no** `transfer_data` (`src/lib/payments/stripe.ts:146-155`), Accounts v2 with `responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' }` (`stripe.ts:274`), an immutable `checkout_references` row verified against `event.account` **and** `events.stripe_account_id` before settlement, and a `livemode` guard on the webhook route. Read §10 and P1-1…P1-5 as *the state of the committed branch plus what that uncommitted change is on its way to fixing*. What is still absent in that working tree: `account.updated` handling, a Stripe event-id dedupe ledger (idempotency remains semantic, documented as sufficient), any caller for the new `createRefund` helper, and true processing-fee reporting (the revenue API now honestly labels net as "before Stripe processing fees" via `processingFeesKnown: false` rather than computing it).

---

## (a) Summary

| Status | Count | Share |
|---|---:|---:|
| **Implemented** | 106 | 57% |
| **Partial** | 20 | 11% |
| **Missing** | 52 | 28% |
| **Deliberately out of scope** | 9 | 5% |
| **Total requirements tracked** | **187** | |

By area:

| Area | Impl | Partial | Missing | Out of scope |
|---|---:|---:|---:|---:|
| Identity, onboarding, custody | 10 | 1 | 1 | 1 |
| Gathering creation & tenancy | 9 | 1 | 2 | — |
| Proposals | 8 | 2 | 2 | — |
| Co-hosts | 2 | — | 3 | — |
| Voting (pre-event + attendance) | 9 | 1 | 2 | 2 |
| Scheduling | 11 | 1 | — | — |
| Publishing, interop, feed | 15 | 1 | 2 | — |
| Notifications & email | 4 | 4 | 11 | — |
| Invites & roles | 4 | — | — | — |
| Ticketing & payments | 5 | 1 | 7 | 4 |
| Check-in | 2 | — | 2 | — |
| RSVP / waitlist / capacity | 2 | — | 2 | — |
| Calendar | 2 | — | 2 | — |
| Feedback & resources | 2 | — | — | — |
| Analytics | 1 | 1 | 1 | — |
| Map | 3 | — | — | — |
| Knowledge & MCP | 5 | 1 | 2 | — |
| Discovery & platform surface | 1 | 4 | 2 | 1 |
| Moderation & trust | 3 | — | 5 | — |
| Privacy, retention, compliance | 2 | — | 4 | — |
| Cross-cutting (a11y, search, PWA, tz, limits) | 6 | 3 | 2 | 1 |

The headline: **the free, unpaid path through a gathering works end to end** — create, invite, propose, approve, vote with ballot keys, close, cluster-schedule, publish to the network, RSVP, check in, give feedback, harvest transcripts. The concentrated holes are **payments** (a documented activation hold, plus four unimplemented requirements from `STRIPE_ACTIVATION.md`), **notifications** (four declared types have no emitter and nine promised triggers were never built), and **moderation/subject-rights** (no report flow, no account deletion, no data export).

---

## (b) Inventory

Status key: **I** implemented · **P** partial · **M** missing · **O** deliberately out of scope.

### 1. Identity, onboarding, custody (spec §7; checklist 1–4, 22)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 1.1 | Custodial door: email → PDS account, generated handle never from email, AES-256-GCM wrapped password, magic link | I | `src/lib/auth/custody.ts`, `pds.ts`, `handles.ts`; `src/app/api/auth/email/route.ts`; `tests/auth-custody.spec.ts` |
| 1.2 | ATProto door: confidential OAuth, DPoP, PAR, hard `confirmPublicLinkage`, profile import into empty fields only | I | `src/lib/atproto/oauth.ts`, `src/app/oauth/callback/route.ts`, `src/lib/atproto/bsky-profile.ts`; `tests/atproto-auth.spec.ts` |
| 1.3 | Take ownership: admin-side rotation, single-use reveal, custody ends | I | `src/app/api/me/take-ownership/route.ts`, `src/app/api/me/reveal/route.ts`, `src/app/account/reveal/page.tsx` |
| 1.4 | Neutral PDS host + reserved labels shared by handles and gathering subdomains | I | `src/lib/auth/handles.ts` (`RESERVED_LABELS`), `src/app/api/events/validate-slug/route.ts`, `src/app/internal/tls-check` |
| 1.5 | Gathering subdomain routing, OAuth pinned to apex, `Domain=.unconference.events` cookie | I | `src/middleware.ts`, `deploy/unconference/Caddyfile` |
| 1.6 | ENS verified app-side by signature challenge; never a record; only the holder may set it | I | `src/app/api/me/ens/{challenge,verify}/route.ts`; address never stored |
| 1.7 | Generic messaging handle (Telegram's successor), members-only, free text ≤120 | I | migration `0021_messaging_handle.sql`; `SettingsModal.tsx`; design §4 |
| 1.8 | Wallet sign-in door | **O** | spec §7: "There is no wallet door" — a DID document would permanently link chain history to attendance |
| 1.9 | Custodial people may publish `app.bsky.actor.profile` to their own repo, off by default | I | migration `0025_profile_record.sql`; `src/lib/atproto/person-profile.ts`; `SettingsModal.tsx` Identity tab |
| 1.10 | Read profile from the person's own PDS first, refresh hourly, never overwrite locally edited fields | I | `src/lib/atproto/profile-refresh.ts`, migration `0019_profile_sync.sql` (`synced_fields`), `src/app/api/jobs/profile-refresh/route.ts`; `tests/profile-import.spec.ts` |
| 1.11 | Avatar blobs for the gathering's and custodial people's profile records | **M** | design §14 item 1; `person-profile.ts:19` states the record carries no blob; no `uploadBlob` path anywhere; knock-on: feed link cards ship without a thumb |
| 1.12 | Onboarding: profile setup + explainer; PRD §4.1 asks for an interactive quadratic-voting demo | P | `src/components/auth/OnboardingModal.tsx` — 4 intro slides + 3 profile steps; no interactive vote-allocation demo |
| 1.13 | Shared skill taxonomy: tracks carry skill URIs, proposals ≤5 skills, read from the Free School authority (checklist 22) | I | `src/lib/atproto/skills.ts`, `src/components/SkillPicker.tsx`, `src/app/api/atproto/skills/route.ts` |

### 2. Gathering creation and multi-tenancy (spec §8; MT §3, §4, §12.1)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 2.1 | Self-serve creation wizard | I | 10 steps (`src/app/create/useWizardState.ts:173` `WIZARD_STEPS`): Identity → Basics → Dates → Venues → Schedule → Tracks → Participation → Voting → Branding → Review |
| 2.2 | Wizard draft persistence | I | `src/app/create/useWizardPersistence.ts` (`SCHEMA_VERSION = 3`, discard-on-mismatch, resume banner) — localStorage only, never leaves the device |
| 2.3 | Event templates (MT §3.2) | P | `src/lib/events/templates.ts` defines `EVENT_TEMPLATES`, `getTemplateById`; **zero importers** — orphaned since the wizard's `TemplateSelector` was deleted (design §3) |
| 2.4 | Clone / duplicate a gathering (MT §11.3) | **M** | no `clone`/`duplicate` anywhere in `src/app/create` or the creation API |
| 2.5 | Gathering DID minted on our PDS at creation + `gathering@self` + `freeschool.draft.policy` + per-gathering actor registry (checklist 5) | I | `src/lib/events/identity.ts`, `src/lib/atproto/actors.ts:396` (`mintGatheringActor`), LRU port capped at 64 (`tests/atproto-publish.spec.ts:246`) |
| 2.6 | Atomic creation (event + venues + tracks + slots in one transaction) | I | `create_event_with_program` SQL fn; `src/app/api/events/create/route.ts`; `tests/creation-database.spec.ts` |
| 2.7 | Post-creation settings, every wizard decision editable | I | `src/app/e/[slug]/admin/settings/page.tsx` + 11 `_components/*Section.tsx`; `PATCH /api/events/[eventId]/settings` does per-key partial updates |
| 2.8 | Lifecycle state machine and phase gating (MT §12.1) | I | `src/lib/events/lifecycle.ts` (`STATUS_TRANSITIONS`, `isIrreversibleTransition`); DB triggers gate proposals/votes by window |
| 2.9 | Voting step writes policy thresholds as a record, not columns | I | `src/lib/events/policy.ts`, migration `0007_gathering_policy.sql`, `lexicons/vendor/freeschool/policy.json` |
| 2.10 | Branding/theming, "Powered by unconference.events", per-gathering footer | I | `BrandingSection.tsx`, `THEME_PRESETS`, `src/components/Footer.tsx` |
| 2.11 | Uploads (logo, banner) through an organizer-gated endpoint | I | `src/app/api/uploads/route.ts`, `src/lib/storage/**` |
| 2.12 | Slug/handle/reserved-label collision check at creation | I | `src/app/api/events/validate-slug/route.ts` checks three namespaces and previews the ATProto handle |
| 2.13 | Automatic phase transitions from configured timestamps (MT §12.1) | **M** | every transition is a manual organizer action in the settings route; no status job in `src/app/api/jobs/` |

### 3. Proposals (spec §4.2; PRD §4.2, §4.4; checklist 7, 9, 10)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 3.1 | Proposal written into the proposer's own repo on creation; edits via `putRecord` with CAS; withdrawal deletes (checklist 7) | I | `src/lib/atproto/participant.ts`, `src/app/api/v1/sessions/route.ts:162`; `lexicons/schellingpoint/draft/proposal.json`; `tests/atproto-participant.spec.ts` |
| 3.2 | Proposal form: format, duration, expected attendance, tags, skills, track, self-hosted place/time | I | `src/app/e/[slug]/propose/page.tsx`; `src/lib/sessions/constants.ts`; `src/app/api/v1/sessions/_lib/validate.ts` |
| 3.3 | Technical requirements (projector / whiteboard / audio / seating) — PRD §4.2 step 4 | **M** | `required_features` exists in the column, the validator (`validate.ts:147`), the read model and the scheduler's feature constraint — but **no UI writes it**: absent from `propose/page.tsx`, `EditSessionModal.tsx` and `admin/sessions/new` |
| 3.4 | Maximum participants on a proposal (PRD §4.2) | P | `expected_attendance` is offered as five bands and feeds venue matching; RSVP capacity comes from the venue, so a proposer cannot cap their own room |
| 3.5 | Per-person proposal limit | P | enforced by `enforce_event_proposal_rules()` (`0001_baseline.sql:313`); no UI shows the remaining quota — a person discovers it as a `23514` on submit |
| 3.6 | Approval workflow: approve / reject with reason / request changes | I | `src/app/e/[slug]/admin/page.tsx` tabs + `sessions/batch/route.ts`; `request-update/route.ts` emits `proposal_needs_review`. `admin/proposals/page.tsx` is a 12-line legacy redirect |
| 3.7 | Author-only edit; organizers curate app-side and never edit someone's record | I | `src/app/api/v1/sessions/[id]/route.ts:77` `authorizeFields()` (403 `author_only`); DB guard `enforce_session_update_rules` (`0002_ballot_voting.sql:53`) |
| 3.8 | Session merger (PRD §4.4: propose merger, accept/decline/counter, vote transfer ×1.1) | **M** | no table, column, route, lexicon or UI anywhere; the PRD permission matrix rows "Request merger / Accept merger" have no implementation |
| 3.9 | Endorsement record — public, never counted (checklist 10) | I | `lexicons/schellingpoint/draft/endorsement.json`; `src/lib/atproto/participant.ts:435`; UI in `src/components/AtprotoSessionActions.tsx` |
| 3.10 | Time preference app-side by default, per-proposal opt-in publish (checklist 9) | I | `src/components/TimePreferences.tsx`, `src/app/api/v1/sessions/_lib/time-preference.ts`, `lexicons/schellingpoint/draft/timePreference.json` |
| 3.11 | Organizer-curated sessions (`host_id IS NULL`) + CSV bulk import | I | `src/app/e/[slug]/admin/sessions/new/page.tsx`, `src/components/admin/CSVSessionImport.tsx`, migration `0016_curated_session_entitlements.sql` |
| 3.12 | Session detail: resources, transcript, chat link, share to Bluesky, favourite, RSVP | I | `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx` |

### 4. Co-hosts (spec §4.2; checklist 8)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 4.1 | Double opt-in: opaque app-side invite, acceptance writes `cohost` in the co-host's own repo | I | `src/app/api/sessions/[id]/invites/route.ts`, `src/app/api/invite/[token]/accept/route.ts:84`, `publishCohostFor`; `tests/sessions-api.spec.ts:315` |
| 4.2 | An organizer cannot un-cohost; a co-host steps down by deleting their own record | I | `src/app/api/sessions/[id]/cohosts/[cohostId]/route.ts:33` |
| 4.3 | Co-host invitation delivered by the platform (MT §6.2 "Email") | **M** | the invite link is clipboard-only (`src/components/ManageCohostsSection.tsx:96`); `cohost_invited` is declared in `categories.ts` and emitted nowhere |
| 4.4 | Decline path | **M** | `cohost_invites.status` CHECK is `pending|accepted|expired|revoked` — no `declined`; `cohost_declined` can never fire |
| 4.5 | Co-host conflict detection in scheduling (MT §12.18) | **M** | the objective constrains host blackouts and pinned rooms but never checks whether a co-host is already placed concurrently |

### 5. Voting (spec §5; design §11; checklist 11–15, 23)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 5.1 | Ballot-key tables: `vote_rounds`, `vote_ballots` (token, no DID), `vote_entries` (`day`, `ballot_token`, no author), `credit_ledger` | I | `db/migrations/0002_ballot_voting.sql`; RLS on with no policies, all grants revoked (L319–334) |
| 5.2 | Server-enforced Σv² ≤ credits; allocation mutable while open; reductions always allowed | I | `src/lib/voting/allocation.ts:206` (`FOR SHARE` on the round, `FOR UPDATE` on the ledger row) |
| 5.3 | No count leaves the database while a round is open — organizers included (checklist 12) | I | `RoundOpenError` → 409 in `rounds/[id]/{results,tally}`; `src/lib/voting/rounds.ts:492` `resolveClosedRound`; `tests/voting.spec.ts:322` |
| 5.4 | Close in one transaction: `token = hmac(key, account)`, explode in randomized batches, delete ledger, NULL key | I | `src/lib/voting/rounds.ts:283` — the key is computed in SQL and never reaches application memory; `tests/voting.spec.ts:384` |
| 5.5 | k-suppressed tally written by the gathering actor, `suppressed: true` with counts absent | I | `rounds.ts:556` `suppressEntries`; `src/lib/atproto/tally.ts`; `lexicons/schellingpoint/draft/tally.json` |
| 5.6 | Auto-scheduler overlap computed on ballot tokens after close (checklist 14) | I | `vote_entries.ballot_token` survives the close; `schedulingInputs` (`rounds.ts:538`) returns token sets that never leave the server |
| 5.7 | Eligibility: ticket with `allows_voting` or membership; per-gathering credits (checklist 15) | I | `allocation.ts:66` `checkEligibility`, `:140` `budgetFor` (tier `vote_credits_override`, `event_members.vote_credits`) |
| 5.8 | Attendance round: fresh credits, `phase='attendance'`, slot ±15 min, closes at event end + 1 h (design §11, PRD §2.3) | I | migration `0026_attendance_voting.sql`, `src/lib/voting/attendance.ts`, tap-to-vote in `my-schedule/page.tsx`; `tests/attendance-voting.spec.ts` |
| 5.9 | Attendance round opens automatically at start | **M** | design §14 item 3 — `openAttendanceRound` is reachable only from the manual `live` transition (`settings/route.ts:437`); no status job |
| 5.10 | Organizer control to open / extend / force-close a round | **M** | there is no `POST/DELETE /api/v1/events/[slug]/rounds`; rounds open only as a lifecycle side effect and close only on `closes_at` via cron or a lazy sweep |
| 5.11 | Sybil resistance (spec §5.5) | P | membership + optional voting-tier ticket only; `ensurePublicMembership` auto-joins any signed-in account to a public gathering, so on a free gathering one custodial account is one ballot with no further proof. Sign-up rate limits (`0010_auth_abuse_controls.sql`) are the only other defence |
| 5.12 | Post-session feedback on the feedback-ballot machinery, unlinkable, k-suppressed (checklist 23) | I | `src/lib/voting/feedback.ts` (72 h window, `eventK`, `released:false` below k); `src/components/SessionFeedback.tsx` |
| 5.13 | Vote-milestone notifications (MT §6.2) | **O** | `src/lib/notifications/categories.ts:9-12` records the removal: a milestone is a live tally, forbidden by spec §5.3 |
| 5.14 | Publicly verifiable tally (`hash(sorted ballot tokens)`) | **O** | spec §5.6 names it a phase-2 item, not v1 (risk 7) |

### 6. Scheduling (spec §6; design §9; PRD §4.7)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 6.1 | Greedy seed scorer: duration, time preference, features, capacity, track spread, overlap, primary venue | I | `src/lib/scheduling/auto-scheduler.ts:161` `scoreSlot` — 8 terms including −50 for a pinned-elsewhere or format-disallowed room |
| 6.2 | Cost function per design §9.2: `Σ shared × (2 if ≥0.6 else 1)` + capacity penalty + violations ×1000 + imbalance ×0.1 | I | `src/lib/scheduling/objective.ts:193`, `COST_WEIGHTS:25`; "concurrent" is real interval overlap, not an identical time key |
| 6.3 | Hill-climb (moves + swaps), deterministic, 2 s budget, hand-placed sessions fixed | I | `src/lib/scheduling/improve.ts` (`budgetMs` 2000, `maxPasses` 50, id-sorted order) |
| 6.4 | Quality score `100 − 60·conflict − 25·overCapacity − 15·violations`, with checks and warnings | I | `src/lib/scheduling/quality.ts:74`; `NEAR_MISS_THRESHOLD = 0.4` |
| 6.5 | Audience clusters panel before running: keep-apart ≥60%, fine-together <20%, "not enough voters to compare" | I | `src/lib/scheduling/clusters.ts` (overlap coefficient, k-filter), `admin/audience-clusters/route.ts:43` (nulls `sharedVoters` below k), `src/components/admin/AudienceClusters.tsx` |
| 6.6 | Constraints: pinned venue, venue `allowed_formats`, host availability windows and blackouts | I | migration `0018_scheduling_constraints.sql`; `objective.ts:111` `constraintViolations`; room-format checkboxes in `admin/setup/page.tsx:410`; pin dropdown in `admin/schedule/page.tsx:144` |
| 6.7 | Drag-and-drop with live revalidation and a server-recomputed score | I | `admin/schedule/page.tsx:842` drop targets; `admin/schedule-quality/route.ts` POSTs a draft; `src/components/admin/ScheduleQuality.tsx` |
| 6.8 | Undo / redo / reset day | I | `admin/schedule/page.tsx:432` with Cmd/Ctrl-Z; "Clear day" in an overflow menu |
| 6.9 | Five-stage run progress and a reviewable preview before applying (PRD §4.7 step 5) | I | `GET admin/auto-schedule` returns `stages`, `quality`, `improvement`; `src/components/admin/AutoScheduleRun.tsx` |
| 6.10 | Warnings: over capacity, empty room in a used time row, near-miss pairs, double-booking | I | `quality.ts:93`; per-session `Keep apart: N% voter overlap with "…"` in `auto-scheduler.ts:374` |
| 6.11 | Venues, tracks, time slots CRUD + bulk slot generation | I | `admin/{venues,tracks,time-slots}` routes; `src/components/admin/BulkSlotGenerator.tsx`; `admin/tracks/page.tsx` with drag-reorder |
| 6.12 | One overlap metric across seed, objective, clusters and quality | P | **defect**: `auto-scheduler.ts:146 tokenOverlap()` is Jaccard (`∩/∪`) and applies no k-filter, while `clusters.ts:47` uses the overlap coefficient `∩/min` that design §9.2 mandates. The greedy seed therefore ranks pairs on a different metric from the objective it is then optimized against |
| 6.13 | Unpublished schedule work separated from the published one (spec §6 step 1) | I | implemented as `sessions.published_slot_id` vs `time_slot_id` rather than the spec's `sp_schedule_draft` table; `publish-schedule/route.ts:36` `classify()` diffs them into added/moved/removed. Same guarantee, different shape |

### 7. Publishing, interop and the gathering feed (spec §6, §10; design §7; checklist 16–21, 27–31)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 7.1 | Publish: canonical `community.lexicon.calendar.event` + `coop.lexicon.event.config` + `schellingpoint.draft.slot`, deterministic rkeys, CAS, one audit row per record (checklist 16) | I | `src/lib/atproto/publish.ts:1219` `publishSchedule` (3-phase batches of 25); `putWithCas`; `at_audit` |
| 7.2 | Moving/cancelling a published session is destructive: `destructiveActionStewards` approvals as `freeschool.draft.approval` in each approver's own repo; move writes `supersedes`; cancel uses the base lexicon's `#cancelled`; a proposal is never deleted (checklist 17) | I | `src/lib/atproto/approvals.ts`; `publish.ts:1247` returns `skipped: 'requires-approval'`; `tests/atproto-publish.spec.ts:102` |
| 7.3 | cid drift and proposal withdrawal surfaced to organizers (checklist 18) | I | `src/lib/atproto/drift.ts` (one notification per new cid), `admin/atproto/page.tsx#drift` with "Adopt and re-publish" |
| 7.4 | Listing routing by tag intersection, `peers` registry, outward cross-listing off until enabled (checklist 19) | I | `src/lib/atproto/listings.ts`; admin "Peers and listings" card (`admin/atproto/page.tsx:562`) |
| 7.5 | Role claims triple-gated: policy `publishRoles`, subject opt-in, role ≥ Host; deterministic rkey; retraction deletes (checklist 20) | I | `src/lib/atproto/role-claims.ts:103`; opt-in in `participants/me/role-claim.ts`; `sync-role-claims` admin action |
| 7.6 | Opt-in public RSVP record with the permanence sentence (checklist 21) | I | `rsvps/[sessionId]/route.ts` PUT `{public:true}` → `publicRsvpFor`; DELETE returns 502 if retraction fails |
| 7.7 | Recurring gatherings via `freeschool.draft.series` / `.occurrence` (checklist 31) | P | library + API exist (`src/lib/atproto/{series,recurrence}.ts`, admin actions `create-series` / `materialize-series`, `expandRecurrence` tested at `tests/atproto-records.spec.ts:439`) but **no UI** — zero hits for "series" in `admin/atproto/page.tsx`, so a series can only be created by hand-POSTing JSON |
| 7.8 | Jetstream consumer + hourly reconciliation | I | `scripts/atproto-indexer.ts` (monotonic cursor, backoff, no DIDs in logs); `src/app/api/atproto/sync/route.ts` `reconcileAll` |
| 7.9 | Resumable publish jobs with repo-write pacing and 429 backoff | I | `src/lib/atproto/publish-jobs.ts` (`for update skip locked`, 6 attempts, 10-min stale lock); `src/lib/atproto/rate-limit.ts`; `tests/atproto-protocol.spec.ts` |
| 7.10 | PDS announces to the relay (checklist 28) | I | `PDS_CRAWLERS=https://bsky.network` in `deploy/unconference/compose.yml:52` and `.env.example:26` |
| 7.11 | Privacy audit: no foreign DID, no DID column on votes, no key past close, no scoped row without `event_id`, no host name in public records (checklist 27) | I | `scripts/atproto-privacy-audit.ts` (9 checks incl. venue geo and feed mentions); run by `deploy/unconference/release.sh:39` |
| 7.12 | No browser DB access; every write through `/api/*`; tenant isolation on every scoped query (checklist 25) | I | `grep supabase src` empty; `assertSameOrigin` + `requireViewer`/`requireEventRole` convention; `tests/security.spec.ts` |
| 7.13 | Retention jobs (checklist 26) | I | `src/lib/notifications/retention.ts` — 9 rules; driven daily by the compose scheduler |
| 7.14 | Backups: nightly encrypted Postgres + PDS, retention-capped, keys off-box, restore drill documented (checklist 29) | I | `deploy/unconference/backup.sh`, `backup.Dockerfile`, README "Restore rehearsal" |
| 7.15 | Health endpoint and release gate (checklist 30) | I | `src/app/api/health/route.ts`; `deploy/unconference/release.sh` |
| 7.16 | Gathering feed: profile record + activity posts, consent-gated mentions, idempotent, audited (design §7) | I | migration `0022_feed.sql`; `src/lib/atproto/feed.ts` (8 post kinds incl. the digest); consent set computed inside the port (`actor.ts:414`); admin Feed card with retry |
| 7.17 | A UI for `delete-post` | **M** | design §14 item 2 — `deleteFeedPost` (`feed.ts:607`) has no caller; the feed route accepts only `retry` and `deliver` |
| 7.18 | Feed link card carries the gathering thumb (design §7.3) | **M** | `feed.ts:222` builds `app.bsky.embed.external` with uri/title/description only — blocked on the blob path (1.11) |

### 8. Notifications and email (MT §6; spec §9; checklist 24)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 8.1 | Emission from application code at the action site; DB triggers removed; outbox dispatch (checklist 24) | I | `db/migrations/0003_notifications_outbox.sql:21` drops four triggers; `notify(sql, …)` → `emit_notifications`; `src/lib/notifications/dispatch.ts` (claim fence, per-recipient hourly cap, 6 outcomes) |
| 8.2 | The declared type set actually fires | P | 21 types in the DB CHECK, 20 in `categories.ts`; **17 have emitters**. Dead: `session_submitted`, `cohost_invited`, `cohost_declined`, `event_reminder` |
| 8.3 | Proposal-received confirmation to the proposer | **M** | `session_submitted` has no emitter; only organizers get `new_proposal` |
| 8.4 | Co-host invitation notification | **M** | see 4.3 |
| 8.5 | Co-host declined | **M** | see 4.4 |
| 8.6 | "Event published" / "Proposals now open" announcements | **M** | the lifecycle route emits `voting_opened` / `voting_closed` only; entering `published` or `proposals_open` notifies nobody (a feed post is written, which reaches Bluesky followers, not members) |
| 8.7 | "Event starting soon" (1 day, 1 hour) | **M** | `event_reminder` has no emitter and there is no reminder job in `src/app/api/jobs/` |
| 8.8 | Session unscheduled | **M** | no such type; only `session_cancelled` via the published-schedule approval flow |
| 8.9 | Event completed → feedback request | **M** | nearest is the transcript request, which reuses `admin_announcement` |
| 8.10 | Admin alerts: high-vote session not scheduled, schedule conflicts detected, capacity threshold reached | **M** | conflict detection exists in `quality.ts` but never produces a notification |
| 8.11 | Waitlist promotion notification (MT §12.4) | **M** | `promote_from_waitlist()` is a `SECURITY DEFINER` trigger with no `notify()` — promotion is silent |
| 8.12 | Preferences per category and per channel, per event or global | I | `src/lib/notifications/preferences.ts`, `settings/notifications/page.tsx` — note the spec's per-*type* granularity was reduced to 5 categories |
| 8.13 | Every category maps to at least one live type | P | `voting_updates` (`categories.ts:40`) maps to nothing since `vote_milestone` was removed — a visible toggle that controls nothing |
| 8.14 | Per-type email templates | P | one generic renderer (`notification-emails.ts:236`) plus a per-type CTA label map; two bespoke builders in use (`buildEventInvitationEmail`, `buildSessionScheduledEmail`); `buildSessionApprovedEmail` and `buildSessionRejectedEmail` are dead code |
| 8.15 | Digest (daily/weekly) | **M** | none; over-limit mail is *dropped* as `rate_limited` after 24 h (`dispatch.ts:126`) rather than batched |
| 8.16 | Unsubscribe link / `List-Unsubscribe` header | **M** | emails carry prose only; `src/lib/email/base-template.ts` has no unsubscribe URL |
| 8.17 | Push notifications | **M** | column + API field + UI switch exist; the switch is hard-disabled "(coming soon)" (`settings/notifications/page.tsx:27`); no transport |
| 8.18 | Batch approve/reject notifies co-hosts as the single-session path does | P | `sessions/batch/route.ts:98` notifies `host_id` only; `sessions/[id]/route.ts:210` includes co-hosts |
| 8.19 | Dispatch on a schedule | I | `deploy/unconference/compose.yml:173` — the `scheduler` service curls `/api/notifications/dispatch` every 5 minutes with `CRON_SECRET`. (`vercel.json` has no `crons`, but git deploys are disabled on this branch; Vercel is not the deploy target) |
| 8.20 | Organizer broadcast + session emails | I | `admin/broadcast/route.ts`, `admin/session-emails/route.ts`, `admin/communications/page.tsx` |
| 8.21 | Phishing guard on action URLs | I | `notificationLink()` (`notification-emails.ts:224`) drops foreign origins |

### 9. Invites and roles (spec §8; MT §5)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 9.1 | Six roles with a permission matrix enforced in TS, route guards and RLS | I | `src/lib/permissions.ts`; `public.event_role()`; `0006_organizer_admin.sql:76` |
| 9.2 | Role assignment and removal with a last-owner guard and no self-edit | I | `members/[userId]/route.ts` (409 on last owner, 403 on self); `admin/members/page.tsx` |
| 9.3 | Event invitations: email mode (single-use, in-app when the account exists) and link mode with `max_uses` CAS, 1–30 day expiry, revoke | I | `invitations/route.ts`, `invitations/[token]/accept/route.ts:71` compare-and-swap; `tests/members-api.spec.ts:116` proves concurrent accepts cannot exceed the cap |
| 9.4 | Private/draft gatherings answer 404 to non-members | I | `resolveEventForViewer` / `can_read_event`; `tests/members-api.spec.ts:108` |

### 10. Ticketing and payments (MT §10; `docs/STRIPE_ACTIVATION.md`)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 10.1 | Ticket tiers with pricing integrity and capacity guards | I | `admin/ticketing-settings/tiers/**`; migration `0015_ticket_pricing_integrity.sql` (currency allowlist, price immutable once sold, capacity ≥ confirmed + holds) |
| 10.2 | Entitlements: a ticket gates proposing, attending and voting | I | `0012_ticket_entitlements.sql` (`has_ticket_entitlement`, BEFORE INSERT triggers on `sessions` and `session_rsvps`), `0016` curated carve-out, `allows_voting` in `allocation.ts:80` |
| 10.3 | Connect onboarding: Accounts v2, hosted onboarding, `fees_collector: stripe`, `losses_collector: stripe` | P | Express (Accounts v1) with hosted onboarding and readiness checks (`stripe.ts:200`, `:246`); **no** `fees_collector`/`losses_collector` anywhere. `STRIPE_ACTIVATION.md` step 1 unmet |
| 10.4 | Direct charges created in the connected account's API context, `application_fee_amount` without `transfer_data` | **M** | `stripe.ts:104` sets **both** `application_fee_amount` and `transfer_data.destination` (destination charges on the platform); `{ stripeAccount }` appears nowhere in the repo, including `sessions.retrieve`/`expire`. Step 2 unmet |
| 10.5 | Immutable private checkout reference binding session, connected account, event, tier, holder, price, currency, contribution | **M** | no such table; only a mutable ticket-row snapshot (`0014_platform_contributions.sql`) plus the mutable `events.stripe_account_id`, which the doc explicitly rejects. Step 3 unmet |
| 10.6 | Settlement verifies the event account and session against the application-created reference; never grants admission from metadata alone | **M** | amount/currency are checked against the quote (`tickets/index.ts:481`) but ids come from webhook metadata, and when a swept hold is gone a confirmed ticket is **created from metadata alone** (`index.ts:501`). No cross-account rejection. Step 3 unmet |
| 10.7 | Webhook signature verification and semantic idempotency | I | `constructWebhookEvent`; advisory lock on the payment intent, refund fingerprints, out-of-order and duplicate handling (`index.ts:414`, `:439`, `:476`) |
| 10.8 | Stripe event-id dedupe ledger; `event.livemode` check | **M** | no event-id ledger; one `STRIPE_WEBHOOK_SECRET`, no live/sandbox separation, no restricted keys. Step 5 unmet |
| 10.9 | Connect webhooks (`account.updated`) | **M** | the only handled events are five `checkout.session.*`/`charge.refunded`; readiness is polled on demand |
| 10.10 | Refund handling: full refund revokes admission, replay-proof | I | `charge.refunded` → `refunded_payments` SHA-256 fingerprints (`0017_refund_fingerprints.sql`); `tests/ticket-audit.spec.ts` cases 4–5 |
| 10.11 | App-initiated refunds, partial refunds, application-fee refund/reversal | **M** | `stripe.refunds.*` appears nowhere; the revenue page tells organizers to refund in the Stripe dashboard. Step 6 unmet |
| 10.12 | Revenue page reports platform profit, distinguishing contribution from processing fees | **M** | `ticketing-settings/revenue/route.ts` reports `sum(platform_fee_cents)` as platform revenue and `gross − contribution` as organizer net; under destination charges Stripe's fee is debited from the *platform*, so both figures are wrong. Named verbatim in `STRIPE_ACTIVATION.md:13` |
| 10.13 | Hold expiry and sweep | I | lazy `hold_expires_at > now()` predicates plus the `ticket_holds_expired` retention rule, run daily by the compose scheduler |
| 10.14 | Degradation without Stripe | I | 503 `Payments are not configured` / `NO_PAYOUT_ACCOUNT` / `PAYOUT_SETUP_REQUIRED`; free tiers work end to end |
| 10.15 | Crypto ticket payments (MT §10.1) | **O** | not carried onto this branch; design §0 non-goals put on-chain work out of scope |
| 10.16 | Revenue distribution contract, treasury, payouts (MT §10.2; PRD §2.4, §4.8) | **O** | design §0 "Non-goals … on-chain budget distribution"; design §12 decision 6 "no payouts"; MT appendix "Why Build Smart Contracts Later" |
| 10.17 | NFT gating (PRD §4.1, §5.3) | **O** | design §0 non-goals |
| 10.18 | Burner cards / NFC readers (PRD §4.5, §4.6, §5.1 hardware layer) | **O** | design §0 "burner cards (PRD Phase 2/3 hardware)" |

### 11. Check-in (MT §12.14; PRD §4.5)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 11.1 | QR ticket (short-TTL JWT bound to the holder's DID), camera scanner, manual code entry | I | `src/lib/tickets/qr.ts` (15-min HS256, `aud: ticket-checkin`), `src/components/QRScanner.tsx`, `admin/checkin/page.tsx`; `WRONG_HOLDER` / `WRONG_EVENT` guards |
| 11.2 | Check-in stats; times reduced to counts at 90 days | I | `GET /checkin` → `{total, checkedIn, pending}`; retention rule `ticket_checkins_to_counts_90d` |
| 11.3 | Offline check-in against a pre-downloaded list (MT §12.7) | **M** | no service worker, no local queue, no cached roster; every scan is a live POST |
| 11.4 | Check-in gate on voting (MT §12.14) | **M** | attendance eligibility is membership + ticket, never `checked_in` |

### 12. RSVP, waitlist, capacity (MT §12.3, §12.4)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 12.1 | Session RSVP with venue-derived capacity, waitlist positions, automatic promotion | I | `0005_session_participation.sql` — `assign_rsvp_status()` and `promote_from_waitlist()` (`SECURITY DEFINER`, pinned `search_path`) |
| 12.2 | Capacity indicators ("23 / 50 spots claimed") | I | `src/components/RSVPButton.tsx` with `capacity`/`rsvpCount`/`waitlistCount`; read model exposes `my_rsvp.waitlist_position` |
| 12.3 | Notification on promotion from the waitlist | **M** | see 8.11 |
| 12.4 | Event-level waitlist / `max_attendees` | **M** | capacity exists per ticket tier and per venue; there is no gathering-level attendee cap or waitlist |

### 13. Calendar (MT §12.8)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 13.1 | Per-session and full-schedule `.ics`, plus favourites-only | I | `src/lib/calendar/ics.ts` (RFC 5545 folding/escaping); `calendar/route.ts?favorites=true` |
| 13.2 | Google / Outlook / Yahoo deep links | I | `ics.ts:176,200,226`; `src/components/AddToCalendar.tsx` |
| 13.3 | Subscribable calendar URL that updates as the schedule changes | **M** | no `webcal`, no `REFRESH-INTERVAL`, no subscription route — exports are one-shot downloads |
| 13.4 | Calendar reminders 15 minutes before a session | **M** | no `VALARM` in the ICS builder |

### 14. Feedback and resources (MT §12.12, §12.13)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 14.1 | Post-session feedback: rating + comment, anonymous even to organizers, k-suppressed summary, 72 h window | I | `src/lib/voting/feedback.ts:356`; `src/components/SessionFeedback.tsx` |
| 14.2 | Session resources (slides, recording, notes, link, repo) with reorder | I | `sessions/[id]/resources/route.ts`; `src/components/SessionResources.tsx` — `added_by` is never returned |

### 15. Analytics (MT §7.4)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 15.1 | Organizer analytics: proposals by status/format/track, members by role, slot and per-venue utilization, voting results (sealed while open), attendance with k-suppression | I | `admin/overview/analytics/route.ts:134`; `admin/analytics/page.tsx` |
| 15.2 | Export / downloadable report | **M** | the dead Export button was removed in the polish wave (design §3); nothing replaced it |
| 15.3 | Host-facing analytics for their own session (PRD §3.2) | P | a host sees the k-suppressed feedback summary and the public tally; there is no per-session host dashboard |

### 16. Map (design §8)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 16.1 | Venue lat/lng, `events.map`, self-hosted exact + `public_geo` coarse, `geocode_cache` | I | migration `0023_map.sql`; `src/lib/geo/coarse.ts` (2 dp ≈ 1.1 km); tiering in `sessions/_lib/read.ts:298,365`; privacy-audit check 9 |
| 16.2 | Geocoding through `safeFetch` with caching and per-account rate limits; keyless tiles | I | `admin/geocode/route.ts`, `src/lib/geo/geocode.ts` (30-day cache, 30/hour, 1 req/s); `NEXT_PUBLIC_MAP_STYLE_URL` → OpenFreeMap liberty |
| 16.3 | Organizer map setup and participant map page with day tabs, Now/Next, near-me, directions | I | `src/components/map/VenueMapEditor.tsx`, `src/app/e/[slug]/map/{page,MapPageClient}.tsx`, `src/lib/geo/directions.ts` |

### 17. Knowledge harvest and MCP (design §10; PRD §6)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 17.1 | Transcripts: upload/paste, consent checkbox, members/organizers visibility, replace-and-retain-30-days, never a record | I | migration `0024_knowledge.sql`; `sessions/[id]/transcript/route.ts`; `src/components/knowledge/TranscriptPanel.tsx` |
| 17.2 | Coverage page and "request transcripts" with a 24 h throttle | I | `knowledge/coverage/route.ts`; migration `0027_transcript_requests.sql` |
| 17.3 | Corpus export: `.zip` with `corpus.jsonl`, `sessions.json`, `README.md`, raw markdown; ~3200-char chunks with 15% overlap; logged | I | `src/lib/knowledge/{export,chunk}.ts`; `knowledge_exports` |
| 17.4 | Embeddings with a provider-agnostic adapter; local by default | I | `src/lib/knowledge/embeddings.ts:49` (`Xenova/bge-small-en-v1.5` default, voyage/openai opt-in); `real[]` column, cosine ranked in-app per design §12 decision 5 |
| 17.5 | "Ask the gathering": top-8 event-scoped chunks, streamed answer with `[Session · mm:ss]` citations | I | `src/lib/knowledge/ask.ts`; `src/components/knowledge/AskPanel.tsx`; `/e/[slug]/ask` |
| 17.6 | Summaries and themes are editable (design §10.3) | P | generation only — `knowledge/summaries/route.ts` exposes `POST` alone; no PATCH for `session_transcripts.summary`, and `events.themes` renders read-only in `admin/knowledge/page.tsx` |
| 17.7 | `/e/[slug]/ask` discoverable by members | **M** | not in `getNavItems` (`DashboardLayout.tsx:40`); only a breadcrumb label plus links from the admin Knowledge page and the transcript panel |
| 17.8 | Read-only MCP server with personal assistant tokens | I | `src/lib/mcp/**` (7 tools + a schedule resource), `src/app/api/mcp/route.ts`, migration `0028_assistant_tokens.sql`, `/help/assistants` |
| 17.9 | Automated transcription (PRD §6.1: audio → Whisper → store) | **M** | design §10.1 scopes transcripts to upload/paste; no ASR pipeline exists. Record this as a scope decision if that is the intent — it is currently implicit |

### 18. Discovery and platform surface (MT §11; §12.16, §12.17)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 18.1 | Public keyless read API over published records | I | `/api/v1/{schedule,tracks,venues,timeslots}` gated by `resolvePublicEvent`; `docs/api-guide.md`; `/api/v1/profiles*` returns 410 Gone |
| 18.2 | Legacy `x-api-key` retired everywhere | P | `/api/v1/sessions` and `/api/v1/sessions/[id]` still accept `x-api-key` via `validateApiKey` (marked `@deprecated` in `src/lib/api/auth.ts:73`) — two auth regimes coexist under `/api/v1` |
| 18.3 | Event discovery hub: featured, filters, search, categories, geographic view (MT §11.1) | P | `src/app/events/page.tsx` is a 145-line upcoming/past list; no search, filters, categories or map |
| 18.4 | Cross-event identity and reputation (MT §11.2) | P | one global profile plus `/api/v1/members/[did]` (404 without a shared gathering, per spec §8); no "sessions hosted / votes received" history |
| 18.5 | Platform admin dashboard (MT §11.4) | **O** | design §0 "Non-goals … multi-tenant platform admin" |
| 18.6 | Embeddable widgets (MT §11.5) | **M** | no `/embed` route, no iframe or web component, no oEmbed |
| 18.7 | Outgoing webhooks, Slack/Discord/Zapier, per-event API tokens (MT §12.16) | **M** | the only webhook is inbound Stripe; the only tokens are personal MCP tokens, scoped to an account not an event |
| 18.8 | "Similar sessions" / topic clustering (MT §12.17) | **M** | interest-overlap suggestions exist (19.4) but no session-to-session similarity |

### 19. Moderation, trust and community (MT §12.5, §12.19; design §6)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 19.1 | Upstream takedown/suspension honoured as authoritative | I | `src/lib/atproto/repo-status.ts:39`; migration `0011_repo_status.sql`; `tests/atproto-protocol.spec.ts` |
| 19.2 | Organizer listing removal with a written reason, two-steward approval and an audit row | I | `src/lib/atproto/listings.ts:177`, `approvals.ts:502`, `at_audit` |
| 19.3 | Code of conduct, terms, privacy pages | I | `src/app/{codeofconduct,terms,privacy}/page.tsx`, allowlisted in `src/middleware.ts` |
| 19.4 | "People who share your interests" and "Suggested for you" (design §6) | I | server-computed for the viewer from interest overlap; votes are never an input |
| 19.5 | Report / flag a session, person or gathering (MT §12.5) | **M** | no report button, table or route anywhere in `src/` |
| 19.6 | Organizer / platform moderation queue (spec §9 `sp_moderation_queue`) | **M** | the audit trail exists; a case file, reason store and queue do not |
| 19.7 | Trust scores from history (MT §12.5) | **M** | none |
| 19.8 | Labeler subscription / `com.atproto.label` consumption | **M** | `lexicons/atproto/com.atproto.{label,moderation}.defs.json` are vendored only to close the `app.bsky.feed.post` ref graph (`lexicons/vendor/README.md:89`); nothing reads or writes them. Note: `src/lib/labels.ts` is the UI status vocabulary, unrelated |
| 19.9 | Per-event code of conduct / terms with acceptance on registration (MT §12.19) | **M** | the three pages are global; no per-event document, no acceptance record |

### 20. Privacy, retention, compliance (spec §9; MT §12.6)

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 20.1 | Retention: ledger gone at close, inviter nulled at 30 days, check-ins to counts at 90 days, notifications 90 days, sessions/tokens expired, payment ids dropped at archival | I | `src/lib/notifications/retention.ts` — 9 rules; `tests/notifications.spec.ts:205` |
| 20.2 | Privacy audit in the release gate | I | `npm run atproto:audit`; `deploy/unconference/release.sh:39` |
| 20.3 | Account deletion (cascade, votes already anonymous) | **M** | `deleteAccount` exists (`src/lib/auth/pds.ts:109`) but is called only to delete a *gathering's* identity; a member cannot delete their own account. Already flagged in `docs/design/audits/2026-09-21-settings-wizard-audit.md:178` |
| 20.4 | Personal data export (DSAR) | **M** | the only export is the organizer corpus zip. Partial mitigation by design: a person's records live in their own repo and are portable |
| 20.5 | Cookie consent | **M** | no analytics are loaded, so the exposure is nil today; record the decision if that is the intent |
| 20.6 | Per-event privacy policy (MT §12.6) | **M** | one global page |

### 21. Cross-cutting

| # | Requirement | Status | Evidence |
|---|---|:-:|---|
| 21.1 | Rate limiting and abuse controls | I | `0010_auth_abuse_controls.sql` (per-email, HMAC-ed per-IP, global mint caps), `src/lib/auth/client-ip.ts` (`TRUST_PROXY` required), `src/lib/atproto/rate-limit.ts` (429 backoff + per-repo write gate), `src/lib/mcp/rate-limit.ts` |
| 21.2 | SSRF-safe server-side fetch for DID/handle-derived URLs | I | `src/lib/net/safe-fetch.ts` with a `BlockList` over private/reserved ranges |
| 21.3 | Search within a gathering (MT §12.17) | P | sessions: server-side `ILIKE` over title/description/host/tags (`sessions/_lib/read.ts:287`) — no tsvector, no trigram index, no ranking. Participants: client-side filtering of an already-fetched array. No cross-gathering search |
| 21.4 | Timezone: UTC storage, IANA event timezone, `Intl` rendering, DST-correct day boundaries (MT §12.2) | I | `src/lib/events/{timezone,dates}.ts`; DST boundaries unit-tested in `tests/ux-logic.spec.ts`. Caveat: zone math is hand-rolled on `Intl`; `date-fns-tz` is not a dependency, so DST-ambiguous local times in `parseTimeInTimezone` are worth a look |
| 21.5 | Accessibility basics (MT §12.9) | P | good primitives — `aria-*` across 114 files, 44 `focus-visible` usages, `role="status"`/`aria-live` on async regions, one `prefers-reduced-motion` block (`globals.css:169`), contrast helpers unit-tested. But the skip link exists only on the two workspace shells (`admin/layout.tsx:103`, `DashboardLayout.tsx:196`), not on public pages or `/create`, and there are **no automated a11y assertions** (no axe, no `@axe-core/playwright`) |
| 21.6 | Mobile (MT §12.10) | I | Tailwind breakpoints throughout, mobile top bar + breadcrumb, schedule builder offers tap-to-pick placement alongside drag, `sr-only sm:not-sr-only` label patterns |
| 21.7 | PWA, offline schedule, add-to-home (MT §12.7, §12.10) | **M** | no `manifest.json`, no service worker, no `next-pwa`/`serwist`, no `manifest`/`themeColor`/`appleWebApp` in `src/app/layout.tsx` |
| 21.8 | i18n (MT §12.15) | **O** | design §0 non-goals |
| 21.9 | One design system: `labels.ts` vocabulary, `PageHeader`, ui primitives, toast feedback (design §2–§6) | I | `src/lib/labels.ts`, `src/components/ui/*` (23 primitives incl. select, switch, segmented-control, confirm-inline, dialog), `src/components/PageHeader.tsx` |

### Test and release posture

29 spec files under `tests/`, 28 wired into `npm test`; heavily integration-biased against a real local stack (Postgres :55432, mock PLC :2582, dev PDS :2583, dev server :3001) plus `tests/sql/*.sql`. Gates: `typecheck`, `lexicons:validate`, `build`, `test`, `test:sql`, `atproto:audit`.

Untested areas worth noting: publish-job resumption and rate-limit re-queue, `drift.ts`, the schedule builder's undo/redo stack, `tally.ts` end to end, the Stripe Connect route, the webhook HTTP layer, the check-in route and QR minting, the revenue API, and accessibility. `tests/backup-failure.py` is orphaned (no npm script references it).

---

## (c) Prioritized gap list

### P1 — blocks a real gathering end to end

Everything here except P1-6 and P1-7 is the payments cluster. That is accurate: **the free path works; the paid path cannot go live.** Per the working-tree caveat above, P1-1 and P1-2 appear largely written but uncommitted, and P1-5 has been reframed rather than solved; the sketches below are kept so the requirement is legible independently of that in-flight change, with a status note on each.

| # | Gap | One-line sketch | Files |
|---|---|---|---|
| P1-1 | *(uncommitted work appears to address this)* **Destination charges make the platform pay Stripe's fees** — a 1% contribution can be a net loss, and `STRIPE_ACTIVATION.md` holds activation on this | Create the Checkout Session in the connected account's context (`{ stripeAccount }` on create/retrieve/expire), pass `application_fee_amount` **without** `transfer_data`; move new merchants to Accounts v2 hosted onboarding with `fees_collector: stripe`, `losses_collector: stripe`; keep pre-existing platform-scoped sessions working | `src/lib/payments/stripe.ts` (`:43-112` params, `:200-238` account create/link), `src/app/api/v1/events/[slug]/checkout/route.ts`, `src/lib/tickets/index.ts:322` |
| P1-2 | *(uncommitted work appears to address this — `0029_checkout_references.sql`, `src/lib/payments/{references,webhook}.ts`)* **No immutable checkout reference; settlement trusts webhook metadata** — a connected merchant can mint its own session with our metadata shape, and a swept hold lets a confirmed ticket be created from metadata alone | New server-only table `checkout_references(session_id pk, stripe_account_id, event_id, tier_id, holder_id, price_cents, currency, contribution_cents, created_at)` written before redirecting; settlement looks the row up by session id, verifies the delivering account matches, and refuses otherwise; reconcile retention with the hold sweep | new `db/migrations/0029_*.sql`, `src/lib/tickets/index.ts:402-512`, `src/app/api/webhooks/stripe/route.ts:24-33` |
| P1-3 | **No Connect webhook handling, no live/sandbox separation, no event-id dedupe** *(the uncommitted work adds the `livemode` guard; `account.updated` and the dedupe ledger are still open)* | Add `account.updated` → cache capability state; split `STRIPE_WEBHOOK_SECRET` into sandbox/live with dedicated restricted keys and reject on `event.livemode` mismatch; add a `stripe_events(id pk, received_at)` ledger checked first | `src/app/api/webhooks/stripe/route.ts`, `src/lib/payments/stripe.ts:150-160`, `deploy/unconference/.env.example`, `deploy/unconference/README.md` |
| P1-4 | **No refund path in the product** — only a full `charge.refunded` arriving from the dashboard is honoured; partial refunds and the application fee are unhandled. *(The uncommitted work adds a `createRefund` helper with `refund_application_fee` but no caller, and the revenue copy deliberately directs organizers to their own Stripe dashboard — coherent under direct charges, so confirm whether this stays a non-goal.)* | Organizer-initiated refund action on the revenue/ticket admin page calling `refunds.create` in the connected-account context with `refund_application_fee` / reversal; handle partial `charge.refunded` by amount and revoke only on full | `src/app/e/[slug]/admin/revenue/page.tsx`, new `admin/refunds/route.ts`, `src/lib/payments/stripe.ts`, `src/lib/tickets/index.ts` |
| P1-5 | **Revenue page reports the wrong number** — application fees are shown as platform revenue and "net to you" excludes processing fees the organizer will actually pay once P1-1 lands. *(The uncommitted work reframes rather than computes: `processingFeesKnown: false` and net labelled "before Stripe processing fees". Honest, but an organizer still cannot see true net in-product.)* | Read balance-transaction fees per charge in the connected account's context, or keep the disclosure and link organizers to their Stripe balance report; label contribution vs processing separately either way | `src/app/api/v1/events/[slug]/admin/ticketing-settings/revenue/route.ts`, `src/app/e/[slug]/admin/revenue/page.tsx` |
| P1-6 | **Attendance voting depends on an organizer clicking `live` at the right minute** — miss it and the PRD's second voting phase never runs | A `/api/jobs/status` route on the minute loop that advances timestamp-driven transitions (at minimum: open the attendance round at `start_date` when `attendance_voting_enabled`), reusing `openAttendanceRound` and the lifecycle guards | new `src/app/api/jobs/status/route.ts`, `src/lib/events/lifecycle.ts`, `src/lib/voting/attendance.ts`, `deploy/unconference/compose.yml:169` |
| P1-7 | **This release has not shipped** (design §14 item 4) | Run the gate, deploy with `deploy/unconference/release.sh`, verify health/PDS/handle resolution, and record the release moment | `deploy/unconference/release.sh`, `README.md` |

### P2 — promised in the PRD/spec and feasible

**Notifications (the largest single cluster of promises).**

| # | Gap | Sketch | Files |
|---|---|---|---|
| P2-1 | Four declared notification types never fire (`session_submitted`, `cohost_invited`, `cohost_declined`, `event_reminder`) | Emit `session_submitted` at `POST /api/v1/sessions`; emit `cohost_invited` and send the invite email at invite creation; add a decline endpoint + `declined` status; add the reminder producer (below) | `src/app/api/v1/sessions/route.ts:143`, `src/app/api/sessions/[id]/invites/route.ts`, `src/app/api/invite/[token]/` (new `decline`), `db/migrations` (cohost status CHECK) |
| P2-2 | Co-host invites have no delivery channel — clipboard only | Send the invite by email (reuse `buildEventInvitationEmail`'s shape) and as an in-app notification when the address resolves to an account | `src/app/api/sessions/[id]/invites/route.ts`, `src/lib/email/notification-emails.ts`, `src/components/ManageCohostsSection.tsx:96` |
| P2-3 | No "event published" / "proposals now open" announcement | Emit at the lifecycle transition alongside the existing `voting_opened`; add the two types to the CHECK and `categories.ts` | `src/app/api/events/[eventId]/settings/route.ts:400-450`, `db/migrations/0003`-successor, `src/lib/notifications/categories.ts` |
| P2-4 | No "starting soon" reminder (1 day, 1 hour) | Reminder producer on the minute loop with a `sent` marker per (event, offset); emits `event_reminder` to members | new `src/app/api/jobs/status/route.ts` (share with P1-6), `src/lib/notifications/index.ts` |
| P2-5 | Waitlist promotion is silent | `notify()` from the promotion path — move `promote_from_waitlist` logic into the RSVP route's transaction, or add an app-side sweep, since spec §9 forbids notifying from triggers | `db/migrations/0005_session_participation.sql:76`, `src/app/api/v1/events/[slug]/rsvps/[sessionId]/route.ts` |
| P2-6 | Missing admin alerts: high-vote session unscheduled, conflicts detected, capacity threshold | Compute on the minute loop from `quality.ts` and `organizerResults` after a round closes; one notification per (event, kind, day) | `src/lib/scheduling/quality.ts`, new job route, `src/lib/notifications/categories.ts` |
| P2-7 | No unsubscribe link or `List-Unsubscribe` header | Signed per-recipient preference link in the footer of every non-transactional email plus the RFC 8058 header | `src/lib/email/base-template.ts`, `src/lib/email/notification-emails.ts:236`, `src/lib/notifications/dispatch.ts` |
| P2-8 | Over-limit email is dropped, not batched | Replace the `rate_limited` drop with a digest: group a recipient's pending rows into one email after the cap is hit | `src/lib/notifications/dispatch.ts:126-133`, `src/lib/email/notification-emails.ts` |
| P2-9 | `voting_updates` preference toggle controls nothing; two email builders are dead | Either map a live type into the category or remove it; wire or delete `buildSessionApprovedEmail`/`buildSessionRejectedEmail` | `src/lib/notifications/categories.ts:40`, `src/lib/email/notification-emails.ts:56,91` |
| P2-10 | Batch approve/reject notifies the host but not co-hosts | Reuse the recipient resolution from the single-session path | `src/app/api/v1/events/[slug]/sessions/batch/route.ts:98-145` |

**Proposals and scheduling.**

| # | Gap | Sketch | Files |
|---|---|---|---|
| P2-11 | `required_features` has no UI although the column, validator, record field and scheduler constraint all exist | Checkbox group (projector, whiteboard, audio, seating, other) on the propose form and the edit modal, sourced from the union of `venues.features` | `src/app/e/[slug]/propose/page.tsx`, `src/components/EditSessionModal.tsx`, `src/lib/sessions/constants.ts` |
| P2-12 | Per-person proposal quota is invisible until a `23514` | Return the remaining count from the gathering read model and show "2 of 5 proposals used" on the propose page | `src/app/api/v1/events/[slug]/me/route.ts`, `src/app/e/[slug]/propose/page.tsx` |
| P2-13 | Greedy seed uses Jaccard and skips the k-filter, contradicting design §9.2 | Replace `tokenOverlap` with `overlapCoefficient` from `clusters.ts` and consult the same k-filtered matrix the objective uses | `src/lib/scheduling/auto-scheduler.ts:146,252-271`, `src/lib/scheduling/clusters.ts` |
| P2-14 | No organizer control to open, extend or force-close a voting round | `POST/PATCH /api/v1/events/[slug]/rounds` (owner/admin) wrapping `openRound` and an explicit close, so scheduling is not hostage to `closes_at` | new `src/app/api/v1/events/[slug]/rounds/route.ts`, `src/lib/voting/rounds.ts` |
| P2-15 | Co-host conflict detection missing from the objective | Add a violation when two placed sessions sharing a host or accepted co-host overlap in time | `src/lib/scheduling/objective.ts:111`, `src/lib/scheduling/context.ts` |
| P2-16 | Session merger (PRD §4.4) does not exist | App-side merger request with accept/decline between two proposers; the merged session is a new proposal in one author's repo, the other withdraws theirs; votes are *not* transferred (the PRD's ×1.1 bonus cannot survive ballot-key unlinkability — state the deviation) | new `merge_requests` table, `src/app/api/v1/sessions/[id]/merge/**`, session detail UI |
| P2-17 | Automatic lifecycle transitions from configured timestamps (MT §12.1) | Fold into the P1-6 status job | `src/lib/events/lifecycle.ts`, new job route |

**Publishing, knowledge, identity.**

| # | Gap | Sketch | Files |
|---|---|---|---|
| P2-18 | Avatar blobs for the gathering's and custodial profile records (design §14 item 1) | Audited `uploadBlob` action on the port plus JSON→lex blob handling in `validate.ts`; unblocks feed link-card thumbs | `src/lib/atproto/{actor,validate,person-profile,publish,feed}.ts` |
| P2-19 | No `delete-post` UI (design §14 item 2) | Delete control on the admin Feed card routed through the two-organizer approval path, like move/cancel | `src/app/api/v1/events/[slug]/feed/route.ts:42-57`, `src/app/e/[slug]/admin/atproto/page.tsx:645`, `src/lib/atproto/feed.ts:607` |
| P2-20 | Recurring series has no UI (checklist 31) | A "Recurring" card on the Network page: frequency, interval, by-day, count/until, exdates, materialize-ahead, plus a materialize button | `src/app/e/[slug]/admin/atproto/page.tsx`, `src/app/api/v1/events/[slug]/admin/atproto/route.ts:206` |
| P2-21 | Summaries and themes are generate-only although design §10.3 says editable | `PATCH` on the transcript and event-themes routes, organizer-editable textareas | `src/app/api/v1/sessions/[id]/transcript/route.ts`, `src/app/api/v1/events/[slug]/knowledge/summaries/route.ts`, `src/app/e/[slug]/admin/knowledge/page.tsx` |
| P2-22 | `/e/[slug]/ask` is not in the member sidebar | Add a nav item, shown only when a provider is configured and transcripts exist | `src/components/DashboardLayout.tsx:40` |
| P2-23 | Legacy `x-api-key` still gates `/api/v1/sessions*` | Retire `validateApiKey` and its caller; the keyless public read API already covers the use | `src/app/api/v1/sessions/route.ts:30`, `src/app/api/v1/sessions/[id]/route.ts`, `src/lib/api/auth.ts:73` |

**Community, compliance, day-of reliability.**

| # | Gap | Sketch | Files |
|---|---|---|---|
| P2-24 | No report/flag flow for a public-by-default social app (MT §12.5) | Report control on session, person and gathering; `moderation_reports` (server-only, organizer-readable) + an organizer queue; enum-only public projection per spec §9 | new migration, `src/app/api/v1/events/[slug]/reports/**`, admin page |
| P2-25 | No account deletion and no personal data export (MT §12.6) | Account → Danger zone: export (JSON of app-side rows + a pointer to the repo CAR) and delete (cascade app-side, offer PDS account deletion or take-ownership first) | `src/app/account/page.tsx`, `src/components/SettingsModal.tsx`, new `src/app/api/me/{export,delete}/route.ts`, `src/lib/auth/pds.ts:109` |
| P2-26 | Per-event code of conduct / terms with acceptance (MT §12.19) | `events.code_of_conduct`/`terms` markdown + an acceptance row required on join; render in the utility layout | settings sections, `src/components/EventAccessGate.tsx`, new migration |
| P2-27 | No PWA shell or offline check-in (MT §12.7, §12.10) | `manifest.json` + icons + `themeColor`/`appleWebApp` metadata; a service worker caching the published schedule; check-in queues scans locally and replays (note the 15-min QR TTL forces a design choice — pre-downloaded roster + manual code, or longer-lived offline tokens) | `public/manifest.json`, `src/app/layout.tsx`, `src/app/e/[slug]/admin/checkin/page.tsx`, `src/lib/tickets/qr.ts` |
| P2-28 | No subscribable calendar feed or reminders (MT §12.8) | Signed per-person `webcal`/`.ics` route with `REFRESH-INTERVAL`, plus `VALARM -PT15M` on session events | `src/lib/calendar/ics.ts`, `src/app/api/v1/events/[slug]/calendar/route.ts` |
| P2-29 | Check-in does not gate voting (MT §12.14) | Optional per-gathering flag requiring `checked_in` for attendance-round eligibility | `src/lib/voting/allocation.ts:66`, Voting settings section |
| P2-30 | `/events` discovery is a bare list (MT §11.1) | Search, date/location filters, categories and a map view over the same public read model | `src/app/events/page.tsx`, `src/app/api/v1/` public reads |
| P2-31 | Event templates are orphaned code | Either restore a template step that seeds the wizard state or delete `src/lib/events/templates.ts` | `src/lib/events/templates.ts`, `src/app/create/**` |
| P2-32 | Search is `ILIKE` with no ranking; participants filter client-side | `tsvector` + GIN (or `pg_trgm`) on sessions with ranked ordering; move participant search server-side with pagination | `src/app/api/v1/sessions/_lib/read.ts:287`, `src/app/api/v1/events/[slug]/participants/route.ts`, new migration |
| P2-33 | No automated accessibility assertions; skip link only on workspace shells | Add `@axe-core/playwright` over ~10 key surfaces in the existing suite; add the skip link to the public and `/create` shells | `tests/`, `src/app/layout.tsx`, `src/app/create/page.tsx`, `src/components/SiteHeader.tsx` |
| P2-34 | Clone a gathering (MT §11.3) | "Duplicate" from an archived gathering that seeds the wizard with venues, tracks, slot shapes and team | `src/app/create/**`, `src/app/api/events/create/route.ts` |
| P2-35 | No host-facing per-session analytics (PRD §3.2) | A host panel on session detail: RSVP/waitlist counts, k-suppressed feedback, post-close tally entry | `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx`, `src/lib/voting/{feedback,rounds}.ts` |

### P3 — nice to have

| # | Gap | Sketch | Files |
|---|---|---|---|
| P3-1 | Embeddable schedule / session-list / propose widgets (MT §11.5) | Framed `/embed/[slug]/schedule` reading the keyless public API, with a CSP that permits framing only that path | new `src/app/embed/**`, `src/middleware.ts` |
| P3-2 | Outgoing webhooks and per-event API tokens (MT §12.16) | `event_webhooks` with HMAC-signed deliveries and retries; scope MCP-style tokens to an event | new migration + routes, `src/lib/mcp/tokens.ts` as the pattern |
| P3-3 | Event-level waitlist / `max_attendees` (MT §12.4) | Gathering capacity with a waitlist mirroring the session-level trigger | `db/migrations`, ticketing settings |
| P3-4 | "Similar sessions" and topic clustering (MT §12.17) | Reuse the embedding adapter over session titles/descriptions | `src/lib/knowledge/{embeddings,rank}.ts` |
| P3-5 | Analytics export / downloadable report | CSV of the analytics payload, organizer-only, logged like the corpus export | `src/app/api/v1/events/[slug]/admin/overview/analytics/route.ts` |
| P3-6 | Web push (the toggle is a stub) | VAPID subscriptions + a push branch in dispatch; depends on the PWA service worker (P2-27) | `src/lib/notifications/dispatch.ts`, `src/app/e/[slug]/settings/notifications/page.tsx:27` |
| P3-7 | Cross-event reputation (MT §11.2) | Derive "sessions hosted / gatherings attended" from records the person wrote; never from a gathering's roster | `src/app/api/v1/members/[did]/route.ts` |
| P3-8 | Automated transcription (PRD §6.1) | Optional ASR provider behind the same env gating as embeddings, writing into `session_transcripts` | `src/lib/knowledge/**`; or record it as out of scope in design §12 |
| P3-9 | Interactive quadratic-voting demo in onboarding (PRD §4.1) | A slide that lets a person spend fake credits and see the cost curve | `src/components/auth/OnboardingModal.tsx` |
| P3-10 | Trust scores (MT §12.5) | Deferred until the report flow (P2-24) produces signal | — |
| P3-11 | Cookie consent and a per-event privacy policy | Only needed if analytics are ever added; per-event policy is a settings field | `src/app/privacy/page.tsx` |
| P3-12 | MCP rate limit is per process | Move the window to Postgres if the app is ever replicated | `src/lib/mcp/rate-limit.ts:5-9` |
| P3-13 | Four source files contain literal NUL bytes and are invisible to `grep` | Replace with ` ` escapes | `src/components/SettingsModal.tsx`, `src/hooks/useVoting.tsx`, `src/lib/knowledge/normalize.ts`, `src/app/api/me/profile/validate.ts` |
| P3-14 | Directions has no Apple Maps branch; `date-fns-tz` absent for DST-ambiguous local times | Small correctness follow-ups | `src/lib/geo/directions.ts`, `src/lib/events/timezone.ts` |
| P3-15 | `tests/backup-failure.py` is orphaned | Wire it into a script or delete it | `tests/backup-failure.py`, `package.json` |

### Deliberately out of scope (with the decision cited)

| Item | Where it is recorded |
|---|---|
| On-chain budget distribution, treasury contract, payouts, claims (PRD §2.4, §4.8; MT §10.2) | release design §0 "Non-goals … on-chain budget distribution"; §12 decision 6 "no payouts"; MT appendix "Why Build Smart Contracts Later" |
| NFT gating (PRD §4.1, §5.3) | release design §0 |
| Burner cards and NFC readers (PRD §4.5, §4.6, §5.1 hardware layer) | release design §0 "burner cards (PRD Phase 2/3 hardware)" |
| Multi-tenant platform admin dashboard (MT §11.4) | release design §0 |
| i18n (MT §12.15) | release design §0 |
| Wallet sign-in door | spec §7 "There is no wallet door" |
| Vote-milestone notifications (MT §6.2) | `src/lib/notifications/categories.ts:9-12`, spec §5.3 |
| Publicly verifiable tally (`hash(ballot tokens)`) | spec §5.6 — phase 2, risk 7 |
| Crypto ticket payments (MT §10.1) | not carried onto this branch; follows from the on-chain non-goal |

Two of these are worth converting from implicit to explicit, because nothing currently records the decision: **automated transcription** (P3-8 / 17.9) and **cookie consent** (20.5).
