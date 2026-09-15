# db/

The AppView's only database is plain PostgreSQL 16. Server code reaches it through
`src/lib/db` (`sql`, `tx`, `asAccount`); nothing in the browser touches it.

```
db/
├── migrations/   NNNN_name.sql, applied in lexical order by scripts/db-migrate.mjs
└── seeds/        *.sql demo data, applied by scripts/db-seed.mjs (ALLOW_SEED=true only)
```

## Commands

```bash
# DDL runs as the database owner. DATABASE_MIGRATION_URL wins over DATABASE_URL.
DATABASE_URL=postgres://unconference:unconference@127.0.0.1:55432/unconference \
APP_DB_USER=unconference_app APP_DB_PASSWORD=unconference_app \
  npm run db:migrate

ALLOW_SEED=true DATABASE_URL=postgres://unconference:unconference@127.0.0.1:55432/unconference \
  npm run db:seed
```

`db:migrate`:
1. creates `public.app_migrations(version, name, applied_at)` if missing;
2. applies each unapplied `db/migrations/NNNN_name.sql` in its own transaction (under an
   advisory lock) and records `NNNN` as applied, printing one line per file;
3. if `APP_DB_USER`/`APP_DB_PASSWORD` are set, creates or updates that role as
   `LOGIN BYPASSRLS NOSUPERUSER`, makes it a member of `authenticated` and `anon` (so
   `asAccount()` can `SET LOCAL ROLE authenticated`), and grants `CONNECT`, schema usage,
   table/sequence/function privileges and matching default privileges. Idempotent.

It exits non-zero on the first failure; the failing file's transaction is rolled back.

## Writing a migration

- Next number, descriptive name: `db/migrations/0002_ballot_keys.sql`.
- Do not wrap the file in `BEGIN`/`COMMIT`; the migrator already does.
- Event-scoped tables carry `event_id uuid NOT NULL REFERENCES events(id)` with an index.
- Enable RLS and add policies for anything `asAccount()` code reads or writes; the
  service connection bypasses RLS, so policies are defense in depth.
- Objects created by the owner automatically get grants for `authenticated` and
  `service_role` (default privileges from the baseline). The app role gets default
  privileges from the migrator.
- A file that has been applied anywhere is never edited; add a new one.

## Roles

| Role | Login | Purpose |
|---|---|---|
| owner (`POSTGRES_USER`, e.g. `unconference`) | yes | runs migrations; owns every object, so `SECURITY DEFINER` helpers run as it |
| `APP_DB_USER` (e.g. `unconference_app`) | yes | the app, indexer and scheduler connection (`DATABASE_URL`); `BYPASSRLS` |
| `authenticated` | no | what `asAccount()` switches to; RLS applies |
| `anon`, `service_role` | no | kept because existing policies and grants name them |

## How 0001_baseline.sql was made

Source: `docker exec supabase_db_mvp pg_dump -U postgres --schema-only --schema=public --no-owner`
of the local Supabase stack with every `supabase/migrations/*.sql` applied, through
`20260916000002_atproto_ingest_rules.sql`. The dump was transformed as follows; a
`pg_dump` of the result, diffed against the source, shows only these changes (plus
PostgreSQL 16 vs 17 deparsing of two `CHECK` arrays and role-list order in policies).

Removed (Supabase-only):
- the dump header: `\restrict`/`\unrestrict` psql meta-commands, `SET transaction_timeout`
  (PostgreSQL 17 only), `CREATE SCHEMA public` and its comment;
- every ACL statement of the dump (grants to `postgres`, `anon` table grants, `ALTER DEFAULT
  PRIVILEGES FOR ROLE postgres/supabase_admin`), replaced by section 7 of the baseline;
