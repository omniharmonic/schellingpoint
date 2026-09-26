# unconference.events — AppView architecture and build plan

> Promoted to the official `main` application on 2026-09-26. Earlier references to the
> `atproto` branch describe the migration history. Production: https://unconference.events.

Decided 2026-09-14 with Benjamin: build the ATProto instance **to the migration spec**
(`docs/ATPROTO_MIGRATION_SPEC.md`) before deploying it: our own PDS, custodial email→DID
accounts, a Postgres AppView with server-side authorization, no browser database access,
and **no Supabase** in this instance. PDS hostname: `pds.unconference.events`; handles
`<name>.unconference.events`. Deploy target: the Hetzner box `frontrange-twin-1`
(`2.29.37.247`, shared with the Bioregional Twin) as its own compose project with its **own Caddy**;
neither Free School nor the Twin is modified. Firewall `unconference-fw` (80/tcp, 443/tcp, 443/udp)
is attached alongside the Twin's. Mail: Resend domain `unconference.events`.

This file is the contract every work package codes against. `docs/ATPROTO_IMPLEMENTATION.md`
describes the previous (Supabase-hosted) pass and is superseded where they disagree.

## 1. Target architecture

```
Caddy (this stack's own, ports 80/443 on frontrange-twin-1)
 ├─ unconference.events, www            → app:3000   (Next.js = the AppView + web)
 ├─ pds.unconference.events             → pds:3000   (reference PDS)
 └─ *.unconference.events               → /.well-known/atproto-did, /xrpc/* → pds
                                          everything else → app (gathering subdomains)
app      Next.js 15 server; Postgres via `postgres` (porsager); PDS via @atproto/api
pds      ghcr.io/bluesky-social/pds:0.4, invite-only, crawlers = bsky.network (firehose)
postgres postgres:16-alpine — the only database; app-side data lives here
indexer  Jetstream consumer (scripts/atproto-indexer.ts)
scheduler  curl loop: notifications dispatch (5 min), atproto reconcile (hourly),
           vote-round close sweep (1 min)
```

Trust boundaries (spec §3): the browser talks only to `/api/*` on the app origin with an
HttpOnly session cookie. No token reaches the browser. The database is reachable only from
the app, indexer and scheduler containers. Every write as a gathering goes through the
gathering actor port with an audit row. Nothing public names a DID its holder did not write.

## 2. Interpretations of the spec (stated, not silent)

| Spec | Here | Why |
|---|---|---|
| Hono AppView + Vite PWA | Next.js route handlers are the AppView; pages stay React server/client components | Same trust boundary, identical HTTP surface; avoids rewriting 35 working screens |
| `sp_*` tables keyed by `event_did` | existing tables (`events`, `sessions`, `event_members`, …) kept as the app-side store; `events.actor_did` is the gathering DID; accounts keyed by DID | table names are not the substance; DIDs are |
| `deriveRole()` from evidence | `event_members.role` kept as the *appointed-role evidence* (owner/admin/moderator/…); membership never published | organizer appointment is evidence in the spec too |
| Spaces shim | plain Postgres tables behind server code | the shim is a Phase-2 seam in the spec as well |
| contrail + subscribeRepos per peer | Jetstream consumer + `listRecords` reconciliation of our PDS and linked repos | our PDS announces to the relay, so Jetstream sees it |

Everything else is implemented as the spec says, including ballot-key voting (§5), custodial
accounts with take-ownership (§7), gathering DIDs minted on our PDS at creation (§8), k-suppressed
tallies, proposals in the proposer's repo, co-host double opt-in, opt-in public RSVPs.

## 3. Contracts

### 3.1 Database — `src/lib/db/index.ts` (server-only)

```ts
import type postgres from 'postgres'
export type Sql = postgres.Sql | postgres.TransactionSql
/** Service connection (table owner; RLS bypassed). Lazily created from DATABASE_URL. */
export const sql: postgres.Sql
/** Transaction helper. */
export function tx<T>(fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T>
/**
 * Run as a signed-in account so DB triggers/policies that call auth.uid() see it:
 * BEGIN; SET LOCAL ROLE authenticated; set_config('request.jwt.claims', '{"sub":id,"role":"authenticated"}', true)
 */
export function asAccount<T>(accountId: string, fn: (sql: postgres.TransactionSql) => Promise<T>): Promise<T>
/** Postgres error helpers: code '23505' unique, '23514' check/participation rule, '42501' privilege. */
export function pgErrorCode(e: unknown): string | null
/** Maps rule/unique/privilege errors to JSON responses (403/409/400); null for anything else. */
export function dbErrorResponse(e: unknown): Response | null
```

