# Vendored borrowed-record lexicons

We write five record types we do not own: `community.lexicon.calendar.event`,
`community.lexicon.calendar.rsvp` (opt-in), `coop.lexicon.event.config`,
`coop.lexicon.event.listing` and `coop.lexicon.membership`, all with `validate: false`
(`apps/appview/src/lib/events.ts`, `apps/appview/src/http/routes/rsvp.ts`,
`apps/appview/src/lib/membership-claims.ts`). This directory vendors the lexicon JSON
those records are supposed to conform to, so `apps/appview/test/borrowed-records.test.ts`
can validate our own output against it with `@atproto/lexicon`. Reading these into the
repo for validation only — we do not edit them, and they are not wired into
`pnpm lexicons:validate`, which remains scoped to `freeschool.draft.*`.

## CANONICAL — `community.lexicon.*`

Cloned verbatim from the upstream git repo, unmodified.

| File | NSID |
|---|---|
| `community.lexicon.calendar.event.json` | `community.lexicon.calendar.event` |
| `community.lexicon.calendar.rsvp.json` | `community.lexicon.calendar.rsvp` |
| `community.lexicon.location.address.json` | `community.lexicon.location.address` |
| `community.lexicon.location.geo.json` | `community.lexicon.location.geo` |
| `community.lexicon.location.fsq.json` | `community.lexicon.location.fsq` |
| `community.lexicon.location.hthree.json` | `community.lexicon.location.hthree` |

- **Source:** `https://tangled.org/lexicon.community/lexicons`
- **Commit:** `c8552ebbf7f2d1cc13e14870f6908cdc29796008` (2026-07-27)
- **Fetched:** 2026-09-13
- **License:** MIT (the repo's own `LICENSE` file — CLAUDE.md's "CC0" note refers to
  `packages/lexicons/lexicons/freeschool/draft/**`, our own lexicons, not this upstream
  repo; corrected here rather than in CLAUDE.md, which is out of scope for this task).
- The four `community.lexicon.location.*` files are vendored because
  `community.lexicon.calendar.event#main.locations` is a union over all four plus
  `#uri` — `@atproto/lexicon` needs every ref target registered to validate a `locations`
  array item, even when our own test records only exercise one or two variants.

## ASSUMED — `coop.lexicon.*`

No canonical source exists yet: Lucian has not normalized the `coop.lexicon.*`
namespace (per `CLAUDE.md` and `docs/interop-audit.md` gap 7). Each file below is a
reconstruction of the shape our own code writes (`apps/appview/src/lexicons/coop.ts`,
`apps/appview/src/lib/events.ts`, `apps/appview/src/lib/membership-claims.ts`) — not an
attempt to guess Lucian's eventual schema — so that it validates what we actually ship
and pins it for regression, the same way `validate: false` could not.

| File | NSID | Built by |
|---|---|---|
| `coop.lexicon.event.config.json` | `coop.lexicon.event.config` | `lib/events.ts#createEventAsHost` / `#updateEventAsHost` |
| `coop.lexicon.event.listing.json` | `coop.lexicon.event.listing` | `lib/events.ts#routeListing` |
| `coop.lexicon.membership.json` | `coop.lexicon.membership` | `lib/membership-claims.ts#publishRoleClaim` |

- **Source:** none (ASSUMED). Each file's own `description` field records the specific
  field-level divergence found against the closest available secondary source,
  `docs/research/context/2026-09-12_regenos-building-blocks-handoff.md` (itself read
  from `technefoundation/regenOS@c3e34d4`, per `docs/lucian-review-packet.md:7` — also
  **not** canonical, and not fully consistent with the handoff note on field names
  either: e.g. the handoff says `event.config` uses `attendance`/`maxAttendees`/
  `waitlist`; CLAUDE.md's "key corrections" line only confirms the `attendance` name
  correction, not the rest).
- **Written:** 2026-09-13.
- These are marked ASSUMED, not RECONSTRUCTED, because they reconstruct OUR code's
  output rather than reconstructing Lucian's record from external descriptions — see
  `docs/interop-audit.md` gap 7 for the distinction and the outstanding question for
  Lucian.

