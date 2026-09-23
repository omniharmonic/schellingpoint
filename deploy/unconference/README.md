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
| `scheduler` | `curlimages/curl` | job loop: close rounds + drain publish/feed jobs (1 min), the gathering clock (`/api/jobs/lifecycle`: automatic phase changes, reminders, organizer alerts), notification dispatch and knowledge jobs (5 min), reconcile ATProto (hourly), retention (daily) |
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

A run counts as good only when every artifact it should have produced exists at a plausible size,
locally and in the bucket (`pds-blocks.tar.gz.age` only once `/pds/blocks` exists). A missing one is
logged as `BACKUP INCOMPLETE: <artifact>` and the run fails; a good run stamps `/backups/last-ok`.
The `backup` service's healthcheck (`backup.sh --check`) goes unhealthy when that marker is more
than 30 hours old — i.e. when a nightly silently stopped producing restorable backups. Check it with
`$C ps` and `$C exec backup /usr/local/bin/backup.sh --check`.

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

**Not activated:** no Stripe key exists on this box or anywhere else, so paid checkout answers
503 and free tickets work as usual. The *model* is now the right one — organizers are the
merchant of record and are charged Stripe's processing fees directly, with unconference taking
only the contribution as an application fee — and it is covered by tests, but Stripe has never
answered any of it. Read [`docs/STRIPE_ACTIVATION.md`](../../docs/STRIPE_ACTIVATION.md) before
touching anything here; it lists exactly what is implemented and what still needs a human.

Configure the server environment and recreate the app:

- `STRIPE_SECRET_KEY` — a **restricted** key, not a CLI session credential. It decides the
  deployment's mode: a `sk_live_`/`rk_live_` key makes this a live deployment and any webhook
  delivery whose `livemode` disagrees is refused. Permissions this implementation needs, write
  unless stated: Checkout Sessions, PaymentIntents (read), Charges (read), Refunds,
  Application fees (read), Connected accounts, Account links, Account login links, Webhook
  endpoints (read).
- `STRIPE_WEBHOOK_SECRET` — the signing secret of the destination below.
- `STRIPE_WEBHOOK_SECRET_CONNECT` — optional, when the Connect destination signs with its own
  secret. Deliveries are checked against every configured secret.
- `STRIPE_ACCOUNTS_API=v1` — optional escape hatch that forces the v1 `controller` account
  path when Accounts v2 is not enabled for the platform. Leave unset to prefer v2.
- `STRIPE_ALLOW_PLATFORM_CHARGES=true` — optional, charges the platform account when a
  gathering has no merchant connected. Off by default and should stay off.

Keep sandbox and live keys, destinations and secrets strictly separate, and never put a secret
in chat, source control or browser JavaScript. Nothing logs a secret, signature or payload.

The webhook destination is `https://unconference.events/api/webhooks/stripe`, listening for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `charge.refunded`
- `account.updated` (Connect; keeps merchant capabilities current and pauses paid sales when a
  merchant loses one)

Deliveries arrive on the organizer's connected account. The app never grants admission from a
delivery's metadata: it resolves the session against its own `checkout_references` row and
requires that the reference's account matches both the delivered account and the gathering's
current one. Each delivery is also claimed by its Stripe event id (`stripe_events`) under a
lock held for the whole handler, so redeliveries — even simultaneous ones — do nothing, and
every refund carries a Stripe idempotency key.

A paid delivery the app refuses is recorded with its reason and listed on the revenue page
("payments that could not be matched to a checkout"): somebody was charged and got no ticket,
so it must not live only in a log. Where the payment is provably ours it is refunded
automatically in the merchant's context; the rest need checking in the Stripe dashboard.

Before live sales, run the sandbox walk-through in `docs/STRIPE_ACTIVATION.md`:
`STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-sandbox-verify.mjs`. A $25 ticket at a 3%
contribution must produce a $0.75 application fee, no `transfer_data`, and a Stripe processing
fee deducted from the **organizer's** balance — with no fixed platform surcharge. Confirm the
signed webhook creates one entitlement and one notification, that retries and redeliveries do
not duplicate fulfillment, and that a full refund revokes participation even if the completion
is replayed. Compare the revenue page against Stripe: it reports the platform contribution as
the application fees actually collected, and the organizer's net as gross minus that
contribution, explicitly before Stripe processing fees.

Organizers refund from the gathering's Settings → Tickets page ("Paid sales"). Refunds are
issued in their own account's context; a full refund returns the contribution with it and
cancels the ticket, a partial refund does neither. Stripe processing fees are never returned.

