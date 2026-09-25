# Fact-finding for the 2026-09-25 design (read-only audit)

Gathered by a read-only agent on 2026-09-25 against `atproto` at 8572e17, with `main` read via
`git show`. Summarised; the design that uses it is
`docs/superpowers/specs/2026-09-25-place-people-knowledge-design.md`.

## AI / MCP exposure
- MCP server `src/app/api/mcp/route.ts` (Streamable HTTP, bearer only, 7 read-only tools in
  `src/lib/mcp/server.ts`). Tokens: `src/app/api/me/assistant-tokens`, UI `AssistantConnections`
  in `SettingsModal.tsx` (Identity tab, `/account?tab=identity`). Help: `/help/assistants`, linked
  from exactly one place.
- Embeddings default to `local` (bge-small, baked into the image, offline). Answers need
  `ANTHROPIC_API_KEY`, which production does not set → "Ask" reports not configured.
- No UI caller: `GET /api/v1/members/[did]`; `?highlight=` on participants has no inbound link;
  generated themes are rendered only on the admin page.

## Profiles: `main` vs `atproto`
- Kept: display name, bio, avatar, affiliation, building, interests (capped 10×40), messaging
  handle (generalised from Telegram), ENS (verified + opt-in), People directory with search and
  AND interest chips. New: looking_for, shared-interests section, Bluesky hydration, opt-in
  profile record, scoped interest suggestions.
- Lost: email on the member card (removed by design in `people.ts`); "View full profile" link from
  the session host card (`main` `SessionDetailClient.tsx:687`) — the popover has no link out.
- Neither branch had a profile page at a URL; `main` used a modal + `?highlight=`.

## Slot creation
- `/e/[slug]/admin/setup` → `BulkSlotGenerator.tsx`: room (or every room) × day (or every day),
  start/end, slot length, breaks; one POST of up to 2000 slots in one transaction; conflict
  pre-check. 6×4×2 uniform = 8 interactions. No per-room hours, per-day variation, or templates.

## Venues and map
- Venue geo: `latitude/longitude numeric(9,6)`, `geocoded_from`, `geocoded_at` (0023). Sessions:
  exact `location_lat/lng` (attendee-only) + `public_geo` (2 decimals). Private residence flag
  keeps address/coords members-only.
- Map area: `events.map jsonb {center, zoom, bounds}` written via the legacy
  `PATCH /api/events/[id]/settings`; captured manually with "Use this view as the map area".
- Geocoding is manual (per-room Place button, click/drag, one-time seed from the gathering
  address). Route `…/admin/geocode`, 30/h/account, Nominatim cached 30 days by hashed query.
- No polygons, no GeoJSON, no PostGIS anywhere.