Rules: tagged-template SQL only (no string concatenation); `sql.json()` for jsonb; `sql(array)` for
`IN`; embedded relations become JOINs or `json_agg` subqueries; return plain objects with the
same field names the old PostgREST responses had so client code changes stay minimal.

Schema lives in `db/migrations/NNNN_name.sql`, applied by `scripts/db-migrate.mjs`
(`DATABASE_URL`, tracking table `public.app_migrations`). `0001_baseline.sql` is the full
schema of the previous pass minus Supabase-only objects, with these identity changes:

```sql
-- Supabase compatibility kept deliberately small: roles + auth.uid() read request.jwt.claims.
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claims', true)::jsonb->>'sub','')::uuid $$;

CREATE TABLE public.accounts (            -- replaces auth.users everywhere
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  did text UNIQUE NOT NULL,
  handle text,
  email text UNIQUE,                      -- lowercased; NULL for OAuth-only accounts
  kind text NOT NULL CHECK (kind IN ('custodial','oauth')),
  wrapped_password bytea,                 -- custodial only; AES-256-GCM (src/lib/atproto/crypto.ts)
  key_version text,
  email_verified_at timestamptz,
  owned_at timestamptz,                   -- set by take-ownership
  created_at timestamptz NOT NULL DEFAULT now()
);
-- profiles.id REFERENCES accounts(id) ON DELETE CASCADE; handle_new_user trigger moves to accounts.
CREATE TABLE public.auth_email_tokens (
  token_hash text PRIMARY KEY,            -- sha256 hex of the emailed token
  email text NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('signin','reveal')),
  next_path text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- at_sessions.kind CHECK becomes ('custodial','oauth'); at_sessions.user_id → accounts(id).
```

### 3.2 Identity — `src/lib/auth/*` (server-only)

```ts
// viewer.ts
export interface Viewer { accountId: string; did: string; handle: string | null; email: string | null; kind: 'custodial' | 'oauth'; sessionId: string }
export function getViewer(request?: Request): Promise<Viewer | null>        // sp_at_session cookie
export function requireViewer(request: Request): Promise<Viewer | Response>  // 401 {error:'Unauthorized'}
export function eventRole(eventId: string, accountId: string): Promise<EventRoleName | null>
export function requireEventRole(request: Request, slug: string, roles: readonly EventRoleName[]):
  Promise<{ viewer: Viewer; event: { id: string; slug: string; status: string; visibility: string; actor_did: string | null }; role: EventRoleName } | Response>
export function assertSameOrigin(request: Request): Response | null          // unsafe methods: Origin host must be the app host or a subdomain of it
// custody.ts — spec §7, ported from Free School apps/appview/src/lib/custody.ts
export function startEmailSignIn(email: string, nextPath: string): Promise<{ ok: true; devVerifyUrl?: string }>
export function verifyEmailToken(token: string): Promise<{ accountId: string; nextPath: string }>
export function mintCustodialAccount(email: string): Promise<{ accountId: string; did: string; handle: string }>
export function mintGatheringAccount(input: { slug: string; name: string; createdBy: string }): Promise<{ did: string; handle: string }>
export function takeOwnership(accountId: string): Promise<{ handle: string; revealUrl?: string }>
// pds.ts — admin + account XRPC against PDS_INTERNAL_URL
export function createInviteCode(uses?: number): Promise<string>
export function createAccount(i: { email?: string; handle: string; password: string; inviteCode: string }): Promise<{ did: string; handle: string }>
// handles.ts — generateHandle(domain), RESERVED_LABELS, isValidGatheringLabel(label)
```

`src/lib/api/getUser.ts` keeps `getUserFromRequest(request) → { id, email } | null` as a thin
wrapper over `getViewer` so unconverted routes keep compiling during the migration.

