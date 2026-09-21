# unconference.events — polish, feed, map, cluster scheduling, knowledge harvest

Design for the next release of the `atproto` branch. Written 2026-09-21 from five audits saved under
`docs/design/audits/` (settings/wizard UX, gathering-page UX, profile hydration trace, gathering
actor map, PRD extraction). Everything here obeys `docs/ATPROTO_MIGRATION_SPEC.md`; where the PRD and
the spec disagree, the spec's privacy rules win and the PRD's product intent is carried as far as
the rules allow.

## 0. Goals

1. The app feels finished: consistent controls, spacing, wording and feedback on every surface; no
   dead ends; nothing product-specific where a generic word will do ("chat group", not "Telegram").
2. A Bluesky-account sign-in shows the person as they are on the network (name, avatar, bio,
   handle) and stays current.
3. A gathering has a followable network presence: a profile record and a feed of posts about its
   own activity, mentioning hosts only with their consent.
4. Organizers can place their gathering on a map; participants can read the schedule by place.
5. Auto-scheduling does what the PRD promised: separate sessions that share an audience, size rooms
   by demand, respect constraints, and show its reasoning.
6. Session transcripts can be gathered, read, exported as an embeddings-ready corpus, and (when a
   provider is configured) queried as "ask the gathering".
7. Settings help people find each other and find their way.

Non-goals for this release: on-chain budget distribution, NFT gating, burner cards (PRD Phase 2/3
hardware), multi-tenant platform admin, i18n.

## 1. Waves and ownership

Work is sequenced so that every wave ships independently and the branch stays green between them.

| Wave | Scope | Depends on |
|---|---|---|
| **P** Polish | §2 cross-cutting fixes, §3 per-surface fixes, §4 generic naming, §5 identity hydration, §6 settings IA | — |
| **F** Feed | §7 gathering profile record + activity posts + mention consent | P (NetworkSection) |
| **M** Map | §8 venue/self-hosted geo, organizer map setup, participant map | P (setup page) |
| **S** Scheduler | §9 cluster-aware scheduling, audience clusters panel, quality score, constraints | — |
| **K** Knowledge | §10 transcripts, corpus export, embeddings + ask | P (session detail) |
| **A** Attendance | §11 in-event attendance voting (PRD §2.3) — scoped, opt-in per gathering | S (round machinery) |

Verification gate for every wave (from `CLAUDE.md`): `npm run typecheck`, `npm run lexicons:validate`,
`npm run build`, `npm test`, `npm run test:sql`, `npm run atproto:audit`, plus screenshots of every
touched surface at 390px and 1280px checked by eye.

## 2. Cross-cutting fixes (Wave P, first)

These explain most of the per-surface noise in the audits and are done before anything else.

