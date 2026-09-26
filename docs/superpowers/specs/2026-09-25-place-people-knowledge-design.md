# Place, people and knowledge — design (2026-09-25)

Owner feedback after testing 5c84cb0/8572e17 in production, turned into a contract for the next
release. Bugs reported in the same message (logo upload, My Sessions crash, Directions city,
map zoom tiles) are handled outside this spec as straight fixes.

Facts this design rests on are in `docs/design/audits/2026-09-25-fact-finding.md` (MCP exposure,
profile parity with `main`, slot generator, venue/map data model). Privacy rules from
`docs/ATPROTO_MIGRATION_SPEC.md` and CLAUDE.md are requirements throughout: exact coordinates,
street addresses of private residences, emails, vote data and transcripts never reach a record
or a non-member.

## 1. Map v2 — addresses first, shapes when needed

**Problem.** Organizers type addresses but nothing is placed until they press "Place" per room; the
map area is a manual viewport capture; there is no address search, no polygons, no indoor maps.

**Design.**

1. **Geocode on save.** `POST/PATCH …/admin/venues[/id]` schedules a server-side geocode (in
   `after()`, through the existing rate-limited, cached `src/lib/geo/geocode.ts`) whenever address
   fields changed and the pin was not placed by hand (`geocoded_from is not null or latitude is
   null`). Result written with `geocoded_from = <query>`. A hand-dropped pin (`geocoded_from null`)
   is never overwritten. New column `venues.geocode_status text` (`pending|ok|failed|manual`) so the
   UI can say "Locating…", "Located", or "Couldn't locate — place by hand". Private residences are
   geocoded too (members-only coordinates), nothing changes in what is published.
2. **Map area derives from venues.** `events.map` stays as the *override*. When it is null the map
   area is the fitted bounds of all located venues (padding 15%, min zoom 12, single venue → zoom
   15). Editor shows "Auto (fits N rooms)" with "Use this view instead" and "Back to auto". The
   member map and static previews use the same resolver (`resolveMapView(event, venues)`).
3. **Address search in the editor.** A search box over the map calls the existing geocode route
   and flies to the result (organizer scope; the same 30/h quota). Not persisted.
4. **Venue outlines.** New column `venues.outline jsonb` — a GeoJSON Polygon (WGS84, ≤ 64 vertices,
   validated server-side: closed ring, no self-intersection check beyond ring closure, bbox within
   50 km of the pin). Drawn in the editor with a minimal click-to-add-vertex tool (no external draw
   library: MapLibre `GeoJSONSource` + fill/line layers + click handlers; Escape cancels, double-click
   or "Done" closes, "Clear" removes). Members see outlines on the gathering map with the venue
   name; clicking an outline opens the venue's schedule as pins do today. **App-side only, never
   published** (same rule as `events.map`); private residences cannot have an outline (409).
5. **Indoor / custom maps.** New `events.custom_map jsonb`:
   `{ image: '/uploads/…', corners: [[lng,lat]×4] | null, opacity: 0..1, basemap: boolean }`.
   Upload through the existing multipart uploads route (PNG/JPEG/WebP ≤ 8 MB). Two modes:
   - *Georeferenced*: organizer drags four corner handles on the basemap; stored as `corners`;
     rendered as a MapLibre `image` source under the pins/outlines. Pins keep real coordinates.
   - *Image-only* (`basemap: false`, `corners: null`): for a single building. The image is placed on
     a fixed synthetic extent (pixel space mapped to a small lng/lat box around the gathering's
     centre) so all existing pin/outline code works unchanged; the basemap layer is hidden and
     zoom is clamped to the image. Members get the same view. `public_geo` for sessions in this
     mode is the gathering centre rounded (nothing more precise leaves).
6. **Tile loading.** Whatever the bug agent finds (CSP, maxZoom, container), the fix carries a test
   asserting the production CSP permits the tile host for connect/img/worker.

**Files.** `db/migrations/0036_map_v2.sql`; `src/lib/geo/{view.ts,outline.ts}`;
`src/app/api/v1/events/[slug]/admin/venues/**` (after-save geocode, outline validation);
`src/app/api/v1/events/[slug]/admin/custom-map/route.ts`; `src/components/map/{VenueMapEditor,
MapCanvas,GatheringMap,OutlineTool,CustomMapLayer}.tsx`; setup page card; privacy audit `geo`
check extended to `outline` and `custom_map` (must never appear in `at_records` payloads).

## 2. Knowledge — an integrated chat with the gathering, keys the organizer owns

**Problem.** MCP works but is hidden; "Ask" is dead on a fresh deploy because the answer model
needs a deployment-wide `ANTHROPIC_API_KEY`.

**Design.**