HTTP:
- `POST /api/auth/email {email, next}` → sign-in-or-sign-up magic link (`devVerifyUrl` only when mail is unconfigured)
- `GET /auth/verify?token=` → consumes token, sets cookie, redirects to `next`
- `GET /api/auth/me` → `{ user: {id, email, did, handle, kind} | null, profile: Profile | null }`
- `POST /api/auth/signout` → clears cookie and session row
- `POST /api/me/take-ownership`, `GET /api/me/reveal?token=` (single-use password reveal)
- Bluesky door: `GET /api/atproto/auth/start`, `GET /oauth/callback` (creates `accounts` row kind `oauth`)

### 3.3 Browser — `src/lib/api/client.ts`

```ts
export class ApiError extends Error { status: number; code?: string }
export function apiFetch<T = unknown>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>
```
Same-origin, `credentials: 'same-origin'`, JSON in/out, throws `ApiError` on non-2xx with the
server's `error` message. No `Authorization` headers, no `NEXT_PUBLIC_SUPABASE_*`, no
`getAccessToken`. `useAuth()` keeps its exported shape (`user`, `profile`, `isLoading`,
`isAdmin`, `needsOnboarding`, `signIn(email, returnTo)`, `signOut`, `refreshProfile`).

### 3.4 API conventions
- Mutations: `assertSameOrigin` then `requireViewer`/`requireEventRole`, then validate, then SQL.
- Errors: `{ error: string, code?: string, field?: string }` with 400/401/403/404/409/503.
- Event-scoped resources live under `/api/v1/events/[slug]/...`; every query filters by the
  resolved `event_id`. Private/draft events answer 404 to non-members.
- Participation rules still hold at the DB boundary: writes made on behalf of a person run in
  `asAccount(viewer.accountId, …)` so the existing triggers see `auth.uid()`.

## 4. Work packages

Wave 0 (foundation, parallel): **W0-DB** (baseline schema, migrator, `src/lib/db`, local stack:
Postgres + mock PLC + dev PDS) and **W0-ID** (`src/lib/auth`, auth routes, OAuth callback onto
`accounts`, `getUserFromRequest` shim, `apiFetch`, `useAuth`, login page).

Wave 1 (parallel, disjoint file ownership, each converts server SQL + client calls in its area):
A events/creation/settings/home · B sessions & participation · C ballot-key voting & dashboard ·
D organizer admin · E notifications, email, tickets & payments · F ATProto layer on our PDS ·
G profiles, participants, onboarding, partner API.

Wave 2: delete `@supabase/*`, `src/lib/supabase`, `supabase/`; tests against the local stack;
privacy audit; full review.

Wave 3: deploy (`deploy/unconference/`), DNS, Free School edge hook, end-to-end verification.

## 5. Verification gates
`npm run typecheck`, `npm run build`, `npm run lexicons:validate`, `npm test` against the local
stack, `npm run atproto:audit`, `grep -r "supabase" src` empty, then on the box: custodial
sign-up creates a DID on `pds.unconference.events` whose handle resolves; Bluesky sign-in works;
creating a gathering mints its DID; a proposal lands in the proposer's repo; publishing the
schedule writes calendar events visible on the relay/Jetstream; the tally is k-suppressed.

## 6. Spec compliance checklist (every item has an owner and a check)