- objects outside `public` never enter the file: the `storage` bucket rows and
  `storage.objects` policies (`20260218100002_create_event_assets_bucket.sql`,
  `20260219100001_fix_event_assets_rls.sql`), `supabase_realtime` publication membership,
  `pg_graphql`, `supabase_vault`/`pgsodium`, `pg_net`, `pg_stat_statements`, `uuid-ossp`
  (unused by `public`), and the `auth.users` table with its `on_auth_user_created` trigger.

Added:
- `extensions` schema with `pgcrypto` in it, because `cohost_invites.token` and
  `event_invitations.token` default to `extensions.gen_random_bytes(32)`;
- roles `anon`, `authenticated` (NOLOGIN NOINHERIT) and `service_role` (NOLOGIN NOINHERIT
  BYPASSRLS), created idempotently;
- schema `auth` with only `auth.uid()`, reading `sub` from `request.jwt.claims`. It is the plan's
  definition with one extra `nullif(…, '')` around the setting: after a transaction-local
  `set_config` ends, a pooled connection reports `''`, and `''::jsonb` would raise inside any
  trigger or policy that calls `auth.uid()` on the service connection. `auth.role()` and
  `auth.jwt()` are not referenced anywhere, so they are not created;
- `public.accounts` and `public.auth_email_tokens` exactly per the plan's DDL, plus indexes on
  `auth_email_tokens(email, created_at desc)`, `(account_id)`, `(expires_at)`; RLS enabled on
  both, with one policy letting `authenticated` read its own `accounts` row. `authenticated`
  has column-level `SELECT` on `accounts` without `wrapped_password`/`key_version`, and no
  privileges on `auth_email_tokens`;
- trigger `on_account_created AFTER INSERT ON public.accounts → handle_new_user()`.

Rewritten (`auth.users` → `public.accounts`):
- `profiles.profiles_id_fkey`: `profiles(id) → accounts(id) ON DELETE CASCADE`;
- `notifications.notifications_user_id_fkey`: `→ accounts(id) ON DELETE CASCADE`;
- `notification_preferences.notification_preferences_user_id_fkey`: `→ accounts(id) ON DELETE CASCADE`;
- `event_invitations.event_invitations_created_by_fkey`: `→ accounts(id)` (no action, as before);
- `handle_new_user()`: previously `AFTER INSERT ON auth.users`, inserting
  `(NEW.id, NEW.email, coalesce(raw_user_meta_data->>'display_name', split_part(email,'@',1)))`.
  Now fires on `accounts`, and inserts `(NEW.id, coalesce(NEW.email, ''),
  coalesce(first label of NEW.handle, email local part))` with `ON CONFLICT (id) DO NOTHING`.
  `profiles.email` is `NOT NULL`, so OAuth-only accounts get `''` until an email is added.

Other identity changes:
- `at_sessions.at_sessions_kind_check`: `('oauth','app-password')` → `('custodial','oauth')`;
- `at_sessions.at_sessions_user_id_fkey`: `profiles(id)` → `accounts(id) ON DELETE CASCADE`;
- `at_credentials` is unchanged (`'app-password'` now means a gathering account minted on our PDS).

Function ACLs: every function in `public` is executable by `authenticated` and `service_role`
(and, by PostgreSQL default, `PUBLIC`), except the helpers the source revoked from `PUBLIC`, which
keep exactly the source grants: `can_manage_session`, `can_read_event`, `can_read_session_event`,
`enforce_event_proposal_rules`, `enforce_event_vote_rules`, `enforce_session_update_rules`,
`event_role`, `fill_cohost_event_id`, `is_session_cohost`, `is_session_host`,
`is_session_organizer`, `session_feedback_summary`, `session_started_at` (anon, authenticated,
service_role) and `create_event_with_program` (service_role only). The app role is granted
`EXECUTE` on all of them by the migrator.

Everything else — 28 application tables, 30 functions, 42 constraints, 51 foreign keys,
55 indexes, 19 triggers, 83 RLS policies, and the participation, notification and vote
triggers — is the dump verbatim, with pg_dump's three-line object banners shortened to
`-- type: name`.
