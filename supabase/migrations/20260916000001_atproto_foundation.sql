-- ATProto foundation: identity columns on existing tables, OAuth/session/credential
-- storage, the gathering-actor audit log, and a public index of network records.
-- Every statement is idempotent so the migration can be re-applied safely.
--
-- Design source: docs/ATPROTO_MIGRATION_SPEC.md §3–§5, §8. R9 (no public record
-- names a DID its holder did not write) is enforced in src/lib/atproto, not here;
-- these columns only remember WHERE a record went (uri/cid) and WHO the actor is.

-- ============================================================================
-- 1. profiles: a person's own ATProto identity (linked via OAuth or custody).
-- ============================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS did text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS atproto_handle text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS atproto_linked_at timestamptz;
-- Per-user opt-in: write my proposals into MY repo (default off; the gathering
-- may still list a stub that names nobody).
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS publish_proposals boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_did_key ON public.profiles (did) WHERE did IS NOT NULL;

-- ============================================================================
-- 2. events: the gathering actor and the records it has published.
-- ============================================================================
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS actor_did text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS actor_handle text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS gathering_uri text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS gathering_cid text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS calendar_event_uri text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS calendar_event_cid text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS policy_uri text;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS atproto_published_at timestamptz;
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS atproto_tags text[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS events_actor_did_idx ON public.events (actor_did) WHERE actor_did IS NOT NULL;

-- ============================================================================
-- 3. sessions: the proposer's record (their repo) and the gathering's slot +
--    calendar event (gathering repo). host_did is the PROPOSER's DID as known
--    app-side; it is never copied into a public record.
-- ============================================================================
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS host_did text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS proposal_uri text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS proposal_cid text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS calendar_event_uri text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS calendar_event_cid text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS slot_uri text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS slot_cid text;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS atproto_published_at timestamptz;
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS imported_from text;
CREATE UNIQUE INDEX IF NOT EXISTS sessions_proposal_uri_key ON public.sessions (proposal_uri) WHERE proposal_uri IS NOT NULL;
CREATE INDEX IF NOT EXISTS sessions_host_did_idx ON public.sessions (host_did) WHERE host_did IS NOT NULL;

-- ============================================================================
-- 4. venues / tracks / cohosts / rsvps: where each row's record lives.
-- ============================================================================
ALTER TABLE public.venues ADD COLUMN IF NOT EXISTS at_uri text;
ALTER TABLE public.venues ADD COLUMN IF NOT EXISTS at_cid text;
ALTER TABLE public.tracks ADD COLUMN IF NOT EXISTS at_uri text;
ALTER TABLE public.tracks ADD COLUMN IF NOT EXISTS at_cid text;
-- The co-host's OWN schellingpoint.draft.cohost record (double opt-in, §4.2).
ALTER TABLE public.session_cohosts ADD COLUMN IF NOT EXISTS cohost_uri text;
-- The attendee's OWN opt-in community.lexicon.calendar.rsvp record.
ALTER TABLE public.session_rsvps ADD COLUMN IF NOT EXISTS rsvp_uri text;

-- ============================================================================
-- 5. OAuth client state (NodeOAuthClient state/session stores + signing key).
--    RLS enabled with NO policies: service role only.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.at_oauth_state (
  key        text PRIMARY KEY,
  state      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.at_oauth_state ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.at_oauth_session (
  sub        text PRIMARY KEY,
  session    jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.at_oauth_session ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.at_oauth_client_key (
  kid        text PRIMARY KEY,
  jwk        jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.at_oauth_client_key ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 6. Browser sessions bound to a DID (the `sp_at_session` cookie's row).
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.at_sessions (
  id         text PRIMARY KEY,
  did        text NOT NULL,
  user_id    uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('oauth', 'app-password')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
ALTER TABLE public.at_sessions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS at_sessions_did_idx ON public.at_sessions (did);
CREATE INDEX IF NOT EXISTS at_sessions_expires_at_idx ON public.at_sessions (expires_at);

-- ============================================================================
-- 7. Custodied credentials (gathering actors and custodial accounts). The
--    secret is AES-256-GCM wrapped under ATPROTO_CUSTODY_KEY (key_version
--    names which key). Never readable by anything but the service role.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.at_credentials (
  did           text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('oauth', 'app-password')),
  identifier    text,
  wrapped       bytea,
  key_version   text,
  pds_url       text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  rotated_at    timestamptz,
  last_ok_at    timestamptz,
  last_error_at timestamptz,
  last_error    text
);
ALTER TABLE public.at_credentials ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 8. Audit: one row per gathering-actor port call, allow or deny.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.at_audit (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id       uuid REFERENCES public.events(id) ON DELETE SET NULL,
  actor_did      text,
  caller_user_id uuid,
  action         text NOT NULL,
  collection     text,
  rkey           text,
  uri            text,
  decision       text NOT NULL CHECK (decision IN ('allow', 'deny')),
  reason         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.at_audit ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS at_audit_event_id_idx ON public.at_audit (event_id, created_at DESC);

-- ============================================================================
-- 9. Sync cursors (Jetstream / listRecords backfill) and slot-grid records.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.at_sync_cursor (
  source     text PRIMARY KEY,
  cursor     text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.at_sync_cursor ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.at_slot_grids (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  venue_id  uuid REFERENCES public.venues(id) ON DELETE CASCADE,
  day_date  date NOT NULL,
  uri       text,
  cid       text,
  UNIQUE (event_id, venue_id, day_date)
);
ALTER TABLE public.at_slot_grids ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS at_slot_grids_event_id_idx ON public.at_slot_grids (event_id);

-- ============================================================================
-- 10. at_records: an index of PUBLIC network records (ours and peers'). These
--     are world-readable on the network already, so a public SELECT policy is
--     the honest shape. Writes remain service-role only.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.at_records (
  uri        text PRIMARY KEY,
  did        text NOT NULL,
  collection text NOT NULL,
  rkey       text NOT NULL,
  cid        text,
  record     jsonb NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now(),
  source     text
);
ALTER TABLE public.at_records ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS at_records_collection_did_idx ON public.at_records (collection, did);
DROP POLICY IF EXISTS "at_records are public" ON public.at_records;
CREATE POLICY "at_records are public" ON public.at_records FOR SELECT USING (true);