1. **`globals.css` h1 clamp.** The un-layered `.workspace-content h1` rule (line 264) overrides every
   page's own size. Delete it and its twin at line 133; introduce `.page-title` (`text-2xl md:text-3xl
   font-display font-semibold tracking-tight`) and a `<PageHeader title subtitle actions>` component
   used by every workspace and admin page. Delete the `[class*="text-3xl"]` hack.
2. **One vocabulary per status.** `src/lib/labels.ts` exports `EVENT_STATUS`, `SESSION_STATUS`,
   `NOTIFICATION_TYPE` (label + badge variant + dot colour). Delete the four event-status maps, the
   three session-status vocabularies and the two notification colour maps. `live` is `success`, never
   `destructive`. No page renders `session.status` raw.
3. **Tokens, not palette.** Replace `green-*`, `emerald-*`, `amber-*`, `yellow-*`, `orange-*`,
   `red-*`, `blue-*` with `success`, `amber`, `destructive`, `primary`, `muted`. Add
   `Alert variant="success"|"warning"`, a `WarningBox` (`--signal-amber`), and a `--favorite` token.
   `btn-primary-glow` is deleted (undefined).
4. **Missing primitives** in `src/components/ui`: `select.tsx` (native select styled to `Input`
   height), `switch.tsx`, `filter-chip.tsx`, `segmented-control.tsx`, `confirm-inline.tsx`
   (Cancel + verb, one vocabulary), `removable-chip.tsx` (real button, `aria-label`), `page-header.tsx`,
   `success-panel.tsx`, `dialog.tsx` wrapper over Radix used by SettingsModal, EditSessionModal,
   confirm dialogs. Replace the 6 select styles, 4 switches, 4 filter-pill idioms, 2 segmented
   controls, 4 confirm patterns, 7 chip styles.
5. **Buttons.** Use the `loading` prop (delete 12 hand-rolled spinners). Minimum touch target is the
   `icon-sm` token (40px); delete every `h-7 w-7`/`h-8 w-8`/`h-9 w-9` override. Form footers are
   Cancel (outline, left) + submit (right) everywhere. One label per action: "Create a gathering",
   "Propose a session", "Sign in", "Organizer workspace", "Gathering page", "Save changes".
6. **Sentence case** throughout; `…` not `...`; `’` in prose; American spelling; `·` as separator;
   "(optional)" on optional fields and no asterisks; singular/plural helper for counts.
7. **Sticky offsets** from one `--workspace-header-h` variable. Login return param is `returnTo` only.
8. **Feedback.** Every mutation shows success (toast with `role="status"`) or an inline error box;
   nothing auto-closes a modal on save; no native `confirm()`/`alert()`.

## 3. Per-surface fixes (Wave P)

The audits are the checklist; this section records only decisions that go beyond "apply the fix".

- **Create wizard.** Uses `SiteHeader`; one sticky nav (Back/Continue) with Back on Review; steps
  become Identity → Basics → Dates → Venues → Schedule → Tracks → Participation → Voting → Branding →
  Review, mirroring the settings IA (safeguards live in Voting with the same `Toggle`). Admission and
  platform contribution move out of Basics into Participation. DatesStep gets cards and the shared
  `TimezonePicker`; VotingStep and BrandingStep reuse the settings kit (`Toggle`, `Checkbox`,
  `ColorPicker`, `THEME_PRESETS` exported and also rendered in `BrandingSection`). Social links become
  a repeatable list (label + URL) so any platform fits; the wizard-only `TemplateSelector` is deleted.
  On success: redirect to the organizer workspace with a "Your gathering is ready — next: add rooms
  and times" banner.
- **Propose / edit session.** Shared `SESSION_FORMATS`/`SESSION_DURATIONS`/`TIME_OPTIONS` constants;
  `Field` + `htmlFor` everywhere; success panel links to the new session; proposals-closed state
  shows when they open; duration/format grids `gap-3`; tags limit message. Neutral default tags.
  EditSessionModal on Radix Dialog; organizer block visually distinct from "selected".
- **Session detail.** Actions row above the title (no absolute positioning); "Session format" card
  removed; one Edit button; RSVP-gated chat link explains how to get it, pointing at the RSVP
  control; withdraw is outline + destructive text with an inline confirm; toast reused for favourite,
  RSVP, save. "Share on Bluesky" link (compose intent) appears for everyone (user posts from their
  own account; no consent question).
- **Dashboard.** Non-member sees a Join card; empty gathering sees "what to do first"; one button
  variant for "View all".
- **Participants.** `not_member` branch renders `JoinGatheringButton`; chips via `FilterChip`.
- **Notifications.** Shared type map; "View all" always present; Preferences button on the page;
  retry on error; no Back button.
- **Check-in** moves to `/e/[slug]/admin/checkin` (organizer shell, sidebar item points there);
  camera errors are shown; manual ticket-code entry added.
- **Admin shell.** Sidebar logo → gathering page; footer block with bell/avatar/sign-out shared with
  `DashboardLayout`; mobile breadcrumb; distinct icons; "Organizer workspace" ↔ "Attendee view".
  Admin overview h1 is "Overview & sessions" with the slogan as subtitle; empty-state offers "Add a
  session"/"Invite people". Tabs use labels. Schedule builder: destructive "Clear day" in an overflow
  menu; hint banners are muted. Analytics: no red for empty rooms; empty state. Revenue: no dead
  Export button; link to tiers. Members: sentence case, "3 of 10 used", pending-invites empty state.
  Communications: "Announcements & emails".
- **Account.** `SettingsModal` becomes "Account" with tabs Profile / Identity / Notifications /
  Chat; `SiteHeader` gets a profile menu (Account, My gatherings, Sign out); `/account` renders the
  same tabs as a page; `/e/[slug]/settings` index lists Notifications and (later) Feed mentions.
  "Take ownership" is a bordered warning block with a default-size destructive button; unsaved-change
  guard on overlay click. Reveal page gets `SiteHeader`, labelled copy button with `aria-live`, and
  a "request a new link" path.
- **Footer** renders the gathering's branding when on a gathering page ("{name} · Powered by
  unconference.events"); links at `text-sm`.

## 4. Generic naming (Wave P)

UI strings only; columns keep their names (`profiles.telegram`, `sessions.telegram_group_url`,
`theme.social.*`) and the API keeps its field names, with a comment that the UI label is generic.

| Where | New wording |
|---|---|
| Session chat link (edit modal, detail page, email) | "Chat group link (optional)" / "Join the chat group" / "This session has a chat group for confirmed attendees." |
| Profile field | "Messaging handle (optional)" with hint "Telegram, Signal, Matrix — whatever you use. Members only." Stored as free text; `https://t.me/` link only when it parses as a Telegram handle, otherwise plain text. |
| Participants privacy copy, privacy page, code of conduct | "chat groups and other community channels" |
| Gathering social links | repeatable list with a label the organizer types (Bluesky, Telegram, Discord, Signal, Website…); footer renders label + generic link icon; brand glyphs only for Bluesky and X. |

