---
title: "Schelling Point on ATProto — migration specification"
author: "Benjamin Life (@omniharmonic)"
date: 2026-09-14
status: draft
version: "0.1"
target: "Free School architecture (freeskool), applied to the EthBoulder unconference tool"
---

# Schelling Point → ATProto: technical specification

*Read against `schellingpoint@main` (Next.js 14 + Supabase, 41 migrations, 40 API routes) and the Free School repo at `docs/architecture.md` v0.1, `docs/interop-audit.md`, and the multi-school and refinement specs of 2026-09-13. Never attribute to OpenCivics.*

---

## 1. Summary and goals

Schelling Point today is a competent multi-tenant Postgres application: events are rows, participants are `auth.users`, proposals are rows owned by the tenant, votes are rows readable only by their author, and the schedule is a set of foreign keys from `sessions` to `time_slots` and `venues`. It works. What it cannot do is survive its own database. If the Supabase project goes away, every proposal, every schedule, every profile goes with it — including the record of who proposed what, which is the only thing in the system that genuinely belongs to a person rather than to an event.

The migration makes **the proposal the author's property and the schedule the event's**, on the AT Protocol, using exactly the composition rules Free School already settled:

- A **session proposal** is a record in the **proposer's own repo**. It travels with them between events, between cities, and between AppViews. Nobody else can edit it and nobody else can delete it.
- A **scheduled session** is a plain `community.lexicon.calendar.event` in the **event actor's repo**, with a sidecar strongRef back to the proposal. A generic calendar client that has never heard of Schelling Point renders the schedule correctly.
- **Votes are never records.** They are app-side ballots with the event's ballot key destroyed at close, modelled directly on `apps/appview/src/lib/feedback.ts`. The public artifact of a vote round is a **tally written by the event actor with counts only** — never a voter DID, never a per-person allocation.
- **Any EthBoulder-like gathering is a tenant**: a DID, a policy record, a custodied credential, a subdomain, and a set of `sp_*` tables keyed by `event_did` — the multi-school design with `school` renamed `event` and `city` renamed `gathering`.
- **Money stays entirely app-side.** Tickets are entitlements bound to a DID, not records. (Free School's principle 2 — "no money in the app" — is a Free School product rule, not an architectural one; see risk 3.)

Non-goals for v1 of the port: real Spaces, on-chain anything, the PRD's burner cards and budget distribution, AI transcription, NFT gating, and public per-person vote disclosure of any kind.

### The honest reading of the source repo

Where the Schelling Point docs and code disagree, **the migrations and `src/` are right and the prose is stale.** Specifically:

| Claim | Where | Verdict |
|---|---|---|
| Data model is `profiles, venues, tracks, time_slots, sessions, votes, favorites` | `README.md` §Data Model | **Stale.** Missing `events`, `event_members`, `session_cohosts`, `cohost_invites`, `notifications`, `notification_preferences`, `session_rsvps`, `ticket_tiers`, `tickets`, `event_invitations`. Seventeen tables, not seven. |
| Burner cards, attendance voting, budget distribution, revenue smart contract, RAG chatbot | `.claude/schelling_point_PRD.md` v3.0 §2.3–2.4, §5.5, §6 | **Not implemented, anywhere.** No contract, no attendance-vote table, no transcription. Treat the PRD as a wish list; `supabase/migrations/` is the data model of record. |
| "Vote visibility: Hidden until deadline" | PRD §2.2 table | **Contradicted by the code.** `sessions.total_votes`, `.total_credits`, `.voter_count` are denormalised columns updated by the `on_vote_change` trigger and are world-readable through `Anyone can view approved sessions` RLS and through `GET /api/v1/sessions`. The PRD's *intent* is right; the implementation leaks live tallies. The migration resolves this in favour of the PRD. |
| Slug routing beats subdomains | `docs/MULTI_TENANT_EVOLUTION_STRATEGY.md` Appendix, "Why Slug-Based Routing Over Subdomains" | **Reversed by the target architecture.** Free School's multi-school §3 rejects path prefixes on PWA-scope, print-URL and naming grounds. The port adopts subdomains. |
| `events.status` is `draft/published/active/voting/scheduling/live/completed/archived` | `20260217000001_create_events_table.sql` CHECK, and `IMPLEMENTATION_HANDOFF.md` | **Superseded** by `20260218100001_update_event_status_lifecycle.sql` and `src/lib/events/lifecycle.ts`: `draft → published → proposals_open → voting_open → scheduling → live → completed → archived`. |
| Private events can't receive members; no notification system | `CLAUDE.md` §Current Bugs | **Both fixed** since (`event_invitations`, `notifications`). CLAUDE.md is behind the handoff doc. |

One structural finding matters more than the doc drift: **votes are written from the browser straight to PostgREST** (`src/app/e/[slug]/my-votes/page.tsx:139`, `?on_conflict=user_id,session_id`), with the quadratic cost computed client-side and enforced only by RLS row ownership. There is no server-side credit budget check. A participant can spend more than 100 credits by issuing their own PostgREST writes. The port must move the credit ledger server-side regardless of anything else.

---

## 2. Current-state inventory

Every persisted entity, who writes it, who reads it, and where it lands after migration.

| Table | Written by | Read by | New home | Tier |
|---|---|---|---|---|
| `profiles` (email, display_name, bio, avatar_url, affiliation, building, telegram, ens, interests, is_admin, onboarding_completed, vote_credits) | the user (own row); trigger `handle_new_user` on signup | everyone (`Profiles viewable by everyone`), plus `GET /api/v1/profiles` with an API key | **Split.** Identity → a DID on our PDS. Display name/bio/avatar/affiliation/interests → app-side `sp_app_meta profile:<did>`, global across tenants. `ens`, `telegram` → self-written, verified app-side, never a record. `is_admin` → deleted; replaced by derived role. `vote_credits` → per-tenant `sp_membership`/ledger. | not published (profile), firehose (DID/handle only) |
| `events` (slug, name, dates, tz, location, status, vote config, proposal config, theme, visibility, ticketing_enabled, stripe_account_id, voting_mechanism, schedule_published_at, suggested_topics) | owner via `/api/events/create` wizard | everyone for public events | **Split three ways.** Public identity/description/dates → `schellingpoint.draft.gathering` at `rkey=self` in the **event actor's repo** (the analogue of `freeschool.draft.school`). Rules (credits, mechanism, windows, allowed formats, approval, steward threshold) → `freeschool.draft.policy` reused verbatim + a `schellingpoint.draft.votingRules` sidecar. Operational facts (theme, Stripe account, hostnames, custody) → `sp_gathering` row. | firehose (gathering, policy); not published (Stripe, theme assets, credentials) |
| `event_members` (event_id, user_id, role, vote_credits) | `/api/events/create`, invitation accept, ticket-purchase trigger `add_ticket_holder_as_member`, `EventContext` self-join | members of the same event | `sp_membership(did, event_did, …)` — **never a record, never public.** Role becomes `deriveRole()` over evidence. | not published |
| `sessions` (title, description, format, duration, host_id, host_name, topic_tags, status, venue_id, time_slot_id, track_id, is_self_hosted, custom_location, self_hosted times, telegram_group_url, time_preferences, required_features, expected_attendance, session_type, is_votable, denormalised vote/rsvp counts) | proposer via `POST /api/v1/sessions`; admins via `/admin/sessions`, CSV import, `/sessions/batch`, drag-drop schedule builder | everyone when `approved`/`scheduled` | **Split.** Proposal content → `schellingpoint.draft.proposal` in the **proposer's repo**. Slot assignment (`venue_id`, `time_slot_id`, `status: scheduled`) → `schellingpoint.draft.slot` + a materialised `community.lexicon.calendar.event`, both in the **event actor's repo**. `time_preferences` → `schellingpoint.draft.timePreference` in the proposer's repo. Denormalised counts → derived from the app-side ledger. `host_name` free text → **deleted** (see §3, R9). `telegram_group_url` → app-side, RSVP-gated. | firehose (proposal, slot, calendar event); not published (attendee-only detail) |
| `votes` (user_id, session_id, credits_spent, vote_count, event_id) | the voter, **from the browser directly to PostgREST** | the voter only (RLS); aggregate leaked via `sessions.total_*` | `sp_ballot` + `sp_vote` + `sp_credit_ledger`, **app-side, author-unlinkable after close** (§5). | not published |
| `favorites` (user_id, session_id) | the user | the user | `sp_favorite` — app-side, private, no record. | not published |
| `venues` (name, slug, capacity, features[], style, address, notes, is_primary) | admins | everyone | `schellingpoint.draft.venue` in the **event actor's repo**, with `community.lexicon.location.address` for the address. | firehose |
| `time_slots` (start, end, label, is_break, venue_id, day_date, slot_type) | admins, bulk generator | everyone | `schellingpoint.draft.slotGrid` in the event actor's repo (one record per day per venue, slots inline) — the schedule skeleton. | firehose |
| `tracks` (name, slug, description, color, lead_name, lead_email, lead_user_id, max_sessions, display_order, is_active) | admins | everyone | `schellingpoint.draft.track` in the event actor's repo. `lead_name`/`lead_email`/`lead_user_id` → **app-side only** (R9: names a person who did not write it). | firehose (track), not published (lead identity) |
| `session_cohosts` (session_id, user_id, display_order) | **the co-host themselves**, on accepting a token link (`/api/invite/[token]/accept`) | everyone (public read, to render host lists) | `schellingpoint.draft.cohost` in the **co-host's own repo**, referencing the proposal. Already double-opt-in in spirit; the port makes it double-opt-in in structure. | firehose |
| `cohost_invites` (session_id, token, created_by, accepted_by, status, expires_at) | proposer creates; invitee accepts | proposer + invitee | `sp_cohost_invite` — app-side, opaque bearer token, `created_by` nulled 30 days after redemption (Free School invite pattern). | not published |
| `session_rsvps` (session_id, user_id, status confirmed/waitlist/cancelled, waitlist_position) + `promote_from_waitlist` trigger | the attendee | counts public via `sessions.rsvp_count`; rows private | `sp_rsvp` — app-side by default, **with per-session opt-in** to write `community.lexicon.calendar.rsvp` into the attendee's own repo (permanence warning shown). | not published (counts within gathering); firehose on opt-in |
| `ticket_tiers` (price, quantity, sale window, allows_proposals, allows_voting, vote_credits_override, stripe_price_id) | admins | everyone (public tier list) | `sp_ticket_tier` — app-side. Tier *names and prices* may optionally appear on `coop.lexicon.event.listing`; the port keeps them app-side in v1. | not published |
| `tickets` (tier_id, user_id, status, qr_code JWT, checked_in_at/by, payment_intent_id, amount_paid_cents) | Stripe webhook, checkout route, check-in route | the holder, admins, check-in volunteers | `sp_ticket` — app-side entitlement bound to a DID. Never a record, ever (§5). | not published |
| `event_invitations` (email, token, role, expires_at, accepted_at, created_by) | admins | token holder | `sp_invite` — app-side, inviter nulled at 30 days. | not published |
| `notifications` (17 types) + `notification_preferences` (5 categories) + 5 DB triggers | DB triggers, broadcast route, dispatch worker | the recipient | `sp_notification_*` — app-side, pg-boss outbox replacing Postgres triggers. | not published |
| Supabase Storage `event-assets` | admins | everyone | Blobs on the PDS for anything on a record; app-side object store for theme assets. Avatars re-encoded through `normalizeImage`. | mixed |

### Auth flows and integrations to replace

| Today | Replacement |
|---|---|
| Supabase magic-link auth; `auth.users` → `profiles` trigger; client-held JWT in `localStorage`, hand-rolled refresh in `useAuth.tsx` | `apps/appview/src/lib/custody.ts` verbatim: `createInviteCode → createAccount → wrap password → magic link → HttpOnly cookie session`. No token ever reaches the browser. |
| Row-Level Security as the authorisation model, with `createAdminClient()` bypassing it in ~30 API routes | Server-side authorisation in the AppView (`requireViewer`, `requireRole`), plus the tenant-isolation lint rule from multi-school §11 (any query on a scoped table without an `event_did` predicate is a build error). |
| Browser writes to PostgREST (`rest/v1/...`) in 30+ components | Deleted. Every write goes through `/api/*`. This is not optional: the credit budget is unenforceable otherwise. |
| Stripe Checkout + webhook | Unchanged, moved into the AppView. |
| Resend transactional email | Unchanged (SMTP/MJML per Free School §4.8). |
| `x-api-key` read API (`docs/api-guide.md`) | Replaced by public records + the AppView's public read endpoints. The existing API leaks `ens`, `telegram` and `is_admin` for every profile with a single shared key; that endpoint does not survive. |

---

## 3. Principles carried over

| Free School principle | How it binds Schelling Point |
|---|---|
| **Sidecar composition only; never add fields to a borrowed record** | A scheduled session is a canonical `community.lexicon.calendar.event`. The proposal link, track, vote tally reference and venue features ride as separate `schellingpoint.draft.*` records strongRef'ing it. No `voteCount` field is ever added to the calendar event — a tally is a separate record precisely so it can be re-published without rewriting the schedule. |
| **A custodied event actor; every write as the event goes through the port** | `SchoolActorPort` is renamed nothing — it is already generic (`schoolDid` → `gatheringDid`; every method already takes it). Schedule publication, slot assignment, venue records, tally publication and listing curation are `actAs` calls with a scope, an audit reason, and — for destructive actions — the policy's steward threshold. Re-scheduling a published session and cancelling a session are **destructive**: they need two organisers. Drag-and-drop in the admin schedule builder becomes a draft in `sp_schedule_draft`; publishing it is one authorised port call. |
| **Two sign-in doors, fresh identity primary** | Door 1: email → custodial DID on our PDS, generated-or-chosen handle, never derived from the email. Door 2: existing ATProto account via server-side OAuth with the hard-confirm sheet. For a crypto-conference audience there is pressure to make a wallet the front door; it is not one (§7). |
| **App-side private data behind a Spaces-shaped interface** | Votes, credits, tickets, RSVPs, check-ins, notifications, co-host invites and moderation go through `packages/spaces-shim`'s `SpaceStore` over Postgres. Two spaces per gathering: `members` and `ballots`. `hostMayRead: false` on the ballot space, exactly as feedback. |
| **Derived reputation; attestations not scores** | `event_members.role` is deleted. `deriveRole(evidence, thresholds)` computes Visitor/Participant/Host/Organiser/Steward from evidence: has a profile, holds a ticket or invite, proposed a session that was scheduled, hosted a session with attendance, appointed. **Rendering update (2026-09-26):** the gathering overview may order voluntary public endorsements and finalized, k-suppressed vote results by support. Open-round ballot totals remain hidden from everyone. The public tally record carries counts and presence — `voterCount`, `totalVotes` — never an average or rank. This is a client rendering choice, not a reputation score. |
| **No public record may name a DID its holder did not write** | This is the rule that reshapes the app. Casualties: `sessions.host_name` (a proposer or an admin typing a speaker's name), `tracks.lead_name`/`lead_email`, `session_cohosts` written on someone's behalf, CSV speaker import, `event_members`, and every vote. Each has a replacement in §4 and §9. |
| **Four publication tiers** | Every entity gets a row in the §10 matrix. Default for anything about a person that they did not write: *not published*. |
| **Defaults open; gates opt-in** | `require_proposal_approval` defaults **false** in the port (it defaults `TRUE` today). Proposals are public on write. Voting eligibility gates are opt-in per gathering, not on by default. |
| **Forkable and continuous** | Proposals in proposers' repos; venue/track/schedule records in the gathering's repo; CC0 lexicons; a gathering that ends leaves a permanent, self-describing calendar. An organiser hand-off flow (Free School's `fs_handoff`) means EthBoulder 2027 can inherit EthBoulder 2026's DID or start a fresh one and cross-link. |
| **Neutral PDS hostname** | One shared PDS for every gathering, on a hostname that names no gathering. A PDS per conference would put "this person attended EthBoulder" in a world-readable DID document forever. Gathering subdomains are served by the web tier, with the Caddy wildcard inversion from multi-school §3 so `ethboulder.schellingpoint.xyz` serves the PWA while `*.…/.well-known/atproto-did` still resolves handles. |

---

## 4. Record design

### 4.1 What is reused, unchanged

| Lexicon | Used for | Repo |
|---|---|---|
| `community.lexicon.calendar.event` | **the gathering itself** (one event record for EthBoulder, with start/end dates) and **each scheduled session** (one per slot assignment) | gathering actor |
| `community.lexicon.calendar.rsvp` | per-session RSVP, **opt-in only** | attendee |
| `community.lexicon.location.address` / `.geo` | venue addresses | gathering actor |
| `coop.lexicon.event.config` | capacity, timezone, visibility, routing tags on both the gathering event and each scheduled session | same repo as the event it configures |
| `coop.lexicon.event.listing` | cross-listing a session onto another gathering's or Free School's calendar | the *curating* actor |
| `coop.lexicon.membership` | opt-in public "I was a host at EthBoulder 2026", triple-gated | gathering actor |
| `freeschool.draft.policy` | the gathering's rules and thresholds — reused **verbatim**, including `destructiveActionStewards` and `feedbackK` | gathering actor |
| `freeschool.draft.series` / `.occurrence` | a recurring gathering (EthBoulder is annual; a monthly unconference is weekly-shaped) | gathering actor |
| `freeschool.draft.skill` | the shared taxonomy. **Tracks are not skills**, but a track may carry skill URIs so a Free School class and a Schelling Point session are discoverable by the same vocabulary (§10) | taxonomy authority |
| `freeschool.draft.hostFeedback` | post-session feedback, app-side, identical ballot machinery | app-side |

`freeschool.draft.school` becomes the model for `schellingpoint.draft.gathering` rather than being reused: a gathering has dates and a lifecycle a school does not, and `rkey=self` semantics are identical.

### 4.2 New records

All seven are `schellingpoint.draft.*`, CC0, designed so the eventual namespace normalisation is a find-and-replace. Every one is validated against the vendored borrowed lexicons in `packages/lexicons/vendor/` where it strongRefs one.

**`schellingpoint.draft.proposal`** — key `tid`, written by **the proposer, in their own repo**, tier **firehose**.

```json
{
  "lexicon": 1,
  "id": "schellingpoint.draft.proposal",
  "description": "A session a person offers to an unconference. Lives in the PROPOSER'S repo: it is their offer, it survives the gathering, and no organiser can edit or delete it — an organiser declines by not writing a slot, and removes by deleting their own listing. Carries no co-host DIDs (R9: a co-host writes their own schellingpoint.draft.cohost) and no schedule (that is the gathering's schellingpoint.draft.slot).",
  "defs": {
    "main": {
      "type": "record",
      "key": "tid",
      "record": {
        "type": "object",
        "required": ["gathering", "title", "format", "durationMinutes", "createdAt"],
        "properties": {
          "gathering": { "type": "string", "format": "at-uri",
            "description": "AT-URI of the schellingpoint.draft.gathering this is offered to. A URI, not a strongRef: the gathering record is edited (dates move, description changes) and a proposal must not be orphaned by that." },
          "title": { "type": "string", "maxLength": 3000, "maxGraphemes": 300 },
          "description": { "type": "string", "maxLength": 30000, "maxGraphemes": 3000 },
          "format": { "type": "string", "knownValues": ["talk", "workshop", "discussion", "panel", "demo"] },
          "durationMinutes": { "type": "integer", "minimum": 5, "maximum": 600 },
          "track": { "type": "string", "format": "at-uri", "description": "Optional schellingpoint.draft.track the proposer suggests. Advisory: the gathering's slot record decides the track it is actually programmed in." },
          "skills": { "type": "array", "maxLength": 5, "items": { "type": "string", "format": "at-uri" },
            "description": "freeschool.draft.skill URIs — the shared taxonomy, so this session is findable next to a Free School class on the same subject." },
          "topics": { "type": "array", "maxLength": 10, "items": { "type": "string", "maxLength": 640, "maxGraphemes": 64 } },
          "expectedAttendance": { "type": "integer", "minimum": 1, "maximum": 10000,
            "description": "The proposer's own estimate, used for venue matching. Never a vote-derived number: capacity fit must not become a public popularity proxy." },
          "requiredFeatures": { "type": "array", "maxLength": 10, "items": { "type": "string", "maxLength": 400 },
            "description": "Venue feature tags (projector, whiteboard, microphone). Matched against schellingpoint.draft.venue#features by the scheduler." },
          "selfHosted": { "type": "boolean", "default": false,
            "description": "The proposer is running this at their own place and time and is not asking for a slot. When true, startsAt/endsAt and place are the proposer's own; the gathering may still list it." },
          "startsAt": { "type": "string", "format": "datetime" },
          "endsAt": { "type": "string", "format": "datetime" },
          "place": { "type": "string", "maxLength": 2000, "maxGraphemes": 200 },
          "createdAt": { "type": "string", "format": "datetime" }
        }
      }
    }
  }
}
```

*R9 check:* names only its author's own DID (implicitly, by repo). No co-host, no speaker name, no attendee. `host_name` has no successor field — the host **is** the repo owner. Imported legacy speakers are handled in §11.

**`schellingpoint.draft.cohost`** — key `tid`, written by **the co-host, in their own repo**, tier **firehose**.

```json
{
  "lexicon": 1, "id": "schellingpoint.draft.cohost",
  "description": "The second half of a double opt-in. A proposer invites a co-host through an opaque app-side token; the co-host accepts by writing THIS record into their own repo, naming the proposal. Neither record alone names a person who did not write it: the proposal names nobody, and this names only its own author. An AppView renders a co-hosted session by pairing them. Modelled on the deferred freeschool.draft.skillAttestation design (interop audit gap 15).",
  "defs": { "main": { "type": "record", "key": "tid", "record": {
    "type": "object",
    "required": ["proposal", "createdAt"],
    "properties": {
      "proposal": { "type": "ref", "ref": "com.atproto.repo.strongRef",
        "description": "strongRef — BOTH uri and cid — to the schellingpoint.draft.proposal being co-hosted. A cid-less ref is invalid com.atproto.repo.strongRef and a validating peer drops it (interop audit gap 3)." },
      "role": { "type": "string", "knownValues": ["cohost", "facilitator", "notetaker"], "default": "cohost" },
      "displayOrder": { "type": "integer", "minimum": 0, "maximum": 20 },
      "createdAt": { "type": "string", "format": "datetime" }
    } } } }
}
```

*R9 check:* passes. Withdrawal is the co-host deleting their own record — an organiser cannot un-cohost someone, and a proposer cannot add one.

**`schellingpoint.draft.timePreference`** — key `tid`, written by **the proposer**, tier **firehose** (or app-side; see the note).

```json
{
  "lexicon": 1, "id": "schellingpoint.draft.timePreference",
  "description": "When the proposer can actually be there. A separate record from the proposal because availability changes independently of the offer, and because a proposer may withdraw availability without retracting the session.",
  "defs": { "main": { "type": "record", "key": "tid", "record": {
    "type": "object",
    "required": ["proposal", "createdAt"],
    "properties": {
      "proposal": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
      "windows": { "type": "array", "maxLength": 40, "items": { "type": "ref", "ref": "#window" } },
      "blackouts": { "type": "array", "maxLength": 40, "items": { "type": "ref", "ref": "#window" } },
      "createdAt": { "type": "string", "format": "datetime" }
    } } },
    "window": { "type": "object", "required": ["startsAt", "endsAt"], "properties": {
      "startsAt": { "type": "string", "format": "datetime" },
      "endsAt": { "type": "string", "format": "datetime" },
      "preference": { "type": "integer", "minimum": 1, "maximum": 3, "description": "1 prefer, 2 acceptable, 3 last resort. Ordered so a scheduler can compare." } } }
  }
}
```

*Note:* today's `sessions.time_preferences TEXT[]` holds `"tuesday_am"` strings; the record uses real instants, which the scheduler already wants. A proposer's detailed availability is arguably personal (it says where they are not, for a week). **Default it to app-side**, with a per-proposal opt-in to publish; the scheduler reads it from either place through one interface.

**`schellingpoint.draft.track`** — key `tid`, written by **the gathering actor**, tier **firehose**.

Fields: `name`, `slug`, `description`, `color`, `skills[]` (at-uris into the shared taxonomy), `maxSessions`, `displayOrder`, `active`, `createdAt`. **No `lead_name`, no `lead_email`, no `lead_did`.** A track lead is app-side (`sp_track_lead`); if a lead wants to be publicly associated with a track they write a `coop.lexicon.membership` claim naming themselves, gated the usual three ways.

**`schellingpoint.draft.venue`** — key `tid`, written by **the gathering actor**, tier **firehose**.

Fields: `name`, `slug`, `capacity`, `features[]`, `style`, `primary`, `locations[]` (a union over `community.lexicon.location.address|geo|fsq|hthree`, same as the calendar event), `notes`, `createdAt`. A venue is a place, not a person, so it publishes cleanly. The one caveat: for a private residence hosting a session, the address follows the calendar event's tiered disclosure — neighbourhood on the record, exact address served app-side to ticket-holders N hours before.

**`schellingpoint.draft.slot`** — key `tid`, written by **the gathering actor**, tier **firehose**.

```json
{
  "lexicon": 1, "id": "schellingpoint.draft.slot",
  "description": "The gathering's decision to programme one proposal at one time in one venue. The join that used to be sessions.venue_id + sessions.time_slot_id, moved out of the proposer's record so that scheduling is the gathering's act and not an edit to someone else's repo. Accompanies a materialized community.lexicon.calendar.event (the thing a generic calendar client reads); this record is the provenance link back to the proposal.",
  "defs": { "main": { "type": "record", "key": "tid", "record": {
    "type": "object",
    "required": ["gathering", "event", "proposal", "startsAt", "endsAt", "createdAt"],
    "properties": {
      "gathering": { "type": "string", "format": "at-uri" },
      "event": { "type": "ref", "ref": "com.atproto.repo.strongRef",
        "description": "The community.lexicon.calendar.event materialized for this slot, in this same repo." },
      "proposal": { "type": "ref", "ref": "com.atproto.repo.strongRef",
        "description": "The proposer's own record. strongRef pins the version that was accepted: if the proposer rewrites the title after scheduling, the cid mismatch is exactly the signal the organiser needs to re-publish or not." },
      "venue": { "type": "string", "format": "at-uri" },
      "track": { "type": "string", "format": "at-uri" },
      "startsAt": { "type": "string", "format": "datetime" },
      "endsAt": { "type": "string", "format": "datetime" },
      "status": { "type": "string", "knownValues": ["scheduled", "moved", "cancelled"], "default": "scheduled" },
      "supersedes": { "type": "ref", "ref": "com.atproto.repo.strongRef",
        "description": "The slot this one replaces when a session is moved. Keeps the schedule's history legible without deleting the record someone already put in their calendar." },
      "createdAt": { "type": "string", "format": "datetime" }
    } } } }
}
```

**`schellingpoint.draft.tally`** — key `tid`, written by **the gathering actor**, tier **firehose**. The only public artifact of a vote round. Detailed in §5.

**`schellingpoint.draft.endorsement`** — key `tid`, written by **a participant, in their own repo**, tier **firehose**. The only public form a vote may ever take, and it is not a vote.

```json
{
  "lexicon": 1, "id": "schellingpoint.draft.endorsement",
  "description": "'I want this session to happen, and I am willing to say so publicly.' Entirely separate from the ballot: writing one does not spend credits and not writing one does not reduce a ballot's weight. Exists so that a participant who WANTS attribution can have it, without any participant's private allocation ever becoming visible. Never counted into a tally — it is a signal to other humans, not an input to the scheduler.",
  "defs": { "main": { "type": "record", "key": "tid", "record": {
    "type": "object", "required": ["proposal", "createdAt"],
    "properties": {
      "proposal": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
      "note": { "type": "string", "maxLength": 1500, "maxGraphemes": 150 },
      "createdAt": { "type": "string", "format": "datetime" }
    } } } }
}
```

**`schellingpoint.draft.gathering`** — key `literal:self`, written by **the gathering actor**, tier **firehose**. Modelled line-for-line on `freeschool.draft.school`: `name`, `description`, `region`, `policy` (at-uri), `handleDomain`, `website`, `peers[]`, `tags[]`, plus `startsAt`/`endsAt`, `event` (strongRef to the gathering's own `community.lexicon.calendar.event`), `phase` (`draft|proposals|voting|scheduling|live|completed|archived`) and `createdAt`.

### 4.3 The sidecar rule, stated

**No field is ever added to `community.lexicon.calendar.event`, `community.lexicon.calendar.rsvp`, `coop.lexicon.event.config`, `coop.lexicon.event.listing`, `coop.lexicon.membership`, or any `freeschool.draft.*` record we borrow.** Vote counts, proposal provenance, track colour, venue features, quadratic parameters and attendance all live in sidecars that strongRef the event. The practical test, from the interop audit: a calendar client that has never heard of `schellingpoint.draft.*` must render the whole EthBoulder schedule correctly from the event records alone. It does.

---

## 5. Quadratic voting under R9

This is the hard part and it deserves the plainest possible statement of the problem: **a vote is a signed statement of preference intensity, and quadratic voting makes it a statement about how much you care.** Published, it is a permanent, world-readable map of every participant's interests, their co-attendance graph (voters who back the same session), and — with a conference's small N — trivially de-anonymised. Nothing in the current app publishes individual votes, but the *tallies* (`total_votes`, `total_credits`, `voter_count`) are live and public, and the auto-scheduler consumes raw `(session_id, user_id)` pairs to compute Jaccard voter overlap. Both need care.

### 5.1 Ruling

**Votes are app-side, ballot-style, and structurally unlinkable to their author after the round closes.** No vote is ever a record. The design is `apps/appview/src/lib/feedback.ts` with one addition — a credit ledger — and one subtraction — feedback's per-event singleton ballot becomes a per-round, per-session multiset.

### 5.2 Tables

```sql
-- One per (gathering, voting round). The key is the only thing that ever links a DID to a ballot.
CREATE TABLE sp_vote_round (
  id            text PRIMARY KEY,
  event_did     text NOT NULL REFERENCES sp_gathering(did),
  phase         text NOT NULL,              -- 'pre-event' | 'attendance'
  mechanism     text NOT NULL,              -- 'quadratic' | 'linear' | 'approval'
  credits       integer NOT NULL,           -- 100
  opens_at      timestamptz NOT NULL,
  closes_at     timestamptz NOT NULL,
  ballot_key    bytea,                      -- 32 random bytes; SET NULL AT CLOSE, irreversibly
  finalized_at  timestamptz
);

-- Proves "this DID participated in this round, once" and nothing else. No DID column.
CREATE TABLE sp_ballot (
  round_id  text NOT NULL REFERENCES sp_vote_round(id),
  token     bytea NOT NULL,                 -- hmac(ballot_key, did)
  cast_at   timestamptz NOT NULL,
  PRIMARY KEY (round_id, token)
);

-- The content. NO author column, NO ballot column, DAY not timestamp.
CREATE TABLE sp_vote (
  id             text PRIMARY KEY,
  round_id       text NOT NULL REFERENCES sp_vote_round(id),
  proposal_uri   text NOT NULL,
  votes          integer NOT NULL CHECK (votes > 0),
  credits        integer NOT NULL CHECK (credits > 0),
  day            date NOT NULL
);

-- The budget, enforced server-side. Lives only while the round is open; collapsed at close.
CREATE TABLE sp_credit_ledger (
  round_id  text NOT NULL REFERENCES sp_vote_round(id),
  did       text NOT NULL,
  allocated jsonb NOT NULL,                 -- { "<proposal_uri>": votes }
  spent     integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (round_id, did)
);
```

### 5.3 How a round runs

1. **Open.** The organiser opens a round through the actor port (`open-vote-round`, non-destructive). A 32-byte `ballot_key` is generated and never leaves the row.
2. **While open**, a participant's allocation is *mutable and author-linked* — it has to be: they can change their votes, and the UI must show them their own allocation. `sp_credit_ledger` holds it, keyed by DID, and the server enforces `Σ votes² ≤ credits` (quadratic), `Σ votes ≤ credits` (linear) or `count ≤ credits` (approval) on every write. This is the check that does not exist today.
3. **Tallies are not public while the round is open.** The PRD's own rule ("hidden until deadline") becomes the implementation. `GET /api/gatherings/:did/tally` returns 409 `RoundOpen` before `closes_at`. Organisers see nothing either: a live tally visible to organisers is a live tally leaked to participants through organiser behaviour, and a mid-round leaderboard destroys the honest-preference property quadratic voting exists to protect.
4. **Close.** In one job: for each `sp_credit_ledger` row, compute `token = hmac(ballot_key, did)`, insert into `sp_ballot`, explode the `allocated` map into `sp_vote` rows **in randomized batches with `day` only**, then `DELETE FROM sp_credit_ledger WHERE round_id = …` and `UPDATE sp_vote_round SET ballot_key = NULL`. After this transaction the database cannot answer "who voted for X" — not under subpoena, not with the whole disk. The `did → token` map is unrecoverable because the key was the only thing that ever computed it.
5. **Aggregate.** The tally is computed once, held to k: a proposal with fewer than `k` distinct ballots (default 3, from `policy#thresholds.feedbackK`) publishes **`voterCount: "<k"` and no vote total at all**. One voter's allocation to an obscure session is that voter's preference, stated in public.
6. **Publish.** The event actor writes one `schellingpoint.draft.tally`.

```json
{
  "lexicon": 1, "id": "schellingpoint.draft.tally",
  "description": "The public result of one voting round: counts and presence, never averages, never ranks, never a voter. Written by the GATHERING actor after the round closes and the ballot key is destroyed. Entries below the k threshold are suppressed rather than rounded, because a suppressed row is honest and a rounded one is a reconstruction target.",
  "defs": { "main": { "type": "record", "key": "tid", "record": {
    "type": "object",
    "required": ["gathering", "round", "mechanism", "closedAt", "createdAt"],
    "properties": {
      "gathering": { "type": "string", "format": "at-uri" },
      "round": { "type": "string", "knownValues": ["pre-event", "attendance"] },
      "mechanism": { "type": "string", "knownValues": ["quadratic", "linear", "approval"] },
      "creditsPerVoter": { "type": "integer" },
      "ballotsCast": { "type": "integer", "description": "Distinct participants in the round. A count, never a list." },
      "k": { "type": "integer", "description": "The suppression threshold this tally was held to." },
      "entries": { "type": "array", "maxLength": 2000, "items": { "type": "ref", "ref": "#entry" } },
      "closedAt": { "type": "string", "format": "datetime" },
      "createdAt": { "type": "string", "format": "datetime" }
    } } },
    "entry": { "type": "object", "required": ["proposal", "suppressed"], "properties": {
      "proposal": { "type": "ref", "ref": "com.atproto.repo.strongRef" },
      "suppressed": { "type": "boolean", "description": "True when fewer than k distinct ballots named this proposal. When true, votes/voters/credits are ABSENT — not zero." },
      "voters": { "type": "integer", "minimum": 0 },
      "votes": { "type": "integer", "minimum": 0 },
      "credits": { "type": "integer", "minimum": 0 } } }
  }
}
```

Note what is absent: no rank, no percentage, no "top session", no per-voter anything. Ordering a tally by votes is a rendering choice a client may make; the record does not assert it. That is the "attestations, not scores" principle applied to a voting system, and it is the difference between publishing evidence and publishing a scoreboard.

### 5.4 The auto-scheduler's voter-overlap problem

`src/lib/scheduling/auto-scheduler.ts` builds `Map<sessionId, Set<userId>>` and computes Jaccard similarity to avoid scheduling sessions with overlapping voter bases against each other. It is a good heuristic and it is also, literally, a co-preference graph over named participants.

Resolution: the scheduler runs **inside the trust boundary, on ballot tokens rather than DIDs, after the key is destroyed**. `sp_vote` rows carry no author, so the overlap computation needs one extra column — `ballot_token` on `sp_vote`, written at close in the same randomized batch. That token links a person's votes *to each other* without linking them to the person. Jaccard over tokens is exactly as useful and names nobody. The overlap matrix itself is never published and never leaves the AppView; only the resulting schedule does. This is the single place where the port keeps a linkage the feedback design destroys, and it is worth stating why: feedback rows must be mutually unlinkable because one person's three comments could be triangulated; vote rows must be mutually linkable because the whole scheduling value is in the correlation. Tokens give the correlation without the identity. Add to the privacy audit: `sp_vote` must have no `did` column, and `sp_vote_round.ballot_key` must be NULL for every round past `closes_at`.

### 5.4a Mergers and the vote bonus (deviation from PRD §4.4)

PRD §4.4 lets two proposers merge their sessions and transfers the votes as
`new_session_votes = (A + B) × 1.1`, "the 10% bonus incentivizes collaboration". **The bonus is
not implemented, deliberately.** A bonus is only meaningful if the two vote sets can be told
apart from the people behind them; after the close in §5.3 step 4 the ballot key is gone, and
all we hold is a token per person per round. Multiplying a combined total by 1.1 would inflate
a number nobody can audit, in a tally whose whole claim is that it is the honest arithmetic of
what was cast.

What happens instead, app-side only:

- An accepted merger sets `sessions.merged_into` on the **source**. Nothing is written into
  anyone's repo: R9 holds for a merger exactly as it holds for an organizer's edit, so the
  source proposal stays as its author wrote it and only the author may withdraw it. The
  `community.lexicon.calendar.event` is written for the target alone, so the network sees one
  session.
- The source stops taking new votes (`is_votable = false`) but the votes already allocated to
  it still travel: at close, entries are written for both ids, and the target's
  `vote_round_results` row counts entries for either id **deduplicated by `ballot_token`**,
  keeping the larger of the two vote counts when one token backed both. One person who wanted
  both sessions is one voter, not two.
- The merged source gets no result row of its own, so it cannot appear in the published tally,
  and `schedulingInputs` folds its tokens into the target's set on the same rule — the
  scheduler compares one audience, not two.

Co-hosts are not moved either: a co-host's `cohost` record names a particular session and is
theirs. The target's proposer may invite them; nobody re-points their record for them.

### 5.5 Sybil resistance without a public identity

Today, sybil resistance is "you need a `profiles` row", i.e. an email. On ATProto anyone can mint a DID. Three layers, all app-side:

1. **Ticket entitlement.** `sp_ticket(event_did, did, tier_id, status, …)`. The tier carries `allows_voting` and `vote_credits_override`, exactly as today. Eligibility to open a ledger row is "this DID holds a confirmed ticket in a tier with `allows_voting`". Organizer exception (2026-09-26): the gathering’s appointed owner and admins may vote without a ticket or ticket-based check-in; budgets, voting windows, session eligibility and ballot privacy still apply. The ticket is **never a record**: a public ticket record would announce attendance and, for a paid tier, spending. The QR check-in token stays a JWT signed by the AppView, scoped to `(event_did, ticket_id)`, bound to the DID, with a short TTL — a bearer credential, not an identity claim.
2. **Invite codes.** `sp_invite` with opaque bearer tokens, one-or-N uses, `created_by` nulled 30 days after redemption so the invite tree cannot be reconstructed. This is the free-event path.
3. **Proof of ticket for a third party**, if a gathering ever needs one: a short-lived signed app-side claim (`{event_did, holder_did, tier, exp}` signed by the AppView key), presented by the holder, verified against the AppView's JWKS. It says "the bearer holds a ticket" to whoever the bearer chooses to show it to, and it expires. It is not on the network and it is not in a repo.

A wallet or ENS name may be *attached* to a profile and verified app-side (§7), and a gathering may configure "an eligible DID must have a verified wallet", but the wallet never appears in a public record written by us and is never the sign-in door.

### 5.6 What is lost, honestly

Public verifiability of the count. Today anyone with the API key could sum `votes` and check `total_votes`; under this design they cannot. The tally is an assertion by the gathering actor, backed by its signature and its audit log, not a re-computable proof. For a crypto audience that is a real cost, and there is a real answer if it is wanted: publish `hash(sorted ballot tokens)` alongside the tally so that a participant who kept their own token can prove they were counted, and an auditor given the closed round's `sp_vote` table can re-derive the totals. That is a verifiable-but-not-public tally, and it is the right shape. It is a phase-2 item, not v1 (risk 7).

---

## 6. Scheduling engine

The greedy scorer is kept as-is — duration match, time preference, venue features, capacity fit, track spread, voter-overlap penalty, primary-venue bonus. What changes is its inputs, its outputs, and who signs them.

**Inputs.** Public `schellingpoint.draft.proposal` records indexed by contrail from proposers' repos; `schellingpoint.draft.venue` and `.slotGrid` from the gathering's repo; app-side `sp_vote` rows and the token-based overlap matrix; app-side or opt-in-public time preferences.

**Output, in three steps.**

1. **Draft.** `POST /api/gatherings/:did/schedule/auto` writes `sp_schedule_draft(event_did, generated_at, assignments jsonb, unassigned jsonb, stats jsonb)`. Nothing is signed, nothing is public. Drag-and-drop editing, undo/redo and conflict detection all operate on the draft. This is where today's admin schedule builder already lives conceptually; it just stops writing through to the live table on every drag.
2. **Publish.** `POST /api/gatherings/:did/schedule/publish` walks the draft and, for each assignment, makes exactly two port calls:
   - `putRecordAsSchool({ action: 'publish-event', collection: 'community.lexicon.calendar.event', … })` — the canonical event, with `name`, `description`, `startsAt`, `endsAt`, `mode`, `status: scheduled`, `locations[]` copied from the venue record, and `uris[]` pointing at the gathering's page. Plus `coop.lexicon.event.config` with capacity, timezone and the gathering's routing tags.
   - `putRecordAsSchool({ action: 'publish-event', collection: 'schellingpoint.draft.slot', … })` — the provenance sidecar, strongRef'ing both the calendar event and the proposal at the cid the organiser accepted.

   Both are idempotent on a deterministic rkey derived from `(proposal_uri, slot_start)`, and both use CAS (`swapRecord`) so a concurrent publish fails loudly rather than double-writing. Every call writes an audit row. Publication of a 200-session schedule is one authorisation, one audit entry per record, and one `schedule_published_at` stamp.
3. **Route listings.** For each published event whose config tags match the gathering's `tags[]`, the actor writes a `coop.lexicon.event.listing` — with **both `uri` and `cid`**, the interop audit's gap 3 — onto its own calendar, and peers (COhere, a Free School instance) that follow our PDS index it. Materialised occurrences of a recurring gathering carry the tags too; the Free School materializer's bug (occurrences listed without tags, dropping every instance of a recurring class from a tag-routing peer) is a bug not to re-introduce.

**Conflicts.** Slot occupancy, duration mismatch and capacity overflow are detected on the draft, as today. Two new ones the record model makes possible: **cid drift** (the proposal changed after the slot pinned it — surfaced as "the proposer edited this session; review and re-publish") and **proposal withdrawal** (the proposer deleted their record — the slot is orphaned and the organiser must cancel or re-fill it, because we cannot resurrect someone else's record).

**Re-scheduling and cancellation.** Moving a *published* session is destructive: it needs `destructiveActionStewards` approvals, each written as a `freeschool.draft.approval` record in the approving organiser's **own repo**, exactly as Free School does. Mechanically, a move writes a new slot with `supersedes` pointing at the old one and updates the calendar event's `startsAt`/`endsAt` in place (so calendars that subscribed by URI follow the move). A cancellation sets the calendar event's own `status: cancelled` — the base lexicon's field, not ours — and the slot's `status: cancelled`. **A cancellation never deletes the proposal**: that record belongs to the proposer and the gathering has no authority over it. A moderation removal deletes the gathering's own *listing*, never the author's record — same rule, same reason.

**Notifications** ride the existing pg-boss outbox: `session_scheduled`, `session_rescheduled`, `session_cancelled` to the proposer and any paired co-hosts, plus `schedule_published` to everyone. The five Postgres triggers in `20260220185808_notification_triggers.sql` are replaced by application-level emission at the port call site — triggers cannot see the audit context and cannot be tested.

---

## 7. Identity and onboarding

**Primary door — a fresh gathering identity.** `POST /api/auth/signup {email}` → magic link → `createInviteCode` (admin) → `createAccount` on our PDS → password wrapped AES-256-GCM under a versioned key → `HttpOnly; Secure; SameSite=Lax` cookie. `apps/appview/src/lib/custody.ts` is reused unchanged, including `takeOwnership` (rotate password admin-side, flip `isCustodial`, show the new password once, CAR export documented) and the stranded-account re-homing path. The handle is chosen by the member at onboarding or generated; **never derived from the email**.

**Secondary door — an existing ATProto account.** Server-side OAuth (`@atproto/oauth-client-node`, confidential client, DPoP, PAR) with the hard-confirm sheet stating the permanent linkage. All public toggles default off; a Bluesky-door participant who wants a public proposal ticks a one-time confirm carrying `confirmPublicLinkage: true` (refinement spec R-3). Bluesky profile import runs on first callback, avatar re-encoded through `normalizeImage`, text stored app-side.

**There is no wallet door.** This will be argued about at an Ethereum conference, so the reasoning should be written down: a wallet address as the sign-in identity makes the DID document — world-readable, permanent, un-deletable — a link between a person's on-chain history and their conference attendance. That is the exact shape of disclosure R9 exists to prevent, and unlike a handle it cannot be rotated. Sign-in is email or ATProto.

**What happens to the `ens` field.** `profiles.ens` is a free-text column today, unverified, exposed to anyone with the read API key. In the port it becomes: (a) a **self-written** field in the app-side profile — only the DID holder can set it on their own row; (b) **verified app-side** by the AppView resolving the ENS name and checking that the resolved address signed a challenge nonce, storing `ens_verified_at`; (c) **never a public claim by anyone else** — no organiser, no importer, no CSV can write an ENS onto someone's profile; (d) **not a record by default**. A participant who wants their ENS on the network already has a mechanism: they can set it as their ATProto handle via `did:web`-style domain verification, which is their own act in their own DID document. `telegram` follows identical rules and, being a direct contact channel, stays members-only always.

**Handle domain and PDS hostname.** One shared PDS on a hostname that names no gathering (`pds.<neutral>`, not `pds.ethboulder.xyz`). Handles under one neutral domain by default. A gathering that insists on `*.ethboulder.xyz` handles gets the warning verbatim from multi-school §12 Q4: every member's DID document then permanently announces which conference they attended. Offer it with that sentence attached, or refuse (risk 5). Gathering subdomains (`ethboulder.schellingpoint.xyz`) require the Caddy wildcard inversion — the handle host answers only `/.well-known/atproto-did`, everything else is the PWA — plus a reserved-labels table so no participant can mint the handle `ethboulder.<domain>`.

**Ticket redemption.** Stripe Checkout → webhook confirms `sp_ticket.status = 'confirmed'` → the holder's DID gets an `sp_membership` row for the gathering and, if the tier `allows_voting`, a credit allowance for the open round. If the purchaser has no DID yet, the checkout session carries an email; the confirmation mail is a magic link that creates the custodial account and binds the ticket in one step. An unbound ticket is a row with an email and no DID, and is redeemable exactly once.

---

## 8. Multi-tenancy

Schelling Point is already multi-tenant; the port changes what a tenant *is*. `events` (a row) becomes a **gathering**: a DID, a `schellingpoint.draft.gathering` record at `rkey=self`, a `freeschool.draft.policy` it points at, a custodied credential, and a row of app-side operational facts.

```sql
CREATE TABLE sp_gathering (
  did             text PRIMARY KEY,
  slug            text NOT NULL UNIQUE,      -- 'ethboulder'; the subdomain label
  name            text NOT NULL,
  handle          text NOT NULL,
  pds_url         text NOT NULL,             -- shared PDS by default
  custody         text NOT NULL DEFAULT 'app',
  phase           text NOT NULL DEFAULT 'draft',
  theme           jsonb NOT NULL DEFAULT '{}',
  stripe_account_id text,
  created_by_did  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sp_gathering_domain ( host text PRIMARY KEY, event_did text NOT NULL, kind text NOT NULL, verified_at timestamptz );
CREATE TABLE sp_gathering_credential ( event_did text PRIMARY KEY, identifier text NOT NULL, key_version text NOT NULL, wrapped bytea NOT NULL, rotated_at timestamptz, last_ok_at timestamptz, last_error_at timestamptz );
CREATE TABLE sp_membership ( did text NOT NULL, event_did text NOT NULL, door text NOT NULL, directory_listing boolean NOT NULL DEFAULT true, public_role boolean NOT NULL DEFAULT false, joined_at timestamptz, left_at timestamptz, PRIMARY KEY (did, event_did) );
```

**The dividing rule is imported verbatim:** *what the participant wrote about themselves is global; what a gathering observed, decided, or was told in confidence is per-gathering.* Global: DID, handle, custodial credentials, email, profile, skill claims, notification transports, sessions (with a *current gathering*). Per-gathering: policy, organisers, membership, invites, tickets, votes, credits, RSVPs, check-ins, feedback, moderation, audit, peers, listings, notifications feed rows, newsletter subscriptions.

**`fs_*` → `sp_*`, every scoped table carrying `event_did` as the leading index column.** The three that matter most:

- `sp_credit_ledger` and `sp_vote` are keyed by `round_id`, which is keyed by `event_did` — a participant's EthBoulder credits can never be spent at another gathering, which a global `profiles.vote_credits` column (today's schema) makes possible by construction.
- `sp_attendance_tally` PK is `(did, event_did)`. A global tally would let attendance at one conference derive hosting rights at another.
- `sp_membership` is the roster and is never public, never counted across gatherings. Another gathering is the public: an EthBoulder organiser has no more right to a different conference's roster than a stranger does. `GET /api/members/:did` returns **404**, not 403, for a DID with no shared gathering.

**Actor registry.** `SchoolActorPort` is already per-tenant in its interface — every method takes the DID. The wiring becomes an LRU-bounded, TTL'd `Map<Did, SchoolActorPort>` loading credentials from `sp_gathering_credential`, evicted on rotation, persistent auth failure or archival. A gathering with a revoked credential fails only its own writes, with an organiser-visible banner; today's single module-scoped actor would take the whole process down.

**Routing.** `<slug>.schellingpoint.<tld>` serves the gathering PWA; the apex serves sign-in, OAuth, the gathering picker and cross-gathering views. One confidential OAuth client on the apex; the callback sets a `Domain=.schellingpoint.<tld>` cookie and redirects to the subdomain carried in `state` and validated against `sp_gathering_domain`. Current gathering is a server-side session field resolved from the `Host` header, never parsed from the URL by the client. `ethboulder.xyz` becomes an alias row that 301s to the canonical subdomain; a full custom origin is a later phase.

**Creating a gathering.** The 8-step wizard survives, with one step added and one changed. Added: *claim your gathering's identity* — mint the DID on the shared PDS (or bring your own), appoint the founder organiser, write the `gathering` and `policy` records. Changed: the Voting step now writes policy thresholds (credits, mechanism, windows, `destructiveActionStewards`, `feedbackK`, `publishRoles`) as a record rather than columns. `GATHERING_CREATION` starts `closed` (operator only), as Free School's `SCHOOL_CREATION` does.

**Leaving and ending.** `sp_membership.left_at` hides a participant from the directory and retracts any published role claim; their proposals stay on the calendar because they are the proposer's own records and the gathering has no authority over them. Ending a gathering sets `phase: completed`, then `archived`: the app-side tables are swept per retention policy (votes collapse to the published tally, credit ledgers are already gone, ticket PII is reduced to a count), while **every public record stays exactly where it is, forever, in the repos that own it**. That is the archival story, and it is better than the current one: the schedule outlives the Supabase project, the Stripe account and the domain.

---

## 9. App-side data model

Everything here is behind `packages/spaces-shim`'s `SpaceStore`, backed by Postgres in v1, so the Phase-2 move to real Spaces is a backend swap rather than a rewrite. Two spaces per gathering — `members` (roster, RSVPs, attendance, tickets) and `ballots` (votes, feedback) — with `hostMayRead: false` on `ballots`.

| Table | Holds | Why it can never be public | Retention |
|---|---|---|---|
| `sp_vote_round`, `sp_ballot`, `sp_vote`, `sp_credit_ledger` | the whole voting system | preference intensity + identity; §5 | ledger deleted at close; key nulled at close; votes collapse to the tally at archival |
| `sp_ticket`, `sp_ticket_tier`, `sp_checkin` | entitlements, payments, check-ins | attendance and spending; a public ticket is a public whereabouts claim | payment identifiers reduced at archival; check-in times to counts at 90 days |
| `sp_rsvp` | going/waitlist/cancelled | forward-looking co-presence graph (R9's first casualty) | counts only after the session |
| `sp_attendance`, `sp_attendance_tally` | host-attested presence | names a DID its holder did not write | counts at 90 days |
| `sp_membership`, `sp_gathering_credential` | the roster and the custodied credential | R9's hardest rule; and a credential | while the gathering lives |
| `sp_cohost_invite` | pending co-host invites, pre-acceptance | naming an invited person before they accept is precisely the thing double opt-in exists to prevent | `created_by` nulled 30 days after redemption |
| `sp_invite` | event invitation tokens and roles | the invite graph is the organising graph | inviter nulled at 30 days |
| `sp_notification`, `sp_notification_pref`, `sp_notification_outbox` | 17 types, 5 categories | a notification feed is an activity log | 90 days |
| `sp_favorite` | personal schedule | a private interest list | with the account |
| `sp_moderation_queue`, `sp_audit` | cases, reasons, every port call | reasons and subjects are never public; only the enum-only projection is | audit retained; case files organiser-only behind a two-person rule |
| `sp_app_meta profile:<did>`, `sp_track_lead`, `sp_event_extra` | profile, track leads, attendee-only session detail (Telegram group URL, meeting link, exact address) | the class form promises "shown after RSVP"; a public record cannot keep that promise | with the account / gathering |
| `sp_schedule_draft` | unpublished schedule work | a draft schedule is a set of decisions not yet made | superseded on publish |

Logs carry no bodies, no DIDs, no emails; IPs truncated and dropped at 7 days. `privacy-audit.ts` runs per gathering in CI and in the release script, and gains four Schelling-Point-specific assertions: no `schellingpoint.draft.*` record in any repo contains a DID other than its author's; `sp_vote` has no `did` column; no `sp_vote_round` past `closes_at` has a non-NULL `ballot_key`; no scoped `sp_*` row has a NULL `event_did`.

---

## 10. Interop and publication tiers

Four tiers, as in the interop audit: **Firehose** (any ATProto app via a relay or Jetstream), **Peer instances** (another Schelling Point or Free School AppView with our PDS in its registry — it sees *every* public record in the repos it follows, there is no per-collection filter), **Within the gathering** (served by `/api/*` to a signed-in member), **Not published**.

| Entity | Repo | Firehose | Peer | Within | Not pub. | Reason |
|---|---|---|---|---|---|---|
| Gathering record + its calendar event | gathering actor | yes | yes | yes | — | a conference's existence is the point |
| Policy | gathering actor | yes | yes | yes | — | the rules are data |
| Proposal | **proposer** | yes | yes | yes | — | the proposer's own public offer; travels with them |
| Time preference | proposer | opt-in | opt-in | yes | default | says where a person is *not*, for a week |
| Co-host record | **co-host** | yes | yes | yes | — | names only its author; the pair is rendered, not asserted |
| Track, Venue, Slot grid | gathering actor | yes | yes | yes | — | places and structure, not people |
| Scheduled session (calendar event + config) | gathering actor | yes | yes | yes | — | the schedule is the public good |
| Slot (provenance sidecar) | gathering actor | yes | yes | yes | — | links the schedule to the offer without editing the offer |
| Listing (cross-listing) | curating actor | yes | yes | yes | — | curation ≠ authorship; removal must not touch the author's record |
| Tally | gathering actor | yes | yes | yes | — | counts and presence only, k-suppressed |
| Endorsement | participant | yes | yes | yes | — | the participant chose to say it |
| Exact venue address | inside the event record, **coarsened by our API** | yes | yes | ticket-holders only | — | tiered disclosure; the record itself carries neighbourhood for a private home |
| Role claim ("I hosted at EthBoulder") | gathering actor | opt-in | opt-in | yes | — | three gates: policy `publishRoles`, subject opt-in, derived role ≥ Host |
| Opt-in RSVP | attendee | opt-in | opt-in | yes | — | they wrote it about themselves; permanence sentence shown |
| Votes, credits, ballots | — | — | — | tally only | **yes** | §5 |
| Tickets, payments, check-ins | — | — | — | holder + organisers | **yes** | attendance and spending |
| RSVP (default), attendance | — | — | counts | counts | **yes** | co-presence graph |
| Roster, track leads, co-host invites pending | — | — | — | members / organisers | **yes** | R9's hardest rule |
| Moderation reason, subject, case file | — | — | — | organisers | **yes** | enum-only public projection |
| Profile, ENS, Telegram | — | — | — | members | **yes** | self-written, verified, never a record by default |
| Handle, DID, DID document | PDS + plc.directory | **unavoidably** | yes | yes | — | protocol-level; mitigated by the neutral hostname |

**What Schelling Point and Free School share.** Three things, and they are not incidental:

1. **`community.lexicon.calendar.event`.** A Free School class and a Schelling Point session are the same kind of record. A Free School instance that adds a gathering's PDS host to `PEER_PDS_HOSTS` indexes its sessions; if the session's config carries a routed tag (`skillshare`, `free-school`), the Free School actor writes a `coop.lexicon.event.listing` and the session appears on the Boulder calendar. The reverse works identically: a gathering routing on `free-school` picks up Free School classes and can list them in a "community sessions" track. Neither side edits the other's record; each writes its own listing, and each can remove its own listing without touching the source.
2. **`coop.lexicon.event.listing` and the tag-routing convention.** Same mechanism, same COhere path. The one open question is COhere de-duplication when two instances both list one event (multi-school §12 Q8, for Aaron Gabriel).
3. **The skill taxonomy.** `freeschool.draft.skill`, one authority DID, `rkey = slug`, 525 nodes plus the refinement expansion. A Schelling Point track carries skill URIs and a proposal carries up to five; a person's `freeschool.draft.skillClaim` — written in their own repo at a free school — makes them findable as a potential speaker at a conference without either system holding a profile the other wrote. This is the cross-app payoff and the reason not to invent a `schellingpoint.draft.topic` taxonomy. `topics[]` stays as free text for the long tail.

The honest caveat, imported from the interop audit: **the top tier is currently empty.** `PDS_CRAWLERS=` means the production PDS announces to no relay, so every "firehose" row above is eligible-not-announced — reachable by someone who knows to fetch our PDS host, not by a Jetstream consumer. That is one switch, and flipping it is a deliberate decision with its own privacy consequences, not an oversight to fix in passing.

---

## 11. Migration plan

Five phases. Dual-run throughout; no big-bang cutover.

**Phase 0 — the AppView, no data.** Stand up `apps/appview` (contrail + Hono + pg-boss) and the PDS beside the existing Next.js app. Port the lexicons, the actor port, the spaces shim, custody and roles. Ship `POST /api/gatherings` and create one throwaway gathering end to end: propose, vote, close, tally, schedule, publish. Nothing in Supabase is touched. Exit criterion: `privacy-audit` green, tenant-isolation suite green, a generic calendar client renders the test schedule.

**Phase 1 — identity, with a claim flow.** Every `profiles` row gets `sp_profile_claim(email_hash, legacy_profile_id, claimed_by_did, claimed_at)`. Existing participants are mailed a magic link; clicking creates their custodial DID (or runs the OAuth door) and binds it to the legacy row, carrying over display name, bio, avatar (re-encoded), affiliation, interests, and **self-asserted** ENS/Telegram — which the claim flow presents for confirmation rather than importing silently, since we cannot know the person still wants them public. Unclaimed profiles never get a DID. Email addresses are hashed in the claim table; no email is ever a record.

**Phase 2 — the gathering's own data.** For each event: mint the DID, write `gathering`, `policy`, every `venue`, every `track`, and the slot grid, all through the actor port with an audit reason of `migration:<event_slug>`. Track leads, theme and Stripe config go to app-side tables. This is safe to run repeatedly: deterministic rkeys from the legacy UUIDs make it idempotent.

**Phase 3 — proposals, and the unclaimed-author problem.** This is the hard migration and it has no clean answer, so the ugly one is stated plainly: **we cannot write a record into a repo we do not control.** A `sessions` row whose `host_id` has not claimed a DID cannot become a proposal in that person's repo. Three cases:

- *Author claimed their DID.* The migration writes `schellingpoint.draft.proposal` into **their** repo using the custodial credential (custodial accounts only; OAuth-door participants are asked to click "publish my past proposals"). Full fidelity.
- *Author has not claimed.* The gathering actor writes a **stub** into its own repo: a `schellingpoint.draft.proposal` with `imported: true`, `importedFrom: "<legacy system>"`, no host name, and the title/description/format/duration only. It names nobody. The gathering's schedule references it and the calendar is complete. When the original author later claims their DID, a one-click **adopt** flow writes the real proposal into their repo, writes a new slot strongRef'ing it, and deletes the stub — the transfer is visible on the network as a replacement, which is correct, because it is one.
- *`host_id` is NULL* (the curated-speaker case: 843-line and 1086-line seed migrations wrote speaker sessions with `host_name` free text and no profile). Stub, permanently, unless a person turns up to claim it. **`host_name` is not migrated to any public field.** It survives in `sp_event_extra.legacy_host_name`, members-only, rendered as "listed as: Alice Smith (unclaimed)" with an adopt link. This is the one place the migration visibly loses something, and it loses it on purpose: a public record asserting that Alice Smith spoke at EthBoulder, written by us, is exactly the rule's target.

Two lexicon fields exist for this: `imported: boolean` and `importedFrom: string` on `proposal`, both absent on anything a human writes.

**Phase 4 — votes, tickets, everything app-side.** `votes` → `sp_vote` with a synthetic closed round per event: generate a round, compute tokens for each distinct `user_id` **that has claimed a DID** (unclaimed voters get a random token — their votes still count, they are simply already unlinkable), insert `sp_vote` rows in randomized batches with `day` from `created_at::date`, then never write `ballot_key` at all. The published tally is computed from the result and written by the actor. `session_rsvps`, `tickets`, `ticket_tiers`, `notifications`, `favorites`, `event_invitations`, `cohost_invites` copy across with `event_did` attached. `session_cohosts` becomes a set of **pending** invites, not records: we cannot write a co-host's acceptance for them. Each existing co-host gets a mail: "you're listed as a co-host on X; confirm to publish."

**Dual run.** Phases 1–4 run with the Next.js app live and read-only against Supabase for the legacy path, while the new PWA serves `/e/<slug>` traffic from the AppView behind a per-gathering flag. Reads are served from the AppView once a gathering's Phase-3 run is complete and reconciled; writes are cut over gathering by gathering. A reconciliation job diffs counts (proposals, votes, tallies, RSVPs, tickets) nightly and alerts on drift.

**Cutover** is a DNS change per gathering plus flipping its flag. **Rollback** is flipping the flag back: Supabase is untouched and authoritative until the flag flips forward, and forward-written records are additive — a rolled-back gathering leaves real records on the network, which is inconvenient but not corrupting. The one irreversible step is minting DIDs, and a DID nobody uses costs nothing.

**What is lost.** Nothing public that named a non-author — which is the point. Concretely: curated-speaker names on public records, admin-assigned co-hosts, track lead names, the global `is_admin` flag, live mid-round tallies, and the shared-API-key read endpoint that exposed every participant's ENS and Telegram. Each was a privacy defect, not a feature.

---

## 12. Deployment

Reuse `infra/production/compose.yml` verbatim: Caddy (TLS + the built PWA) → AppView (Hono + contrail + pg-boss) → Postgres 16 → `ghcr.io/bluesky-social/pds:0.4`. Only Caddy publishes ports. Changes:

- **Caddyfile wildcard inversion** (multi-school §3): `*.{$HANDLE_DOMAIN}` serves `/.well-known/atproto-did` from the PDS and everything else from the web tier, so `ethboulder.<domain>` is the gathering PWA while member handles still resolve. On-demand TLS `ask` defers to `sp_gathering_domain` via a container-local `/internal/tls-check`, answering from the table and never from a pattern, so the Let's Encrypt 50-certs-per-registered-domain-per-week ceiling cannot be hit by a runaway ask.
- **Shared PDS hostname.** One PDS for every gathering, on a hostname that names none of them. This is the single most load-bearing deployment decision in the document and it is not negotiable per-tenant: a PDS per conference writes conference attendance into every member's DID document, permanently. (Free School's own `PDS_HANDLE_DOMAIN=freeskool.xyz` is already flagged as not neutral enough; do not repeat it — pick the neutral name before the first account exists, because handles are mutable and DIDs are not.)
- **Env.** Existing Free School variables plus `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `GATHERING_CREATION` (`closed|invite|open`), `SP_APEX_HOST`, `SP_GATHERING_DOMAIN_SUFFIX`. Gathering credentials move out of env into `sp_gathering_credential`, wrapped under the versioned `CUSTODY_KEYS`; `SCHOOL_*`-style env vars survive only as a one-time bootstrap import path.
- **Backups.** Encrypted, retention-capped, PITR ≤ 7 days. The PDS volume and the Postgres volume both. Note the asymmetry: repo data is reconstructible from the network if a peer has it; app-side data is not, and app-side data is the sensitive half. Backup encryption keys are not held on the box.
- **Release gate.** A release ships only when, in CI: `pnpm -r test`, `pnpm -r typecheck`, `pnpm lexicons:validate`, the tenant-isolation suite, and `privacy-audit --gathering=<did>` for every gathering all pass — including the four new assertions in §9. The privacy audit runs against a seeded dev PDS and must report zero violations; that is what proves a new feature wrote no forbidden record. A failing privacy audit is a release blocker, not a warning.

---

## 13. Risks and open questions for Benjamin

1. **Is this a fork of Free School or a sibling?** Every core package (`school-actor`, `spaces-shim`, `shared`, `lexicons`, `pds-follow`) is reused nearly unchanged. Shared monorepo with two apps, or two repos with published packages? The former is cheaper and couples release cycles; the latter is honest about two products with different funders.
2. **Namespace.** `schellingpoint.draft.*` mirrors `freeschool.draft.*` and inherits the same "rename when Lucian normalises" plan. Does Schelling Point wait for the same normalisation, or claim a namespace of its own sooner? A conference tool has an argument for moving faster.
3. **Money.** Free School principle 2 is "no money in the app, ever". Schelling Point has Stripe, ticket tiers, revenue dashboards and a PRD promising 5–7% of distributed funds. The architecture is indifferent — money stays app-side either way — but the two products cannot share a principles document. Confirm that Schelling Point inherits the *architecture* and not that principle, and that this is written down where a contributor will see it.
4. **The public-tally / verifiability trade (§5.6).** Losing publicly re-computable vote totals is a real cost at an Ethereum conference. Is the k-suppressed actor-signed tally acceptable for v1, with the ballot-token commitment as a phase-2 item, or does verifiability need to ship first?
5. **Per-gathering handle domains.** A conference that wants `*.ethboulder.xyz` handles is asking for every attendee's DID document to announce their attendance forever. Offer with the warning, or refuse outright? (Same question as multi-school Q4, with higher stakes: a conference is a more sensitive affiliation than a city.)
6. **Who may create a gathering?** `GATHERING_CREATION` starts `closed`. Anything at `*.schellingpoint.<tld>` reads as endorsed. Does it ever open?
7. **Relay announcement.** `PDS_CRAWLERS` empty means nothing reaches the firehose. Conference schedules are the most obviously-public thing either system produces and the strongest case for announcing. Flip it for Schelling Point while Free School stays dark, or keep them aligned?
8. **Curated speakers.** The EthBoulder seed data is ~1,900 lines of speaker sessions with free-text names and no profiles. Under R9 those names cannot reach a public record we write. Is "listed as: Alice Smith (unclaimed)", members-only, with an adopt link, an acceptable public schedule for a conference whose speakers are its marketing? This is the migration's sharpest product conflict.
9. **Attendance voting and budget distribution** (PRD §2.3–2.4) are unbuilt, and quadratic *funding* over per-person votes needs per-person data at compute time. The ballot-token design supports it (QF needs √ per ballot, not per person), but paying out money against it needs an audit trail that points at people. Is this in scope at all, or formally dropped?
10. **Timing against COhere.** Free School v1 must ship before COhere in October 2026. Does any of this start before that, or is the whole port a post-October branch?
11. **EthBoulder's calendar exchange.** Cross-listing EthBoulder sessions onto the Free School / COhere calendar is an outward-facing act. Per `CLAUDE.md`, that needs an explicit OK before anything is exchanged.

---

## 14. Appendix

### A. Supabase table → new home

| Supabase | New home | Kind |
|---|---|---|
| `profiles.id/email` | DID on the shared PDS + `sp_custodial_account` | identity |
| `profiles.display_name/bio/avatar_url/affiliation/building/interests` | `sp_app_meta profile:<did>` (global) | app-side |
| `profiles.ens/telegram` | `sp_app_meta profile:<did>`, self-written, `ens_verified_at` | app-side |
| `profiles.is_admin` | deleted → `deriveRole()` | derived |
| `profiles.vote_credits` | `sp_vote_round.credits` + `sp_credit_ledger` | app-side |
| `events` | `schellingpoint.draft.gathering` + `freeschool.draft.policy` + `sp_gathering` | record + app-side |
| `event_members` | `sp_membership` | app-side |
| `sessions` (content) | `schellingpoint.draft.proposal` (proposer's repo) | record |
| `sessions` (schedule) | `schellingpoint.draft.slot` + `community.lexicon.calendar.event` (gathering repo) | record |
| `sessions.time_preferences` | `schellingpoint.draft.timePreference` or `sp_time_preference` | record / app-side |
| `sessions.telegram_group_url`, `custom_location` | `sp_event_extra`, RSVP-gated | app-side |
| `sessions.host_name` | `sp_event_extra.legacy_host_name`, members-only | app-side |
| `sessions.total_votes/total_credits/voter_count/rsvp_count/waitlist_count` | derived; published only in `schellingpoint.draft.tally` | derived |
| `votes` | `sp_ballot` + `sp_vote` + `sp_credit_ledger` | app-side |
| `favorites` | `sp_favorite` | app-side |
| `venues` | `schellingpoint.draft.venue` | record |
| `time_slots` | `schellingpoint.draft.slotGrid` | record |
| `tracks` | `schellingpoint.draft.track` | record |
| `tracks.lead_*` | `sp_track_lead` | app-side |
| `session_cohosts` | `schellingpoint.draft.cohost` (co-host's repo) | record |
| `cohost_invites` | `sp_cohost_invite` | app-side |
| `session_rsvps` | `sp_rsvp` (+ opt-in `community.lexicon.calendar.rsvp`) | app-side / record |
| `ticket_tiers`, `tickets` | `sp_ticket_tier`, `sp_ticket` | app-side |
| `event_invitations` | `sp_invite` | app-side |
| `notifications`, `notification_preferences` | `sp_notification*` | app-side |
| Supabase Storage `event-assets` | PDS blobs (record images) / app-side object store (theme) | mixed |

### B. Lexicon inventory

New (`schellingpoint.draft.*`): `gathering` (literal:self, gathering actor), `proposal` (tid, proposer), `cohost` (tid, co-host), `timePreference` (tid, proposer), `track` (tid, gathering), `venue` (tid, gathering), `slotGrid` (tid, gathering), `slot` (tid, gathering), `tally` (tid, gathering), `endorsement` (tid, participant). Ten records.

Borrowed, unmodified: `community.lexicon.calendar.event`, `.rsvp`, `community.lexicon.location.{address,geo,fsq,hthree}`, `coop.lexicon.event.{config,listing}`, `coop.lexicon.membership`, `com.atproto.repo.strongRef`, `freeschool.draft.{policy,series,occurrence,skill,skillClaim,approval,moderationAction,hostFeedback}`. All validated against `packages/lexicons/vendor/`; the `coop.lexicon.*` shapes remain ASSUMED until Lucian normalises the namespace.

### C. AppView endpoints

Auth: `POST /api/auth/signup`, `POST /api/auth/signin`, `GET /api/auth/verify`, `GET /oauth/authorize`, `GET /oauth/callback`, `POST /api/auth/signout`, `GET /api/auth/me`, `POST /api/me/take-ownership`.

Gatherings: `POST /api/gatherings`, `GET /api/gatherings`, `GET /api/gatherings/:did`, `PUT /api/gatherings/:did/policy`, `POST /api/gatherings/:did/phase`, `GET /api/gatherings/:did/how-it-works`.

Proposals: `POST /api/proposals`, `GET /api/proposals?gathering=`, `GET /api/proposals/:uri`, `PUT /api/proposals/:uri`, `DELETE /api/proposals/:uri`, `POST /api/proposals/:uri/adopt` (claim an imported stub), `POST /api/proposals/:uri/cohost-invite`, `POST /api/cohost-invites/:token/accept`, `DELETE /api/cohosts/:uri`.

Voting: `POST /api/gatherings/:did/rounds`, `GET /api/gatherings/:did/rounds/current`, `PUT /api/rounds/:id/allocation`, `GET /api/rounds/:id/allocation` (own only), `POST /api/rounds/:id/close` (port call), `GET /api/rounds/:id/tally` (409 while open), `POST /api/proposals/:uri/endorse`, `DELETE /api/endorsements/:uri`.

Schedule: `GET /api/gatherings/:did/schedule`, `POST /api/gatherings/:did/schedule/auto`, `PUT /api/gatherings/:did/schedule/draft`, `POST /api/gatherings/:did/schedule/publish`, `POST /api/slots/:uri/move` (destructive), `POST /api/slots/:uri/cancel` (destructive), `GET /api/gatherings/:did/calendar.ics`, `GET /api/slots/:uri/calendar.ics`.

Venues/tracks: full CRUD under `/api/gatherings/:did/{venues,tracks,slot-grid}`, all port-mediated.

People and membership: `GET /api/members` (requireViewer, noindex), `GET /api/members/:did` (404 for non-shared), `PUT /api/me`, `PUT /api/me/handle`, `POST /api/me/verify-ens`, `POST /api/me/publish-role-claim`, `DELETE /api/me/role-claim`.

RSVP, tickets, check-in: `POST /api/slots/:uri/rsvp`, `DELETE …`, `GET /api/gatherings/:did/tiers`, `POST /api/gatherings/:did/checkout`, `POST /api/webhooks/stripe`, `GET /api/tickets/:id`, `GET /api/tickets/:id/qr`, `POST /api/gatherings/:did/checkin`.

Feedback and moderation: `POST /api/slots/:uri/feedback`, `GET /api/slots/:uri/feedback-summary`, `GET /api/gatherings/:did/moderation`, `POST /api/gatherings/:did/moderation/:id/approve`, `POST /api/gatherings/:did/moderation/:id/act`.

Notifications and admin: `GET /api/notifications`, `POST /api/notifications/read`, `PUT /api/me/notification-prefs`, `POST /api/gatherings/:did/broadcast`, `GET /api/gatherings/:did/analytics` (organisers only), `PUT /api/admin/peers`, `GET /api/health`.

Deleted: every `rest/v1/*` browser write, and the shared-key `/api/v1/{sessions,profiles,tracks,venues,timeslots,schedule}` read API.

---

*Sources: `schellingpoint@main` — `supabase/schema.sql`, all 41 migrations, `src/**`, `docs/{api-guide,IMPLEMENTATION_HANDOFF,MULTI_TENANT_EVOLUTION_STRATEGY}.md`, `.claude/schelling_point_PRD.md` v3.0. Free School — `CLAUDE.md`, `docs/{architecture,prd,research-brief-v0.2,interop-audit}.md`, `docs/superpowers/specs/2026-09-13-{multi-school,refinement-phase}-design.md`, `packages/{lexicons,school-actor,spaces-shim,shared}`, `apps/appview/src/lib/{custody,feedback}.ts`, `infra/production/compose.yml`.*
