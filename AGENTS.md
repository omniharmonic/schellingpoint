# unconference.events (Schelling Point on ATProto) — Codex Instructions

The official application is unconference on AT Protocol, maintained on **`main`** and deployed
at **https://unconference.events** on Hetzner. **There is no Supabase in the current app.**
The former `atproto` development branch has been promoted to `main`; the previous web2 product
is preserved at the `archive/web2-final` Git tag. Start new work from `main`.

## Start here
1. `docs/ATPROTO_APPVIEW_PLAN.md` — architecture, contracts, file ownership, 31-item spec checklist.
2. `docs/ATPROTO_MIGRATION_SPEC.md` — the spec. Its privacy rules are requirements, not suggestions.
3. `deploy/unconference/README.md` — production runbook (Hetzner `frontrange-twin-1`).

## Architecture in one screen
- **Next.js 15 is the AppView**: route handlers under `src/app/api/**` are the only way the browser
  reads or writes data. No browser database access, ever.
- **Postgres 16** (`src/lib/db`, postgres.js tagged templates). Schema in `db/migrations/NNNN_*.sql`,
  applied by `npm run db:migrate`. `asAccount(id, fn)` runs a transaction as the signed-in account so
  RLS and participation triggers apply; `sql` is the service connection.
- **Our own PDS** (`pds.unconference.events`): custodial accounts (email → DID, generated handle) and
  every gathering's account. People can also sign in with an existing ATProto account (OAuth, hard
  confirm). Identity code: `src/lib/auth/*`, `src/lib/atproto/{session,oauth,agent,bridge}.ts`.
- **Records**: proposals, co-host confirmations, endorsements, opt-in RSVPs and time preferences are
  written to the author's own repo; gatherings, policy, venues, tracks, slot grids, the published
  schedule (canonical `community.lexicon.calendar.event` + sidecars), approvals and k-suppressed tallies
  are written by the gathering actor through the audited port (`src/lib/atproto/{actor,publish}.ts`).
- **Votes are never records**: ballot-key rounds (`src/lib/voting`). Nobody, organizers included, sees
  counts while a round is open; at close the key is destroyed and entries are unlinkable.
- **Indexing**: Jetstream consumer (`scripts/atproto-indexer.ts`) + hourly reconciliation.

## Rules that are easy to break
- Never put a DID, name or handle into a public record unless its holder wrote that record
  (`assertNoForeignDid`). Never publish exact addresses, `host_name`/listed-as names, vote counts
  outside the tally, or attendee-only details.
- Never add fields to borrowed lexicons (`community.lexicon.*`, `coop.lexicon.*`, `freeschool.draft.*`);
  use `schellingpoint.draft.*` sidecars. `npm run lexicons:validate`.
- Every mutation route: `assertSameOrigin`, then `requireViewer`/`requireEventRole`, then validation,
  then SQL filtered by the resolved `event_id`. Private/draft gatherings answer 404 to non-members.
- Server-side fetches of URLs derived from DIDs/handles go through the SSRF-safe fetch (`src/lib/net`).
- Notifications are emitted with `notify(sql, …)` inside the action's transaction; never from triggers.
- New tables are private by default (migration 0009); grant `authenticated` explicitly only together
  with RLS policies. Use `sql.json(value)` for jsonb parameters, never `JSON.stringify(...)::jsonb`.
- postgres.js returns timestamps as ISO strings and `count(*)` as numbers (see `src/lib/db`).

## Local development
```bash
npm run stack:up                       # Postgres :55432, mock PLC :2582, dev PDS :2583
set -a; source .env.local; set +a
APP_DB_USER=unconference_app APP_DB_PASSWORD=unconference_app npm run db:migrate
ALLOW_SEED=true npm run db:seed        # demo-gathering, draft-gathering, past-gathering
RESEND_API_KEY= npm run dev            # :3001; mail disabled so sign-in returns a dev link
node scripts/dev-login.mjs you@example.test   # prints a session cookie for curl/tests
```
The mock PLC is in-memory: after restarting it, wipe the stack (`npm run stack:down -- -v`).

## Verification gate
`npm run typecheck`, `npm run lexicons:validate`, `npm run build`, `npm test` (dev server + local
stack running), `npm run test:sql`, `npm run atproto:audit`. Tests must never modify seeded events;
use `tests/helpers` to create and clean up their own gatherings and accounts.

## Don't
- Don't reintroduce Supabase, bearer tokens in the browser, or client-side database calls.
- Don't write into someone else's repo on their behalf (organizers curate app-side; they can ask the
  author to update a proposal, never edit it).
- Don't change `PDS_HOSTNAME`/`PDS_HANDLE_DOMAIN` in production: they are written into DID documents.
- Don't create PDS accounts against the real `plc.directory` from local tests.