`profiles_telegram_format` CHECK is relaxed to allow any handle or URL up to 120 chars (migration).

## 5. Identity hydration (Wave P)

Findings: profile is imported from `public.api.bsky.app` only, only into blank fields, never
refreshed; the gathering account has no profile record; custodial accounts have no profile record
in their own repo.

1. **Read from the person's PDS first.** `fetchActorProfile(did, pds)` does
   `com.atproto.repo.getRecord(repo=did, collection=app.bsky.actor.profile, rkey=self)` on the
   resolved PDS through `safeFetch`; the avatar blob is fetched as
   `com.atproto.sync.getBlob` from the PDS. Fallback: the AppView `getProfile`. Both paths already
   verify `did` matches.
2. **Refresh on every sign-in and hourly for active sessions**, but never overwrite a locally edited
   field: `profiles.profile_source` (`'network' | 'local'` per field, stored as
   `synced_fields text[]`) and `profile_synced_at`. A field the person edited in the app stays local
   until they press "Re-sync from my Bluesky profile" in Account → Identity. Import runs in the
   background after the callback (the unused `importBskyProfileInBackground` becomes the only path).
3. **Handle everywhere.** Participant cards, session cards, host bylines and the sidebar show
   `@handle` under the name; fallback chain is display name → `@handle` → "Member"; the `?` avatar
   fallback is replaced by the handle's initial.
4. **Write `app.bsky.actor.profile` for the gathering account** (name, tagline/description, logo
   as avatar, banner) from `publishGathering`, through the port with action `publish-profile`.
5. **Custodial people may publish a profile record** to their own repo: Account → Identity →
   "Publish my profile to the network" (off by default, explains it makes name/bio/photo
   world-readable). Written with the person's own credential (`putRecord` as them), never by the
   gathering.
6. Delete `profiles.atproto_handle` reads/writes (shadow of `accounts.handle`); remove the stale
   `cdn.bsky.app` allowance from `normalizeAvatarUrl`.

## 6. Settings that help people find each other (Wave P)

- **Account → Profile** gains "What I'm looking for" (free text, members-only) beside interests, and
  "Show me in the directory" (existing `directory_listing`).
- **People page** gets "People who share your interests" at the top (server-computed for the viewer
  from interest overlap; members-only; never a record) and a "Looking for" chip on cards.
- **Sessions page** gets "Suggested for you" from the viewer's interests against session tags.
  Votes are never an input: they are unlinkable by design.
- **Organizer settings order:** Basics → Dates → Venues & map → Participation → Voting → Safeguards →
  Branding → Feed & network → Lifecycle → Danger zone; scroll-spy on the anchor pills; idle hint only
  when dirty; `aria-labelledby` fixed.

## 7. Gathering feed (Wave F)

### 7.1 What it is

A gathering's account posts about its own activity so anyone on Bluesky can follow it. Posts are
written by the gathering actor through the audited port; text and facets are built server-side; the
only people named are hosts who opted in.

### 7.2 Gates

- **Gathering-level:** `events.feed_posts boolean default false`, set in Feed & network settings
  ("Post activity to the gathering's feed") with a plain-language list of what gets posted.
- **Person-level:** `event_members.mention_in_posts boolean default false`, set by the person in
  `/e/[slug]/settings` ("Let this gathering mention my handle in its posts about my sessions").
  Shown only to accounts with a resolvable handle; the setting explains it is per gathering.