| # | Spec § | Requirement | Owner | Check |
|---|---|---|---|---|
| 1 | 7 | Custodial door: email → PDS account, generated handle never from email, wrapped password, magic link | W0-ID | test creates DID on local PDS, handle resolves |
| 2 | 7 | Bluesky/ATProto door: confidential OAuth, DPoP, PAR, hard confirm (`confirmPublicLinkage`), profile import into empty fields only | W0-ID | confirm required; metadata confidential in prod |
| 3 | 7 | Take ownership: admin-side rotation, single-use reveal, custody ends | W0-ID | test |
| 4 | 3,7 | Neutral PDS host `pds.unconference.events`; reserved labels shared by handles and gathering subdomains | W0-ID, F | reserved-label test |
| 5 | 8 | Gathering = DID minted on our PDS at creation + `gathering@self` + `freeschool.draft.policy`; credential wrapped; per-gathering actor registry (LRU, TTL, evict on failure) | A, F | create event → DID resolves; records exist |
| 6 | 8 | Gathering subdomain `<slug>.unconference.events` serves the gathering; OAuth pinned to apex with origin carried in signed state; cookie `Domain=.unconference.events` | F, W0-ID | host routing test |
| 7 | 4.2 | Proposal in proposer's repo on creation (custodial: always; OAuth: after confirm); edits `putRecord` with CAS; withdrawal deletes | B, F | record in author's repo |
| 8 | 4.2 | Co-host double opt-in: invite app-side, acceptance writes `cohost` in co-host's repo; organizer cannot un-cohost | B, F | test |
| 9 | 4.2 | Time preference app-side by default, per-proposal opt-in publish (`timePreference`) | B, F | test |
| 10 | 4.2 | Endorsement record (not a vote, not counted) | B, F | test |
| 11 | 5 | Ballot-key voting: `vote_round`, `ballot`, `vote` (no DID column, `day` not timestamp, `ballot_token`), `credit_ledger`; server-enforced Σv² ≤ credits; allocation mutable while open | C | SQL + API tests |
| 12 | 5.3 | Tallies hidden while open (409 `RoundOpen`), **organizers see no counts mid-round**; `sessions.total_votes/voter_count/total_credits` never served publicly | C, D | API tests |
| 13 | 5.3 | Close: tokens = hmac(ballot_key, did), explode ledger into votes in randomized batches, delete ledger, NULL ballot_key, all in one transaction; k-suppressed tally written by gathering actor | C, F | close test; audit assertion |
| 14 | 5.4 | Auto-scheduler overlap computed on ballot tokens after close | C, D | test |
| 15 | 5.5 | Voting eligibility: ticket with `allows_voting` or invite/membership per gathering policy; per-gathering credits | C, E | test |
| 16 | 4.2, 6 | Schedule publish: calendar event + `coop.lexicon.event.config` + `slot` per session, deterministic rkeys, CAS, audit row per record | F | test with fake writer + live on box |
| 17 | 6 | Moving/cancelling a **published** session is destructive: requires `destructiveActionStewards` approvals written as `freeschool.draft.approval` in each approver's own repo; move writes new slot with `supersedes`, cancel sets base-lexicon `#cancelled`; never deletes a proposal | D, F | test |
| 18 | 6 | cid drift and proposal withdrawal surfaced to organizers ("proposer edited this; review and re-publish") | D, F | UI + ingest test |
| 19 | 6, 10 | Listing routing: `coop.lexicon.event.listing` (uri+cid) for sessions whose config tags intersect gathering tags; peers registry in `gathering.peers`; outward cross-listing off until an organizer enables it | F | test |
| 20 | 4.1, 10 | Role claims (`coop.lexicon.membership`) triple-gated: policy `publishRoles`, subject opt-in, role ≥ Host; deterministic rkey; retraction deletes | F, G | test |
| 21 | 4.1 | Opt-in public RSVP (`community.lexicon.calendar.rsvp`) with permanence sentence; default app-side | B, F | test |
| 22 | 4.1, 10 | Shared skill taxonomy: tracks carry skill URIs, proposals ≤ 5 skills, read from the Free School skills authority's records | B, F | picker loads skills |
| 23 | 4.1 | Post-session feedback on feedback-ballot machinery: unlinkable after window close, k-suppressed summary | C | test |
| 24 | 2, 6 | Notifications emitted from application code at the action site (DB notification triggers removed), outbox dispatch | E | test |
| 25 | 2 | No browser DB access; every write via `/api/*`; server-side authorization; tenant isolation on every scoped query | all | grep gate + isolation test script |
| 26 | 9 | Retention jobs: ledger gone at close; invite inviter nulled at 30 days; check-ins to counts at 90 days; notifications 90 days; session tokens expired | E, C | job tests |
| 27 | 9 | Privacy audit: no foreign DID in any record we wrote; `vote` has no DID column; no `ballot_key` after `closes_at`; no scoped row without `event_id`; no host name in public records | F | `npm run atproto:audit` in CI and on the box |
| 28 | 10 | PDS announces to the relay (`PDS_CRAWLERS=https://bsky.network`) — firehose | deploy | relay `getRepo`/Jetstream sees our DIDs |
| 29 | 12 | Backups: nightly Postgres dump + PDS volume tarball, retention-capped; PLC rotation key stored off-box | deploy | restore drill documented |
| 30 | 12 | Health endpoint and release gate (typecheck, build, lexicons, tests, audit) | deploy | release script |
| 31 | 4.1 | Recurring gatherings via `freeschool.draft.series`/`occurrence` | F (last) | test |

