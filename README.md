# unconference

**A shared space for people to shape their own gathering.**

[Open unconference.events](https://unconference.events) · [Code of conduct](https://unconference.events/codeofconduct) · [Production runbook](deploy/unconference/README.md)

unconference brings proposals, collective prioritization, scheduling, tickets, and event-day coordination into one app. Organizers provide the structure; participants bring the sessions and help decide what happens.

The official application is built on **AT Protocol** and maintained on **`main`**. It runs at **https://unconference.events** on Hetzner, with its own Postgres database and personal data server (PDS). The earlier EthBoulder/Schelling Point web2 application is preserved at the Git tag [`archive/web2-final`](https://github.com/omniharmonic/schellingpoint/tree/archive/web2-final). Supabase and Vercel are not part of the current deployment.

## How a gathering works

1. **Make a home for it.** Set the dates, timezone, participation rules, branding, venues, and tracks. Gatherings can be public or private.
2. **Invite people and ideas.** Participants sign in with email or an existing ATProto account, including Bluesky. They can propose sessions, find collaborators, and publicly endorse ideas.
3. **Choose what matters.** Quadratic voting gives participants a credit budget. Allocating `n` votes costs `n²` credits, so people can express stronger preferences while working within a shared limit.
4. **Build and publish the program.** Organizers place sessions into venue slots, review scheduling suggestions and conflicts, and publish the schedule.
5. **Gather.** Participants follow the program, save sessions, export calendars, get updates, and contribute resources. Organizers manage attendance and ticket check-in.

The organizer workspace shows the current phase, relevant deadlines, and the next transition. Dates and phases are related but distinct: automatic progression must be enabled for the gathering; otherwise organizers advance phases themselves. The workspace explains which mode is active.

## What is included

- **People and identity:** email sign-in, ATProto OAuth, Bluesky profile import, interests, profiles, and per-gathering participation.
- **Sessions and support:** proposals, co-host invitations, public endorsements, private quadratic ballots, and an overview of activity and support.
- **Organizer tools:** event settings, branded navigation and banners, bulk slot creation, venues, tracks, schedule builder, moderation, and member roles.
- **Tickets:** free passes and a Stripe Connect integration for paid admission, refunds, and participation gating. Organizers choose a platform contribution from **1% to 100%**. Owner/admin voting does not require a ticket; normal voting windows and credit limits still apply.
- **During and after the gathering:** personal schedules, calendar feeds, maps, session resources, member-only transcripts, and knowledge search. AI answers require an explicitly configured provider.
- **Mobile and PWA:** responsive layouts, installable app icons, an offline fallback, and opt-in Web Push with per-category preferences.

Paid sales require a configured Stripe platform, signed webhooks, and an eligible connected organizer account. See [Stripe activation and verification](docs/STRIPE_ACTIVATION.md); an implemented checkout flow is not evidence that a deployment is ready to accept live payments.

For push, enable **Notifications on this device** in a gathering's notification settings, then select the Push categories. On iPhone/iPad, open the app from the Home Screen first. Signing out disconnects that device. Push payloads contain a generic update notice, not private gathering content.

## ATProto and privacy

ATProto makes selected public contributions portable; it does not make the entire event database public.

- Participants author their own public records. Gathering-level records are published by the gathering account through an audited publishing boundary.
- Public schedules use `community.lexicon.calendar.event` with application-specific sidecar records. Borrowed lexicons are not extended with custom fields.
- **Individual votes are never ATProto records.** Live ballot totals are hidden from everyone, including organizers. When a round closes, its linking key is destroyed; published results suppress small groups.
- The overview shows public endorsements while voting is open and eligible published results after voting closes. Endorsements and private ballots are different signals.
- Exact private locations, attendee-only details, transcripts, session credentials, and payment data stay behind application access controls. Public profile and participation publishing follows the relevant consent settings.
- Browser requests go through the AppView API with an HttpOnly session cookie. Database access and ATProto credentials stay on the server.

See the [architecture and contracts](docs/ATPROTO_APPVIEW_PLAN.md), [migration specification](docs/ATPROTO_MIGRATION_SPEC.md), and [ATProto implementation guide](src/lib/atproto/README.md).

## Architecture

| Component | Responsibility |
| --- | --- |
| Next.js 15 / React 19 | Web interface and server-side AppView API |
| Postgres 16 / postgres.js | Application state, authorization, private ballots, and job queues |
| ATProto PDS | Custodial identities and gathering repositories at `pds.unconference.events` |
| Jetstream indexer | Public-record indexing, with scheduled reconciliation |
| Scheduler | Publishing, voting and lifecycle transitions, notifications, and retention |
| Caddy / Docker Compose | HTTPS routing and isolated services on Hetzner |
| Resend / Stripe Connect / Web Push | Configurable email, paid ticketing, and device notifications |

The production stack has its own containers, network, and volumes on `frontrange-twin-1`. It shares the machine with the Bioregional Twin but does not share application data or credentials.

## Local development

Use **Node.js 22**, npm, and Docker Compose. The SQL test suite also needs `psql`. Local development uses a mock PLC directory and a development PDS; never point local tests at the real `plc.directory`.

```bash
git clone https://github.com/omniharmonic/schellingpoint.git
cd schellingpoint
npm ci
cp .env.example .env.local
```

Edit `.env.local` before starting. The database and local PDS URLs already match the development stack. Set:

- `APP_DB_PASSWORD=unconference_app`
- `PDS_ADMIN_PASSWORD=local-admin-password`
- `ATPROTO_SESSION_SECRET` to a random string of at least 32 characters (`openssl rand -base64 48`).
- `ATPROTO_CUSTODY_KEY` to exactly 32 random bytes encoded as hex (`openssl rand -hex 32`).
- `APP_SECRETS_KEY` to 32 random bytes encoded as base64 (`openssl rand -base64 32`) if testing organizer-supplied AI credentials.

Keep `PDS_PLC_URL=http://localhost:2582`, `PDS_HANDLE_DOMAIN=test`, and `RESEND_API_KEY` empty for local-only email sign-in.

```bash
npm run stack:up
# Wait for Postgres, PLC, and PDS to become healthy.
docker compose -f deploy/local/compose.yml ps

set -a; source .env.local; set +a
npm run db:migrate
ALLOW_SEED=true npm run db:seed
RESEND_API_KEY= npm run dev
```

Open **http://localhost:3001**. Seed data includes `demo-gathering`, `draft-gathering`, and `past-gathering`. With mail disabled locally, the sign-in endpoint returns a development link. `node scripts/dev-login.mjs you@example.test` can obtain a local session for API tests.

The mock PLC is in-memory. Restarting it loses its DID directory, so a reset must also clear the local PDS/database volumes. Follow the [local stack guide](deploy/local/README.md); this reset destroys local test data.

## Verification

With the local stack running and `.env.local` configured:

```bash
npm run typecheck
npm run lexicons:validate
npm run build
npm test                  # keep the local dev server running in another terminal
npm run test:sql
npm run atproto:audit
```

Tests create and clean up their own gatherings and accounts; they must not alter seeded events or production data. Production-only PWA checks can run against a production-mode server by setting `PWA_TEST_BASE_URL`; see [the PWA tests](tests/pwa.spec.ts).

## Deployment

**Production: https://unconference.events — deploy from `main`.**

The protected server environment is `deploy/unconference/.env`; templates contain no production credentials. From the configured Hetzner checkout:

```bash
cd /opt/unconference
git switch main
deploy/unconference/release.sh
```

The release script pulls the checked-out branch, creates and verifies an encrypted backup, builds the image, applies migrations, starts the services, checks `/api/health`, and runs the ATProto privacy audit. Git pushes alone do not deploy this stack. Vercel Git deployments are explicitly disabled in `vercel.json`.

Read the [production runbook](deploy/unconference/README.md) for DNS, secrets, backups, payment activation, Web Push, and operational checks. Do not change the PDS hostname or handle domain casually: existing DID documents depend on them.

## Contributing and project history

Start from `main`, use a focused feature branch, and follow [AGENTS.md](AGENTS.md). Preserve the server-side authorization and publishing boundaries, use the shared UI components, and run the verification appropriate to your change.

The project began as Schelling Point for EthBoulder and is now a general-purpose unconference platform. Historical design notes and audits remain in `docs/`; their dated descriptions may refer to the former `atproto` branch or the archived web2 implementation. The current README, architecture contract, source code, and production runbook take precedence for setup and operations.