- **Structural:** a mention facet may name DID `d` only if (a) `mention_in_posts` is true for `d` in
  this event, (b) `d` is the session's host (`sessions.host_id`) or has a `session_cohosts` row the
  person wrote themselves, (c) `d`'s repo is visible (`visibleRepoSql`). `assertNoForeignDid` gains
  `consentedMentionDids` accepted only for `app.bsky.richtext.facet#mention.did` inside
  `app.bsky.feed.post`; the port computes the set itself (`consentedMentions()`), never from input.
  Without consent the post says "the host" and links the session page.

### 7.3 Post kinds

| Kind | Trigger | Text shape |
|---|---|---|
| `gathering-published` | gathering record first published | name, dates, place (locality), link |
| `proposals-open` / `voting-open` | lifecycle transition | one line + link |
| `schedule-published` | schedule publish | "The schedule is out: N sessions across M rooms" + link |
| `session-scheduled` | a session's slot is first published | title, day/time (event tz), room, "hosted by @handle" (consent) or "hosted by the proposer", link |
| `session-moved` / `session-cancelled` | destructive action approved and applied | replaces nothing; a new post referencing the change |

Posts carry an `app.bsky.embed.external` link card (title, description, gathering thumb) and `langs`.
Text is limited to 300 graphemes; the builder truncates the title with `…` before the link.

### 7.4 Idempotency, delivery, audit

- `feed_posts(id, event_id, kind, subject_id, uri, cid, text, facets jsonb, created_at, posted_at,
  error)` — one row per (event, kind, subject) for session kinds, one per (event, kind) for
  gathering kinds; the row exists before the write (claimed), so re-runs never double-post.
- Delivery through `publish_jobs` with `kind='feed'`, drained by the scheduler minute loop; paced by
  `paceRepoWrite`. Session-scheduled posts from one schedule publish are batched: after 10 sessions
  in one publish, a single digest post ("N sessions were added to the schedule") replaces per-session
  posts (organizer can choose per-session in settings).
- Every post is an `at_audit` row (`publish-post`); `delete-post` is destructive (two organizers).
- Admin → Network page gains a **Feed** section: toggle state, last 20 posts with links, retry
  failed, and the disclosure row in `PUBLIC_RECORDS`.
- `scripts/atproto-privacy-audit.ts`: posts are scanned for foreign DIDs (allowed only with a
  matching consent row at post time, recorded in `feed_posts.mentions jsonb`) and for host names.

### 7.5 Lexicons and port

Vendor `app.bsky.feed.post`, `app.bsky.richtext.facet`, `app.bsky.embed.external`,
`app.bsky.actor.profile` under `lexicons/vendor/bsky/`; add `app.bsky.` to `BORROWED_PREFIXES`;
`NSID.post`, `NSID.actorProfile`; `GatheringAction` gains `publish-profile`, `publish-post`,
`delete-post`; `GATHERING_COLLECTIONS` includes both. `RichText` from `@atproto/api` detects facets;
the builder then *removes* any mention facet not in the consented set and rewrites the text.

## 8. Map (Wave M)

### 8.1 Data

- `venues.latitude numeric(9,6)`, `venues.longitude numeric(9,6)`, `venues.geocoded_from text`,
  `venues.geocoded_at`. Public venues publish `community.lexicon.location.geo` inside the venue
  record's `locations`; private residences publish locality only (existing rule).
- `events.map jsonb` `{ center:[lng,lat], zoom, bounds:[[sw],[ne]] }` — the organizer's chosen view.
  App-side only; the gathering record keeps publishing its existing location fields.
- Self-hosted sessions: `sessions.location_lat/lng` (exact, attendee-only, same tier as
  `custom_location`) and `sessions.public_geo` = coordinates rounded to 2 decimals (≈1 km) shown to
  non-members and written to the calendar event's location alongside `public_place`.
- `geocode_cache(query_hash, result jsonb, fetched_at)`.

### 8.2 Services

- `POST /api/v1/events/[slug]/admin/geocode` `{ query }` → Nominatim (`https://nominatim.openstreetmap.org/search`)
  via `safeFetch` with our `User-Agent`, 1 req/s per process, cached 30 days; organizers and hosts of
  self-hosted sessions may call it (rate-limited per account).
- Tiles: MapLibre GL JS with OpenFreeMap's `liberty` style by default (`NEXT_PUBLIC_MAP_STYLE_URL`
  overrides; documented in `deploy/unconference/.env.example`). No key, no tracking; attribution
  rendered. Map component is client-only and lazy-loaded; pages render without it (list fallback).

