# Local stack

Postgres + an in-memory did:plc directory + a dev PDS, for building and testing the
AppView without Supabase or the public network. Compose project: `unconference-local`.

| Service | Image | Host address | Notes |
|---|---|---|---|
| postgres | `postgres:16-alpine` | `127.0.0.1:55432` | owner `unconference` / `unconference`, db `unconference`; volume `postgres-data` |
| plc | `node:22-alpine` + `@did-plc/server` | `http://localhost:2582` | mock database: **all DIDs vanish when it restarts** |
| pds | `ghcr.io/bluesky-social/pds:0.4` | `http://localhost:2583` | invite-only, handles `*.test`, admin password `local-admin-password`, no crawlers, no SMTP |

Every secret here is a fixed development value. Never reuse them.

## First run

```bash
# 1. Optional: local overrides for the PDS secrets (gitignored). compose.yml reads
#    pds.env.example first and pds.env second, so this step is only needed to change them.
cp deploy/local/pds.env.example deploy/local/pds.env

# 2. Start everything (first start installs the PLC server's npm deps into a volume).
npm run stack:up
docker compose -f deploy/local/compose.yml ps        # all three "healthy"
curl http://localhost:2583/xrpc/_health               # {"version":"0.4.…"}

# 3. Schema + application role, then demo data.
DATABASE_URL=postgres://unconference:unconference@127.0.0.1:55432/unconference \
APP_DB_USER=unconference_app APP_DB_PASSWORD=unconference_app \
  npm run db:migrate
ALLOW_SEED=true DATABASE_URL=postgres://unconference:unconference@127.0.0.1:55432/unconference \
  npm run db:seed

# 4. App environment (.env.local):
#    DATABASE_URL=postgres://unconference_app:unconference_app@127.0.0.1:55432/unconference
#    DATABASE_MIGRATION_URL=postgres://unconference:unconference@127.0.0.1:55432/unconference
#    PDS_URL=http://localhost:2583
#    PDS_INTERNAL_URL=http://localhost:2583
#    PDS_ADMIN_PASSWORD=local-admin-password
#    PDS_HANDLE_DOMAIN=test

# 5. Check the database layer.
npx playwright test tests/db-baseline.spec.ts
```

The seed creates `demo-gathering` (proposals open, in two weeks), `draft-gathering` and
`past-gathering` (completed, three scheduled sessions). It creates no accounts: sign in
through the app.

## Checking the PDS by hand

```bash
CODE=$(curl -s -u admin:local-admin-password -X POST \
  http://localhost:2583/xrpc/com.atproto.server.createInviteCode \
  -H 'content-type: application/json' -d '{"useCount":1}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')

DID=$(curl -s -X POST http://localhost:2583/xrpc/com.atproto.server.createAccount \
  -H 'content-type: application/json' \
  -d "{\"handle\":\"probe123.test\",\"email\":\"probe123@example.test\",\"password\":\"probe-password-123\",\"inviteCode\":\"$CODE\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).did')

curl -s http://localhost:2582/$DID          # DID document, serviceEndpoint http://localhost:2583

curl -s -u admin:local-admin-password -X POST http://localhost:2583/xrpc/com.atproto.admin.deleteAccount \
  -H 'content-type: application/json' -d "{\"did\":\"$DID\"}"
```

Handles resolve through the PDS, not DNS: `GET http://localhost:2583/.well-known/atproto-did`
with `Host: probe123.test`, or
`GET http://localhost:2583/xrpc/com.atproto.identity.resolveHandle?handle=probe123.test`.

## Day to day

```bash
npm run stack:up                                  # start (idempotent)
npm run stack:down                                # stop, keep volumes
docker compose -f deploy/local/compose.yml logs -f pds
docker compose -f deploy/local/compose.yml down -v   # wipe Postgres, PDS and PLC state
psql postgres://unconference:unconference@127.0.0.1:55432/unconference
```

Because the PLC directory is in memory, restarting `plc` (or `down`/`up`) orphans every
account on the PDS: their DIDs no longer resolve. After a PLC restart, also wipe the PDS and
any `accounts` rows: `docker compose -f deploy/local/compose.yml down -v`, then repeat steps
2–3.

Inside the compose network the services are `postgres:5432`, `plc:2582` and `pds:2583`.
The PDS runs in dev mode with `PDS_HOSTNAME=localhost`, so DID documents advertise
`http://localhost:2583`.