The contribution is snapshotted when checkout opens; changing the event's rate affects new
checkouts. Disconnecting payouts stops paid sales while preserving ticket admission
restrictions. Free passes work without any Stripe configuration. Missing secrets, incomplete
onboarding or a paused merchant must never be presented as a successful live payment
verification.

## Feed, map and knowledge (optional services)

- **Feed**: no configuration. Organizers turn it on per gathering (Settings → Feed & network); posts
  go through the audited port as the gathering account. Off by default.
- **Map**: `NEXT_PUBLIC_MAP_STYLE_URL` (default OpenFreeMap `liberty`, key-less) and `GEOCODER_URL`
  (default Nominatim; the app sends `User-Agent: unconference.events (hello@unconference.events)`,
  paces to 1 request/s and caches 30 days). The map style is compiled in at build time, so changing
  it needs a release.
- **Knowledge — embeddings**: on by default and free. With `EMBEDDINGS_PROVIDER` unset the server
  embeds on its own CPU with Transformers.js (`Xenova/bge-small-en-v1.5`, 384 dims, q8 ONNX,
  ~33 MB), so the corpus is searchable with no API key and no transcript text leaving the box. The
  weights are baked into the image at `/models` by a build stage (`scripts/fetch-embedding-model.mjs`)
  and the runtime image sets `EMBEDDINGS_CACHE_DIR=/models` and `EMBEDDINGS_OFFLINE=1`, so the
  running server never reaches the Hugging Face hub — a release carries its own weights and a
  rollback keeps working. The Knowledge page reads `Embeddings: local (bge-small-en-v1.5)`; a model
  that fails to load shows there as an error instead of breaking the page.
  - `EMBEDDINGS_MODEL` picks a different Transformers.js model (rebuild so the image prefetches it).
    Chunks record their model as `local:<model>`, so changing it retires the old vectors and the
    embed job re-embeds; press **Embed now** on the Knowledge page or wait for the five-minute
    scheduler tick.
  - `EMBEDDINGS_PROVIDER=none` switches embeddings off entirely (export still works).
    `voyage`/`openai` stay opt-in and need `EMBEDDINGS_MODEL` + `EMBEDDINGS_API_KEY`; those do send
    transcript text off the box, which the Participation settings disclose.
- **Knowledge — answers**: `ANTHROPIC_API_KEY` (+ `AI_CHAT_MODEL`, default `claude-sonnet-5`) for
  "Ask the gathering", summaries and themes. Without it the Knowledge page reads
  `Answers: not configured` and those buttons stay disabled; search and the export are unaffected.

## Remote MCP server (members' own AI assistants)

`https://unconference.events/api/mcp` is a read-only MCP server (Streamable HTTP, stateless) that a
member connects their own assistant to — Claude, ChatGPT, Cursor. No configuration and no key: it
is on wherever the app is. A member mints a personal token in Account → Identity ("Connect an AI
assistant"); the token is `unc_<32 bytes base64url>`, shown once, stored only as its sha256
(`assistant_tokens`, migration 0028, server-only), at most five live per person, revoked
immediately from the same place. Requests authenticate with `Authorization: Bearer unc_…`; anything
else gets a 401 with `WWW-Authenticate: Bearer`. The route answers
`Access-Control-Allow-Origin: *` so browser-based clients (claude.ai custom connectors) can reach
it — safe because the credential is a header token and never an ambient cookie, and because every
tool is read-only. `/.well-known/oauth-protected-resource` serves RFC 9728 metadata with an empty
`authorization_servers` list, so a client that probes for an OAuth dance gets clean JSON pointing at
`/help/assistants` instead of the app's HTML 404. Budget: 120 requests a minute per token, counted
in the app process (one container, so that is the whole limit; more than one replica would multiply
it). Tools resolve the token to an account and then go through the same membership, session
visibility and transcript-tier checks the browser does — `search_knowledge` uses whatever embeddings
adapter is configured above and says so plainly when there is none, `export_corpus` is organizers
only and each page is logged to `knowledge_exports` like a zip download. Members-facing
instructions live at `/help/assistants`.

## Health and verification

- `https://unconference.events/api/health` → `{"status":"ok","checks":{"db":"ok","pds":"ok"}}`
- `https://unconference.events/oauth/client-metadata.json` → confidential client (`private_key_jwt`)
- `https://pds.unconference.events/xrpc/_health` → PDS version
- `https://<handle>.unconference.events/.well-known/atproto-did` → that account's DID
- Relay: `https://bsky.network/xrpc/com.atproto.sync.getRepoStatus?did=<did>` once the PDS has requested a crawl