## 7. Wave 1 — ownership and cross-package contracts

### 7.1 File ownership (a file belongs to exactly one package; ask before touching another's)

| Pkg | Owns |
|---|---|
| **A** events core | `src/app/page.tsx`, `src/app/MyEventsSection.tsx`, `src/app/events/**`, `src/app/create/**`, `src/app/api/events/**`, `src/app/e/[slug]/page.tsx`, `src/app/e/[slug]/layout.tsx`, `src/app/e/[slug]/admin/settings/**`, `src/contexts/EventContext.tsx`, `src/lib/events/**`, `src/lib/storage/**`, NEW `src/app/api/uploads/**`, NEW `src/app/uploads/**`, NEW `src/app/api/health/route.ts`, NEW `src/middleware.ts` (gathering subdomain routing), `src/components/EventAccessGate.tsx`, `src/components/{SiteHeader,WorkspaceHeader,EventUtilityLayout,Footer}.tsx`, `tests/event-api.spec.ts`, `tests/creation-database.spec.ts`, migration `0007_*` |
| **B** sessions & participation | `src/app/e/[slug]/{sessions,propose,my-schedule,schedule}/**`, `src/components/{SessionCard,EditSessionModal,ManageCohostsSection,RSVPButton,SessionResources,AddToCalendar}.tsx`, `src/hooks/useTracks.tsx`, `src/app/invite/[token]/**`, `src/app/api/invite/**`, `src/app/api/sessions/[id]/{cohosts,invites}/**`, `src/app/api/v1/sessions/**`, `src/app/api/v1/events/[slug]/sessions/[id]/{calendar,resources}/**`, `src/app/api/v1/events/[slug]/calendar/**`, NEW `src/app/api/v1/events/[slug]/{sessions,favorites,rsvps,tracks}/**` (app read/write APIs, not partner), `src/lib/calendar/**`, migration `0005_*`, NEW `tests/sessions-api.spec.ts` |
| **C** voting & feedback ballots | `src/app/e/[slug]/{my-votes,dashboard}/**`, `src/components/DashboardLayout.tsx`, `src/components/SessionFeedback.tsx`, `src/app/api/v1/events/[slug]/sessions/[id]/feedback/**`, NEW `src/app/api/v1/events/[slug]/{rounds,votes}/**`, NEW `src/app/api/jobs/close-rounds/route.ts`, NEW `src/lib/voting/**`, NEW `src/hooks/useVoting.tsx`, NEW `src/components/VoteControl.tsx`, `src/lib/atproto/tally.ts`, migration `0002_*`, NEW `tests/voting.spec.ts` |
| **D** organizer admin | `src/app/e/[slug]/admin/{page.tsx,layout.tsx,schedule,setup,tracks,sessions,members,analytics,communications}/**`, `src/components/admin/**`, `src/app/api/v1/events/[slug]/admin/{auto-schedule,broadcast,publish-schedule,seed-sessions,session-emails,sessions}/**`, `src/app/api/v1/events/[slug]/sessions/batch/**`, `src/app/api/v1/events/[slug]/{invitations,members}/**`, `src/app/api/v1/invitations/**`, `src/app/invite/e/[token]/**`, `src/app/api/sessions/[id]/notify-host/**`, `src/lib/scheduling/**`, NEW `src/app/api/v1/events/[slug]/admin/{venues,time-slots,tracks,overview}/**`, migration `0006_*`, `tests/members-api.spec.ts` |
| **E** notifications, mail, tickets, retention | `src/hooks/{useNotifications,useNotificationPreferences}.ts`, `src/components/{NotificationBell,TicketQR,QRScanner}.tsx`, `src/app/e/[slug]/{notifications,settings,tickets,checkin}/**`, `src/app/e/[slug]/admin/{tickets,revenue}/**`, `src/app/api/notifications/**`, NEW `src/app/api/me/notifications/**`, NEW `src/app/api/jobs/retention/route.ts`, `src/app/api/v1/events/[slug]/{checkout,checkin,tickets}/**`, `src/app/api/v1/events/[slug]/admin/{ticketing-settings,stripe-connect}/**`, `src/app/api/webhooks/**`, `src/lib/{email,payments,tickets,notifications}/**`, migration `0003_*`, NEW `tests/notifications.spec.ts` |
| **F** ATProto layer | `src/lib/atproto/**` except `tally.ts` and the Wave-0 identity files (`session,oauth,agent,config,bridge,bsky-profile,crypto`), `src/app/api/atproto/{records,sync,skills}/**`, `src/app/api/v1/events/[slug]/admin/atproto/**`, `src/app/api/v1/events/[slug]/sessions/[id]/atproto/**`, NEW `src/app/api/v1/events/[slug]/approvals/**`, `src/app/e/[slug]/admin/atproto/**`, `src/components/AtprotoSessionActions.tsx`, NEW `src/components/{SkillPicker,TimePreferences}.tsx`, NEW `src/app/internal/tls-check/route.ts`, `scripts/atproto-*`, `lexicons/**`, migration `0004_*`, `tests/atproto-*.spec.ts` |
| **G** people & partner API | `src/app/e/[slug]/participants/**`, `src/components/auth/OnboardingModal.tsx`, `src/components/SettingsModal.tsx`, `src/app/api/v1/{profiles,tracks,venues,timeslots,schedule}/**`, `src/lib/api/auth.ts`, NEW `src/app/api/me/profile/**`, NEW `src/app/api/v1/events/[slug]/participants/**`, NEW `src/app/api/v1/members/[did]/**`, migration `0008_*`, NEW `tests/people-api.spec.ts` |