1. **Per-gathering AI key.** New table `event_ai_settings(event_id pk, provider text check in
   ('anthropic','openai-compatible'), base_url text, key_ciphertext bytea, key_last4 text, model text,
   set_by uuid, set_at)`. Two chat adapters behind one streaming interface
   (`src/lib/knowledge/chat-provider.ts`): Anthropic Messages API (as today) and an
   OpenAI-compatible `/v1/chat/completions` adapter with an organizer-supplied `base_url`
   (https only, resolved through the SSRF-safe fetch, no private ranges) so OpenAI, OpenRouter,
   Together, or a self-hosted server all work. Model is free text for the compatible adapter.
   Encrypted with AES-256-GCM under a new required env `APP_SECRETS_KEY` (32 bytes, base64) —
   added to compose/.env.example and the runbook; release notes must generate one. Owners/admins
   set, replace or remove it from the Knowledge admin page; the API returns only `last4`, `model`,
   `set_at`. Resolution order for answers and summaries: gathering key → deployment key → none.
   Anthropic model default `claude-sonnet-5`; selectable `claude-haiku-4-5-20251001` for cost.
   Embeddings stay local by default (no key needed); a gathering-level embeddings key is out of scope.
   A "Test connection" button sends a one-token request and reports the provider's answer.
2. **Integrated chat.** `/e/[slug]/ask` becomes a conversation: message list, streaming answers,
   cited sources (session title + jump link), "themes" from organizers shown as starter chips,
   history kept client-side for the tab only (nothing stored server-side, as today). The nav item
   shows whenever transcripts are enabled for the gathering; when there are no readable transcripts
   or no key, the page explains what is missing (members: "the organizers haven't enabled answers
   yet"; organizers: link to the Knowledge page) instead of disappearing.
3. **Discoverability of MCP.** (a) A "Your AI assistant" card on the attendee's gathering
   dashboard and inside the Ask page: server URL, mint-a-token inline (reusing `AssistantConnections`),
   link to `/help/assistants`. (b) An "AI access" card on the admin Knowledge page: what attendees
   can connect, the URL, a copyable snippet for the gathering's announcement. (c) `/help` index page
   and a footer "Help" link. (d) Themes rendered to members on the Ask page.
4. **Members API is used.** `GET /api/v1/members/[did]` backs the profile page in §3.

**Files.** `db/migrations/0037_event_ai_settings.sql`; `src/lib/secrets/aead.ts`;
`src/lib/knowledge/{anthropic,ask}.ts` (key resolution); `src/app/api/v1/events/[slug]/admin/ai-key/route.ts`;
`src/app/e/[slug]/ask/**`; `src/app/e/[slug]/admin/knowledge/page.tsx`; `src/components/knowledge/*`;
`src/app/help/page.tsx`; compose + README + `.env.example`.

## 3. People — richer, linkable, sortable

**Problem.** Host names don't lead anywhere; email is hidden with no way to share it; no sort.

**Design.**

1. **Profile route.** `/e/[slug]/people/[did]` (members-only; 404 to non-members like every
   gathering page) renders the member card: avatar, name, `@handle` with a Bluesky link
   (`https://bsky.app/profile/<did>`) when the account is discoverable there, affiliation,
   building, looking-for, interests (each a link to People filtered by that interest), contact
   row, shared gatherings from the members API, and the sessions they host in this gathering.
   The People directory keeps its modal but the card header links to the route; `?highlight=`
   keeps working.
2. **Every name links.** Host popover on session pages, session cards, schedule builder host
   line, feed digest (already no names), MCP `get_session` hosts (adds `profile_url`), and
   notifications that mention a person.
3. **Contact sharing, per gathering, opt-in.** `event_members.share_email boolean not null default
   false` and `share_contact boolean not null default true` (messaging handle). Toggles live in the
   gathering's onboarding step and in Account → per-gathering settings. `people.ts` returns `email`
   only when `share_email` is true for that gathering. Never in a record, never to non-members.
   The old `main` behaviour (email always visible) is not restored; the opt-in default is off.
4. **Sort and filter.** People page gets a sort control: *Shares most interests with you* (default
   when the viewer has interests), *Name*, *Recently joined*, *Role*. Interest filter chips remain
   (AND semantics). Interests cap raised from 10 to 15 (still ≤40 chars). URL state for sort and
   filters so links are shareable.
5. **Bluesky info.** Cards show a small Bluesky glyph linking out for OAuth accounts and for
   custodial accounts that opted into publishing their profile record. Hydration is unchanged.
6. **Onboarding.** The first-visit onboarding for a gathering collects interests, looking-for,
   messaging handle, and the two share toggles on one step (skippable).

**Files.** `db/migrations/0038_member_contact_sharing.sql`; `src/app/e/[slug]/people/[did]/page.tsx`;
`people.ts`; participants page; `SessionDetailClient.tsx`; `src/lib/mcp/server.ts`; onboarding
component; `validate.ts` (cap).

## 4. Bulk session blocks — per-room, per-day, in one pass

**Problem.** The generator applies one pattern to every selected room and day; anything uneven
means repeated passes or one slot at a time.

**Design.** Replace the generator body with a two-axis editor:

- Left: day tabs (from the gathering's dates) with "Copy from <day>".
- Body: one row per room — start, end, slot length, break length, "closed this day" toggle — with a
  "Same as first room" checkbox that keeps rows in lockstep until unticked.
- Right: live preview grid (rooms × generated slots) and the total; conflicts with existing slots
  are highlighted and block save (as today). One POST, one transaction, one re-publish.
- Templates: "Save as template" stores the whole configuration in `events.slot_templates jsonb`
  (≤ 10 named entries); "Apply template" fills the editor. Clone gathering carries templates.
- The schedule builder gets an "Add a row of slots at HH:MM" quick action across all venues for
  fixes after the fact.

**Files.** `src/components/admin/BulkSlotGenerator.tsx` (rewrite), `src/app/e/[slug]/admin/setup/page.tsx`,
`db/migrations/0039_slot_templates.sql`, `src/app/api/v1/events/[slug]/admin/slot-templates/route.ts`,
schedule page quick action.

## 5. Voting data — no change, one clarification

The ballot ledger (account → allocation) is destroyed at round close; anonymous `vote_ballots` /
`vote_entries` survive for the life of the gathering and feed the scheduler. Nothing is deleted
after scheduling. This spec changes nothing here; the Knowledge/People work must not touch
`src/lib/voting`.

## 5b. Stripe follow-ups (from the 2026-09-25 sandbox walk)

- **Merchant-creation idempotency.** The key was the event id alone, so a failed attempt was
  replayed by Stripe for 24 h and the organizer could not retry. New rule: key =
  `merchant-<eventId>-<attempt>` where `events.stripe_connect_attempts` increments only after a
  failed create; a double-click within one attempt still collapses to one account.
- **Contribution ceiling.** Stripe accepts an application fee equal to or above the charge; the
  organizer's voluntary percentage is capped at 50% by validation (route + form), and the fee is
  additionally clamped so the merchant's net can never be negative on the price alone.
- Keep the two sandbox merchants and the throwaway gatherings for re-runs; live keys, live webhook
  destination and a live purchase remain owner actions.

## 6. Order and gates

Waves run as Opus agents on `atproto`, one wave per agent, each ending with the full gate
(`typecheck`, `lexicons:validate`, `DATABASE_URL= npm run build`, `npm test`, `test:sql`,
`atproto:audit`) and a code review by a second agent before commit.

1. **Bugs** (already running): upload, My Sessions crash, Directions, tiles.
2. **Wave M2** — Map v2 (§1). Largest UI surface; migration 0036.
3. **Wave K2** — Knowledge chat + keys + discoverability (§2). Needs `APP_SECRETS_KEY` in
   production before release.
4. **Wave P2** — People (§3). Migration 0038.
5. **Wave B** — Bulk blocks (§4). Migration 0039.
6. **Release** after each wave that passes review, with backup first, per the runbook.

Stripe sandbox verification runs in parallel and is reported separately.

## 7. Decisions taken here (change them if wrong)

- Outlines and custom maps are app-side only; no new lexicon, nothing published.
- Email sharing is per-gathering opt-in, default off. Messaging handle sharing default on.
- Two chat providers for the organizer key (Anthropic, OpenAI-compatible with base URL); embeddings stay local. (Owner's choice, 2026-09-25.)
- Profile route is per gathering (`/e/[slug]/people/[did]`), not a global profile page, so the
  members-only boundary stays where it is.
- Interests cap 15.

## 8. Follow-ups noted during review (not in this release)

- Onboarding is per account (`profiles.onboarding_completed`), so the per-gathering sharing
  switches are only offered in the first gathering a person lands on; later gatherings take the
  defaults (handle shared, email not). A per-gathering `event_members.onboarded_at` would let the
  step run once per gathering. The switches remain reachable in Account → "What you share at …".
- `GET /api/v1/members/[did]` uses "shared in any gathering we both belong to"; the per-gathering
  card is scoped exactly. Revisit if "every" turns out to be the expectation.
- Fall-back DST days: `parseTimeInTimezone` resolves a repeated wall-clock hour to its first
  occurrence, so a 60-minute slot spanning it is stored as 120 real minutes. Pre-existing; needs a
  decision on which occurrence a gathering means.
- Production sends no Content-Security-Policy header. Adding one must allow the MapLibre worker
  (same origin), tile host for connect-src/img-src, `data:` and `blob:` images, and `worker-src`.