### 8.3 Organizer UX (Spaces & times → "Map" card)

1. "Set the map area": the organizer pans/zooms and presses "Use this view"; the event's location
   address (Basics) seeds the first view via geocoding.
2. Each room row gets a "Place on map" control: address → geocode → pin; drag to adjust; "Private
   residence" hides the pin from non-members and publishes locality only.
3. Live preview beside the room list; unplaced rooms are listed under the map with a one-click
   "Place".

### 8.4 Participant UX (`/e/[slug]/map`, in the sidebar as "Map")

- Full-height map inside the workspace with the event area; venue pins with room name and a count
  badge of sessions on the selected day; self-hosted pins (exact for members who can see attendee
  details, coarse otherwise).
- Clicking a pin opens a panel (side on desktop, bottom sheet on mobile) listing that venue's
  sessions for the day in time order with "Now"/"Next" emphasis, favourite hearts and links.
- Day tabs as on the schedule; "Near me" button uses browser geolocation client-side only (never
  sent to the server).
- Session detail shows a small static map (venue pin) with "Get directions" (generic, opens the
  platform's maps app via `geo:`/Apple/Google chooser).

## 9. Cluster-aware scheduling (Wave S)

### 9.1 What the PRD asks (extraction §1)

Inputs: sessions ranked by votes, a voter-overlap matrix, demand across formats/durations.
Objective: minimize audience conflicts (cluster separation), match venue capacity to demand,
respect manual constraints, balance high-demand sessions across time slots. High overlap (>60%)
must not run concurrently; <20% is safe. Output shows a quality score and warnings; organizers
review "audience clusters" before running; drag-drop revalidates live.

### 9.2 Algorithm (pure, `src/lib/scheduling/`)

- **Overlap** over ballot tokens (spec §5.4), computed as the overlap coefficient
  `|A∩B| / min(|A|,|B|)` (the PRD's "shared voters" reading) with `|A∩B|` kept as the weight.
  Pairs where either side has fewer than `feedbackK` tokens are neither shown nor constrained.
- **Cost** of a placement = Σ over concurrent pairs `|A∩B|` (people who wanted both) ×
  (2 if overlap ≥ 0.6, 1 otherwise) + capacity penalty (`max(0, demand − capacity)`, demand =
  expected attendance or votes) + constraint violations (host blackout, pinned venue, missing
  feature) × 1000 + imbalance (variance of per-time-key total votes) × 0.1.
- **Search**: keep the greedy seed, then hill-climb: repeatedly try moving one session to any free
  slot and swapping any two sessions (or a session with a hand-placed one? no: hand-placed are fixed);
  accept improvements; stop after a pass with no improvement or 2 s. Deterministic given inputs
  (seeded order).
- **Quality score** 0–100: 100 − 60·(conflict people / total voter-session pairs) −
  25·(over-capacity people / total demand) − 15·(constraint violations > 0 ? 1 : 0), clamped.
- **Constraints**: `sessions.pinned_venue_id` (organizer pins a room), existing manual slot
  placement (fixed), host availability windows/blackouts (existing), venue `allowed_formats text[]`
  (PRD's per-venue format restriction; empty = all).

### 9.3 Organizer UX (schedule builder)

- **Audience clusters** panel before running: "Keep apart" pairs (≥60%), "Fine together" sets (<20%),
  suppressed pairs noted as "not enough voters to compare". Percentages only; never voter lists.
- **Run** shows the five PRD stages as progress, then the result with quality score, "no
  keep-apart conflicts" / "constraints met" checks and warnings (over capacity, empty room, near-miss).
- **Drag-drop** revalidates: placing a keep-apart pair concurrently shows a red warning and lowers the
  score live; the score is recomputed server-side from the draft.
- Publishing is unchanged (the audited port).

## 10. Knowledge harvest (Wave K)

### 10.1 Transcripts

- `session_transcripts(id, event_id, session_id, uploaded_by, source 'upload'|'paste', format
  'txt'|'md'|'vtt'|'srt', storage_path, char_count, language, consent_confirmed_at, visibility
  'members'|'organizers', status 'ready'|'processing'|'failed', created_at)`; one current transcript
  per session (re-upload replaces, previous kept 30 days).
- Who: the session's host, co-hosts, organizers. Consent checkbox: "Everyone in the room was told
  the session was being recorded or transcribed." Event policy toggle `transcripts_enabled`
  (default true) in Participation settings, with visibility default.
- Transcripts are **never records** and never public: members-only (or organizers-only), served
  through the app with the existing upload storage (5 MB limit, text only, normalized to UTF-8 and
  stripped of VTT/SRT timing into paragraphs with retained `[mm:ss]` markers).
- Session detail gains a **Transcript** tab (read, search in page, download) when present, and an
  "Add transcript" action for hosts/organizers.

### 10.2 Corpus export (the piece the user asked for first)

Admin → **Knowledge** page (new admin nav item):
- Coverage: sessions with/without transcripts, total words, a "request transcripts" button that
  notifies hosts of transcript-less scheduled sessions.
- **Export corpus**: `.zip` with `corpus.jsonl` (one chunk per line: `{id, session_id, title,
  hosts (display names only — this is a members-only export), track, day, start, venue, chunk_index,
  text, tags}`), `sessions.json` (metadata), `README.md` (schema + suggested embedding recipe), and
  raw transcripts as markdown. Chunking: ~800 tokens (≈3,200 chars) on paragraph boundaries with
  15% overlap. Organizers only; download is logged.

### 10.3 Embeddings and "Ask the gathering" (when configured)

- Postgres image becomes `pgvector/pgvector:pg16` (drop-in for `postgres:16-alpine` data); migration
  `create extension if not exists vector`; `transcript_chunks(id, transcript_id, session_id,
  event_id, chunk_index, text, embedding vector(1024), created_at)` with an HNSW index.
- Provider config (server-only env): `EMBEDDINGS_PROVIDER=voyage|openai`, `EMBEDDINGS_MODEL`,
  `EMBEDDINGS_API_KEY`; `ANTHROPIC_API_KEY` + `AI_CHAT_MODEL=claude-sonnet-5` for answers. Nothing
  runs without them; the Knowledge page says which parts are active.
- Ingest job (`publish_jobs kind='embed'`) embeds chunks after upload; re-embeds on replacement.
- **Ask the gathering** (members-only page `/e/[slug]/ask`, and a panel on Knowledge): question →
  embed → top-8 chunks (event-scoped) → answer with citations `[Session title · mm:ss]`, streamed;
  every answer lists its sources with links. Session-level "Summary" and event-level "Themes" are
  generated on demand by organizers and stored (`session_transcripts.summary`, `events.themes`),
  members-only, editable, never records.
- Privacy: the corpus, embeddings and answers never leave the members boundary; the provider
  receives transcript text (disclosed in the consent checkbox and Participation settings);
  transcripts are deleted with the session or gathering; retention with the gathering.

## 11. Attendance voting (Wave A, opt-in)

PRD §2.3: fresh credits during the event, tap-to-vote per session, unlinkable. Implemented as a
second ballot-key round `kind='attendance'` opened at event start and closed at end + 1 h, credits
`attendance_credits` (default 100), sessions eligible only while `now` is within their slot ± 15
min ("happening now" list in My schedule). Tallies are k-suppressed like pre-votes. No payouts; the
tally feeds the analytics page and a public `schellingpoint.draft.tally` per session after close.
Enabled per gathering in Voting settings. Everything else in PRD Phase 2/3 stays out of scope.

## 12. Decisions taken (change them here if you disagree)

1. **Map tiles from OpenFreeMap, geocoding from Nominatim**, both key-less; overridable by env.
2. **Feed posts and mentions are off by default**; mention consent is per person per gathering.
3. **Custodial profile records are opt-in**; the gathering's profile record is always written.
4. **Overlap coefficient**, not Jaccard, for the organizer-facing percentage; k-suppressed.
5. **pgvector image swap** on both stacks; export works without any AI provider.
6. **Attendance voting is a later wave** and opt-in per gathering; no payouts.
7. **Check-in moves under the organizer workspace.**

## 13. Testing

- Unit: scheduler (cost, hill-climb, score, constraints), post builder (truncation, facet
  stripping, consent set), chunker, geo rounding, label maps.
- API (Playwright): feed gates (no consent → no mention; consent → facet; policy off → no post),
  geocode rate limit and cache, transcript permissions and visibility, corpus export shape, map
  reads by membership tier.
- SQL: new tables private by default (migration 0009 pattern), RLS for `session_transcripts`,
  `feed_posts` server-only.
- Privacy audit: posts and venue geo included; private-residence venues publish no geo.
- Visual: screenshot sweep of 30 surfaces at two widths before/after Wave P, attached to the PR.
