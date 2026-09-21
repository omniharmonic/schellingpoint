# unconference.events — production runbook

One compose project on Hetzner `frontrange-twin-1` (`2.29.37.247`, CX33, Helsinki), beside the
Bioregional Twin. It shares nothing with the Twin except the machine: its own network, volumes,
Caddy and firewall (`unconference-fw`: 80/tcp, 443/tcp, 443/udp, attached alongside the Twin's
SSH-only firewall).

| Service | Image | Role |
|---|---|---|
| `caddy` | `caddy:2-alpine` | TLS and routing (`Caddyfile`); the only service publishing ports |
| `app` | `unconference-app` (this repo, `Dockerfile`) | Next.js AppView + web |
| `migrate` | same image | one-shot `db/migrations` runner, before `app` |
| `indexer` | same image | Jetstream consumer |
| `scheduler` | `curlimages/curl` | job loop: close rounds + drain publish/feed jobs (1 min), dispatch notifications and knowledge jobs (5 min), reconcile ATProto (hourly), retention (daily) |
| `postgres` | `postgres:16-alpine` | the AppView database |
| `pds` | `ghcr.io/bluesky-social/pds:0.4` | our PDS: custodial and gathering accounts |
| `backup` | `backup.Dockerfile` | nightly encrypted Postgres + PDS backup to R2 |

## Names

| Name | Served by |
|---|---|
| `unconference.events` | app |
| `www.unconference.events` | redirect to the apex |
| `pds.unconference.events` | PDS (whole) |
| `<handle>.unconference.events` | `/.well-known/atproto-did` and `/xrpc/*` → PDS; anything else → app |
| `<gathering-slug>.unconference.events` | the gathering's pages (app), and the gathering account's handle |

DNS (Namecheap): `A @`, `A www`, `A pds`, `A *` → `2.29.37.247`. Resend: DKIM TXT
`resend._domainkey`, SPF TXT `send`, MX `send` → `feedback-smtp.us-east-1.amazonses.com` (needs
Namecheap Mail Settings = Custom MX), CNAME `rsend`.

**`PDS_HOSTNAME` and `PDS_HANDLE_DOMAIN` are written into every DID document the PDS mints.** Never
change them casually; moving hosts is a PLC operation per account (see Free School's
`docs/runbooks/pds-hostname-migration.md`).

## Secrets

`deploy/unconference/.env` on the server (mode 600), generated from `.env.example`. A copy lives in
`~/.config/unconference/production.env` on the operator's Mac. The age private key for backups lives
only there (`~/.config/unconference/backup-age.key`), never on the server. The PLC rotation key is the
one secret that cannot be regenerated.

## First deploy

```sh
ssh -i ~/.ssh/frontrange-twin root@2.29.37.247
git clone -b atproto https://github.com/omniharmonic/schellingpoint.git /opt/unconference
cd /opt/unconference
install -m 600 /dev/null deploy/unconference/.env   # then paste the prepared env
deploy/unconference/release.sh
```

`release.sh` pulls, backs up (when a stack is running), builds, starts Postgres and the PDS, runs
migrations, starts everything, waits for `/api/health`, and runs the privacy audit.

## Everyday operations

```sh
cd /opt/unconference
C="docker compose --env-file deploy/unconference/.env -f deploy/unconference/compose.yml -p unconference"
$C ps
$C logs -f --tail=100 app indexer scheduler
$C exec app npm run -s atproto:audit            # privacy audit against production
$C run --rm --no-deps --entrypoint /usr/local/bin/backup.sh backup   # backup now
```

Roll back: `git checkout <previous commit> && deploy/unconference/release.sh` (the previous image is
also tagged `unconference-app:rollback-<commit>`).

## Restore rehearsal

```sh
# On the operator's Mac: fetch a night from R2, then decrypt with the off-box key
age -d -i ~/.config/unconference/backup-age.key postgres.sql.gz.age | gunzip > restore.sql
age -d -i ~/.config/unconference/backup-age.key pds-sqlite.tar.gz.age | tar -xz -C restore-pds/
age -d -i ~/.config/unconference/backup-age.key pds-blocks.tar.gz.age | tar -xz -C restore-pds/
# Postgres: create a scratch database and psql -f restore.sql; compare row counts.
# PDS: use a disposable, isolated PDS instance with outbound network disabled.
# Restore into its scratch volume, then check SQLite integrity and repository reads.
# Never replace the live production volume during a rehearsal.
```

## Payments activation

**Activation hold:** the deployed implementation uses destination charges, which charge Stripe's
processing fees to the platform. A 1% contribution can therefore produce a loss. Before enabling
live sales, complete and verify the organizer-paid processing model in
[`docs/STRIPE_ACTIVATION.md`](../../docs/STRIPE_ACTIVATION.md). The steps below describe the current
integration, not a completed payment launch.

Configure `STRIPE_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET` securely in the server environment, then recreate the app. Keep test and
live keys/endpoints separate. Do not place secrets in chat, source control or browser JavaScript.
The webhook destination is `https://unconference.events/api/webhooks/stripe`, listening for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`

Before live sales, verify a sandbox organizer completes Connect onboarding and has both charges
and payouts enabled. Use the app's Connect flow; settings refuse pasted account IDs. Test a $25
ticket with a 3% contribution: the application fee is $0.75, without a fixed platform surcharge.
Confirm the signed webhook creates one entitlement and notification, retries do not duplicate
fulfillment, and a full refund revokes participation even if completion is replayed. Verify the
revenue page against Stripe. Partial refunds and processing fees remain Stripe-side accounting.

The contribution is snapshotted when checkout opens; changing the event's rate affects new
checkouts. Disconnecting payouts stops paid sales while preserving ticket admission restrictions.
Free passes can operate without Stripe configuration. Missing secrets or incomplete payout
onboarding must never be presented as a successful live payment verification.

## Feed, map and knowledge (optional services)

- **Feed**: no configuration. Organizers turn it on per gathering (Settings → Feed & network); posts
  go through the audited port as the gathering account. Off by default.
- **Map**: `NEXT_PUBLIC_MAP_STYLE_URL` (default OpenFreeMap `liberty`, key-less) and `GEOCODER_URL`
  (default Nominatim; the app sends `User-Agent: unconference.events (hello@unconference.events)`,
  paces to 1 request/s and caches 30 days). The map style is compiled in at build time, so changing
  it needs a release.
- **Knowledge**: the corpus export works with nothing configured. Set `EMBEDDINGS_PROVIDER`
  (`voyage`|`openai`), `EMBEDDINGS_MODEL`, `EMBEDDINGS_API_KEY` for embeddings and
  `ANTHROPIC_API_KEY` (+ `AI_CHAT_MODEL`, default `claude-sonnet-5`) for "Ask the gathering",
  summaries and themes; the Knowledge page shows which parts are active. Transcript text reaches
  those providers only when they are configured; the Participation settings disclose this.

## Health and verification

- `https://unconference.events/api/health` → `{"status":"ok","checks":{"db":"ok","pds":"ok"}}`
- `https://unconference.events/oauth/client-metadata.json` → confidential client (`private_key_jwt`)
- `https://pds.unconference.events/xrpc/_health` → PDS version
- `https://<handle>.unconference.events/.well-known/atproto-did` → that account's DID
- Relay: `https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=<did>` once the PDS has requested a crawl
