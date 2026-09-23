# unconference.events public read API

Everything a gathering publishes to the AT Protocol network is available two ways:

1. **On the network, from the source.** Each gathering has its own account (for example
   `ethboulder.unconference.events`). Its schedule is a set of `community.lexicon.calendar.event`
   records plus `schellingpoint.draft.*` sidecars in that account's repository; proposals live in their
   authors' repositories. Read them with any ATProto client (`com.atproto.repo.listRecords`), from a
   relay, or from Jetstream. Lexicons are in `lexicons/`.
2. **From this AppView, pre-joined.** The endpoints below serve the same published data for
   convenience. They need no key, allow any origin, and are cached for 60 seconds.

This API only ever serves what is already public on the network. It never serves emails, Telegram,
ENS, account ids, organizer-typed speaker names, track leads, vote counts (only the k-suppressed tally
is public, as a record), RSVP-gated details, organizer notes, or street addresses (venues are
coarsened to locality). The only DIDs in responses are the gathering's own and those of proposers whose
proposal record is in their own repository.

The previous shared-key partner API (`x-api-key`) is gone. `/api/v1/profiles` and
`/api/v1/profiles/:id` answer `410 Gone`; `/api/v1/sessions` and `/api/v1/sessions/:id` no longer
read a key at all — they serve the published sessions below, from the same code path as
`/api/v1/schedule`, so a partner integration drops the header and keeps reading. What changed for a
key holder: only sessions the gathering has PUBLISHED are served (a pending or rejected proposal
never was public and is not served now), and a host appears as `{ did, handle }` — the DID of an
author who wrote their own proposal — instead of a display name, bio and affiliation.
`API_KEY_BONFIRESAI` is no longer read; remove it from your environment.

## Conventions

- Base URL: `https://unconference.events`
- Every endpoint takes `event=<gathering slug>`. Public and unlisted gatherings are readable once
  published; unknown, private and draft gatherings answer `404`.
- Responses: `{ "data": ..., "count"?: number }`; errors: `{ "error": { "code", "message" } }`.
- Times are ISO 8601 UTC; `day_date` is the gathering's calendar day (`YYYY-MM-DD`).
- Only `GET` is supported.

## Endpoints

### `GET /api/v1/schedule?event=<slug>[&day=YYYY-MM-DD]`

The published schedule grouped by day.

```json
{
  "data": {
    "gathering": { "slug": "ethboulder", "name": "EthBoulder", "did": "did:plc:…", "uri": "at://did:plc:…/schellingpoint.draft.gathering/self" },
    "days": [
      {
        "day": "2027-02-26",
        "slots": [
          {
            "id": "…", "start_time": "2027-02-26T16:00:00.000Z", "end_time": "2027-02-26T17:00:00.000Z",
            "label": "Morning", "is_break": false, "day_date": "2027-02-26", "slot_type": "session",
            "venue_id": "…", "venue": { "id": "…", "name": "Main hall", "slug": "main-hall" },
            "grid_uri": "at://did:plc:…/schellingpoint.draft.slotGrid/…",
            "sessions": [ "PublicSession" ]
          }
        ]
      }
    ],
    "unslotted": [ "PublicSession" ]
  }
}
```

`PublicSession`:

```json
{
  "id": "…", "title": "Soil and software", "description": "…", "format": "talk", "duration": 30,
  "session_type": "proposed", "cancelled": false, "time_slot_id": "…",
  "start_time": "…", "end_time": "…",
  "track": { "id": "…", "name": "Commons", "color": "#2f855a" },
  "venue": { "id": "…", "name": "Main hall", "slug": "main-hall" },
  "host": { "did": "did:plc:…", "handle": "calmotter417.unconference.events" },
  "uris": {
    "calendar_event": "at://did:plc:<gathering>/community.lexicon.calendar.event/…",
    "slot": "at://did:plc:<gathering>/schellingpoint.draft.slot/…",
    "proposal": "at://did:plc:<author>/schellingpoint.draft.proposal/…"
  }
}
```

`host` is present only when the proposal record is in the host's own repository. Sessions proposed on
someone's behalf or imported have `host: null`.

### `GET /api/v1/sessions?event=<slug>[&day=YYYY-MM-DD][&track=<uuid>]` and `GET /api/v1/sessions/:id[?event=<slug>]`

Published sessions as `PublicSession` (the same objects the schedule embeds), newest slot first:
`{ "data": [ PublicSession ], "count": n }`, and a single `{ "data": PublicSession }` by id. A
session appears once the gathering has written its calendar event; a cancelled one stays, with
`cancelled: true`. `day` filters by the gathering's calendar day, `track` by a published track.

### `GET /api/v1/tracks?event=<slug>` and `GET /api/v1/tracks/:id?event=<slug>`

Published tracks: `id, uri, name, slug, description, color, is_active, display_order, max_sessions`.

### `GET /api/v1/venues?event=<slug>` and `GET /api/v1/venues/:id?event=<slug>`

Published venues: `id, uri, name, slug, capacity, features, style, is_primary, locality, region, country`.
No street address or notes.

### `GET /api/v1/timeslots?event=<slug>[&day=YYYY-MM-DD][&include=venue]`

Time slots of published slot grids: `id, start_time, end_time, label, is_break, day_date, slot_type,
venue_id, grid_uri`, plus `venue: { id, name, slug }` with `include=venue`.

### `GET /api/atproto/records?event=<slug>&collection=<nsid>[&limit=]`

Indexed public records for the gathering (its own repository, and proposals, co-host confirmations and
endorsements that reference it), as `{ uri, cid, did, collection, rkey, record, indexed_at }`.

## Sync strategy

For a mirror, prefer the network: subscribe to Jetstream with `wantedCollections` for
`community.lexicon.calendar.event` and `schellingpoint.draft.*`, filter by the gathering's DID for
gathering-written records and by the `gathering` field for proposals, and fall back to
`com.atproto.repo.listRecords` on the gathering's PDS for backfill. Use these endpoints for simple
polling integrations; respect the 60-second cache.