Shared and read-only for everyone: `src/lib/db`, `src/lib/auth/**`, `src/lib/api/{client,getUser,response,saved-rows}.ts`, `src/lib/permissions.ts`, `src/hooks/useAuth.tsx`, `src/types/**`, `src/components/ui/**`, `db/migrations/0001_baseline.sql`. Changes to these go through the coordinator.

### 7.2 Cross-package contracts

**Notifications (E owns, everyone calls)** — `import { notify } from '@/lib/notifications'`;
`notify(sql, { eventId, userIds, type, title, body?, actionUrl?, data? })` inside the transaction of the
action. E's `0003` drops every notification trigger (`trigger_new_proposal`, `trigger_session_status_change`,
`trigger_cohost_response`, `trigger_vote_milestone`) and extends the type CHECK with `proposal_changed`,
`approval_requested`, `event_invitation`, `ticket_confirmed`. Each package emits what its actions used to
trigger: B `new_proposal` (to organizers), `cohost_accepted`; D `session_approved/rejected/scheduled`,
`schedule_published`, `admin_announcement`, `event_invitation`; A `voting_opened`, `voting_closed`; F
`proposal_changed`, `approval_requested`, `session_rescheduled/cancelled`; E `ticket_confirmed`.

**Voting (C owns)** — spec §5 exactly. `0002` creates `vote_rounds(id, event_id, phase, mechanism, credits,
opens_at, closes_at, ballot_key bytea, finalized_at)`, `vote_ballots(round_id, token bytea, cast_at)`,
`vote_entries(id, round_id, session_id, votes, credits, day date, ballot_token bytea)` (no account column),
`credit_ledger(round_id, account_id, allocated jsonb, spent, updated_at)`, `vote_round_results(round_id,
session_id, voters, votes, credits)` computed at close; drops `votes`, its triggers, `update_session_vote_counts`,
`notify_vote_milestone`, and the columns `sessions.total_votes, total_credits, voter_count` and
`profiles.vote_credits`. Votes are keyed by `session_id` (a proposal URI may not exist until publish; the tally
record resolves strongRefs at write time).
- Browser: `useVoting(eventSlug)` from `@/hooks/useVoting` → `{ round, allocation: Record<sessionId, number>, spent, remaining, loading, error, setVotes(sessionId, votes): Promise<void>, refresh() }` and `<VoteControl eventSlug sessionId compact? />` from `@/components/VoteControl`. B and D render these; nobody else writes votes.
- Server: `import { roundState, organizerResults, schedulingInputs } from '@/lib/voting'` —
  `roundState(eventId) → { round | null, status: 'none'|'upcoming'|'open'|'closed' }`;
  `organizerResults(eventId) → Array<{ sessionId, voters, votes, credits }>` (throws `RoundOpenError` while open);
  `schedulingInputs(eventId) → { bySession: Map<string, { votes: number; tokens: Set<string> }> }` (throws `RoundOpenError` while open).