## `freeschool.draft.*` — reused verbatim (unconference.events)

Copied unmodified from Free School `packages/lexicons/lexicons/freeschool/draft/` (2026-09-14):

| File | NSID | Used for |
|---|---|---|
| `freeschool/policy.json` | `freeschool.draft.policy` | the gathering's rules and thresholds (`destructiveActionStewards`, `feedbackK`, `publishRoles`) |
| `freeschool/approval.json` | `freeschool.draft.approval` | an organiser's approval of a destructive change, in THEIR repo (`action: other` for move/cancel, `remove-listing`) |
| `freeschool/series.json`, `freeschool/occurrence.json` | `freeschool.draft.series` / `.occurrence` | recurring gatherings |
| `freeschool/skill.json` | `freeschool.draft.skill` | reading the shared skill taxonomy (never written here) |

Never extended: records we write under these NSIDs carry only the fields defined here
(`assertNoUnknownFields` at write time, `npm run atproto:audit` after).

## `app.bsky.*` — borrowed verbatim (unconference.events)

| File | NSID | Used for |
|---|---|---|
| `bsky/app.bsky.actor.profile.json` | `app.bsky.actor.profile` | the gathering account's own profile (`displayName` = gathering name, `description` = tagline), written at `self` by `publishGathering` through the port action `publish-profile`; read from a person's own PDS at sign-in (`fetchActorProfile`) |

- **Source:** the schema shipped in `@atproto/api` (`schemaDict.AppBskyActorProfile`, generated
  from `bluesky-social/atproto` `lexicons/app/bsky/actor/profile.json`), written out with the
  generator's `lex:` ref prefix removed so it reads like the upstream JSON file. Fetched 2026-09-21.
- `../atproto/com.atproto.label.defs.json` is vendored the same way (from `ComAtprotoLabelDefs`)
  because `labels` refs `com.atproto.label.defs#selfLabels` and `lexicons:validate` resolves every
  ref; `pinnedPost` / `joinedViaStarterPack` resolve against the existing strongRef shim.
- Text fields only are written (no avatar/banner blob, labels or pinned post): the app-side record
  builder never carries a DID or a person's name, and `assertNoUnknownFields` applies (`app.bsky.`
  is in `BORROWED_PREFIXES`).

### Feed posts (Wave F)

| File | NSID | Used for |
|---|---|---|
| `bsky/app.bsky.feed.post.json` | `app.bsky.feed.post` | the gathering account's own posts about its activity (`src/lib/atproto/feed.ts`), written through the port action `publish-post` (`delete-post` is destructive) |
| `bsky/app.bsky.richtext.facet.json` | `app.bsky.richtext.facet` | the link facet and the consented mention facets a post carries |
| `bsky/app.bsky.embed.external.json` | `app.bsky.embed.external` | the link card (session or gathering URL, title, description; no thumb) |
| `bsky/app.bsky.embed.{images,video,gallery,record,recordWithMedia,defs}.json`, `bsky/app.bsky.{actor,feed,graph,labeler,notification}.defs.json`, `bsky/app.bsky.feed.{threadgate,postgate}.json`, `../atproto/com.atproto.moderation.defs.json` | — | the transitive `ref` closure of `app.bsky.feed.post` (its `embed` union names every embed type, whose view defs name the rest). Vendored only so `lexicons:validate` resolves every ref; nothing under these NSIDs is ever written |

- **Source:** `@atproto/api`'s shipped `schemas` (the same generator output as `app.bsky.actor.profile`
  above), `lex:` ref prefix removed. Fetched 2026-09-21. Regenerate with the one-liner used for the
  profile: `require('@atproto/api').schemas.find(d => d.id === nsid)`.
- A post carries only `text`, `facets`, `langs`, `createdAt` and an `embed` of type
  `app.bsky.embed.external`; `assertNoUnknownFields` applies. A mention facet may name a DID only
  through the port's own consent gate (`consentedMentions`, R9): `event_members.mention_in_posts`,
  host or self-written co-host of the session, visible repo.