- Nobody shows vote counts while a round is open — not attendees, not organizers (§5.3). Session lists sort by
  recency/title/track while open; "most voted" sort only appears after close, for organizers.

**ATProto (F owns)** — keep these call signatures stable:
- `publishGathering({eventId, callerUserId})`, `publishPolicy`, `publishVenues`, `publishTracks`, `publishSlotGrids`, `publishSchedule({eventId, callerUserId, sessionIds?})`, `requestSessionMove/requestSessionCancel({eventId, sessionId, callerUserId, reason})` → `{ status: 'applied' | 'awaiting_approval', approvalsNeeded }`, from `@/lib/atproto/publish` and `@/lib/atproto/approvals`.
- `publishProposal({sessionId, userId})`, `withdrawProposal`, `publishCohost`, `endorse`, `unendorse`, `publicRsvp`, `retractPublicRsvp`, `publishTimePreference` from `@/lib/atproto/participant`.
- `mintGatheringActor(eventId, callerUserId)` wraps `mintGatheringAccount` and stores `events.actor_did/actor_handle`.
- A calls `mintGatheringActor` in the creation transaction's aftermath (DID minted at creation; no records yet) and `publishGathering` when status leaves `draft`. D calls `publishSchedule` from publish-schedule and routes moves/cancels of **published** sessions through `requestSession*`. B calls `publishProposal` after a proposal is created by a custodial author or an OAuth author who has confirmed public linkage (`profiles.publish_proposals`).

**Uploads (A owns)** — `POST /api/uploads` (multipart, organizer of `event`), stored under `UPLOADS_DIR`
(`/data/uploads`, local default `.uploads/`), served at `/uploads/<path>`. Returns `{ url }`.

**Jobs** — `/api/jobs/close-rounds` (C), `/api/jobs/retention` (E), `/api/notifications/dispatch` (E),
`/api/atproto/sync` (F): `GET`, `Authorization: Bearer $CRON_SECRET`, 401 otherwise (in development without
`CRON_SECRET`, allowed). `/api/health` (A): 200 `{status:'ok', checks:{db, pds}}`, 503 when a check fails.
`/internal/tls-check?domain=` (F): 200/403 per `deploy/unconference/Caddyfile` rules; answers yes for `PDS_HOST`
and `www.<web host>` without I/O, for existing gathering slugs, and for handles the PDS vouches for.

### 7.3 Local test recipe (every package)

- Stack: `npm run stack:up` (Postgres :55432, PLC :2582, PDS :2583) — already running; do not `down` it.
- Dev server: already running on http://localhost:3001 with mail disabled; do not restart it (hot reload).
- Sign in: `node scripts/dev-login.mjs you+pkgX@example.test` prints `sp_at_session=…`; send it as `Cookie`
  and send `Origin: http://localhost:3001` on mutations. Make an organizer with the SQL in that script's header
  (`DATABASE_MIGRATION_URL` from `.env.local`). Seeded events: `demo-gathering` (proposals_open),
  `draft-gathering`, `past-gathering` (completed, 3 scheduled sessions).
- DB for tests: `DATABASE_URL` (app role) / `DATABASE_MIGRATION_URL` (owner) from `.env.local`. New migration:
  add `db/migrations/000N_name.sql` (your number only) and run `npm run db:migrate`.
- Type check only your files: `npx tsc --noEmit 2>&1 | grep -E '<your path prefixes>'` — others are mid-edit.
- Clean up every account you create: `delete from accounts where email like 'you+pkgX%'` and the PDS account
  (`com.atproto.admin.deleteAccount`, admin password `local-admin-password`).
