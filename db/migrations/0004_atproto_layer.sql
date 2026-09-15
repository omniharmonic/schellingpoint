-- 0004_atproto_layer.sql — work package F (the ATProto layer on our own PDS).
--
-- Not duplicated here: policy thresholds (events.policy_thresholds, 0007/A), track skill URIs
-- (tracks.skill_uris, 0006/D), the role-claim opt-in (event_members.public_role, 0008/G).
--
-- Everything here is app-side state the protocol surface needs and must not publish:
--   approval_requests          destructive actions (move / cancel / remove-listing) awaiting stewards
--   approval_request_approvals one row per organizer approval; the record itself lives in THEIR repo
--   listings                   coop.lexicon.event.listing bookkeeping (sticky removal lives here)
--   peers                      peer gatherings/schools; outward cross-listing is off per peer by default
--   role_claims                the published coop.lexicon.membership claim per (gathering, member); the
--                              subject's opt-in itself is event_members.public_role (0008, package G)
--   time_preferences           a proposer's availability; app-side unless they opt in to publish
--   at_repo_state              reconciliation bookkeeping per repo we index
--   at_series / at_occurrences recurring gatherings (freeschool.draft.series / .occurrence)
-- plus columns on existing tables: session drift/withdrawal flags, skills, venue address parts and the
-- private-residence flag, gathering-actor credential health, and approvals on the audit row.
--
-- Every scoped table carries event_id NOT NULL with event_id as its leading index column. RLS is on with
-- no policies: only the app's service connection (BYPASSRLS) reads or writes these tables.

-- ─────────────────────────────── columns on existing tables ───────────────────────────────

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS skill_uris text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS proposal_drift_cid text,
  ADD COLUMN IF NOT EXISTS proposal_drift_at timestamptz,
  ADD COLUMN IF NOT EXISTS proposal_withdrawn_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_skill_uris_max_five CHECK (cardinality(skill_uris) <= 5);

COMMENT ON COLUMN public.sessions.skill_uris IS 'freeschool.draft.skill AT-URIs (at most 5), written into the proposer''s proposal record.';
COMMENT ON COLUMN public.sessions.proposal_drift_cid IS 'Set by ingest when the proposer''s record cid no longer matches the cid the published slot pins. Cleared on re-publish.';
COMMENT ON COLUMN public.sessions.proposal_withdrawn_at IS 'Set by ingest when the proposer deleted their record. The schedule is never changed automatically.';
-- A self-hosted session's PUBLIC place label, chosen knowingly by the proposer ("Near Pearl St,
-- Boulder"). The exact address stays in custom_location, attendee-only; it never reaches a record.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS public_place text;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_public_place_length CHECK (public_place IS NULL OR char_length(public_place) <= 200);

COMMENT ON COLUMN public.sessions.public_place IS 'Coarse public place label for a self-hosted session (<= 200 chars). The exact address (custom_location) is never published.';
COMMENT ON COLUMN public.sessions.cancelled_at IS 'Set when a published session''s cancellation was applied (calendar event #cancelled, slot cancelled).';

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS locality text,
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS postal_code text,
  ADD COLUMN IF NOT EXISTS country text,
  ADD COLUMN IF NOT EXISTS is_private_residence boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.venues.is_private_residence IS 'When true, published records carry only the locality (neighbourhood/city), never the street address.';

ALTER TABLE public.at_credentials
  ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz;

COMMENT ON COLUMN public.at_credentials.disabled_at IS 'Set when the credential failed persistently (revoked/rotated elsewhere). Writes for that gathering stop; organizers see a banner.';

ALTER TABLE public.at_audit
  ADD COLUMN IF NOT EXISTS approvals jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS policy_source text;

-- ─────────────────────────────── approvals ───────────────────────────────

CREATE TABLE public.approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.sessions(id) ON DELETE CASCADE,
  listing_id uuid,
  action text NOT NULL CHECK (action IN ('move', 'cancel', 'remove-listing')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applying', 'applied', 'withdrawn', 'failed')),
  requested_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 2000),
  -- move: { "timeSlotId": uuid, "venueId": uuid|null } — the app row changes only when the move is applied
  target jsonb NOT NULL DEFAULT '{}'::jsonb,
  threshold integer NOT NULL CHECK (threshold BETWEEN 1 AND 5),
  -- the record the action acts on (current slot / listing) and the record it will produce
  subject_uri text,
  proposal_uri text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_requests_event_idx ON public.approval_requests (event_id, status, created_at DESC);
-- one open request per subject and action
CREATE UNIQUE INDEX approval_requests_open_session_idx ON public.approval_requests (event_id, session_id, action)
  WHERE status IN ('pending', 'applying') AND session_id IS NOT NULL;
CREATE UNIQUE INDEX approval_requests_open_listing_idx ON public.approval_requests (event_id, listing_id, action)
  WHERE status IN ('pending', 'applying') AND listing_id IS NOT NULL;

CREATE TABLE public.approval_request_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES public.approval_requests(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- freeschool.draft.approval in the approver's OWN repo
  record_uri text NOT NULL,
  record_cid text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, account_id)
);
CREATE INDEX approval_request_approvals_event_idx ON public.approval_request_approvals (event_id, request_id);

-- ─────────────────────────────── listings and peers ───────────────────────────────

CREATE TABLE public.listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  session_id uuid REFERENCES public.sessions(id) ON DELETE SET NULL,
  -- the community.lexicon.calendar.event being curated, pinned by strongRef
  subject_uri text NOT NULL,
  subject_cid text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('own', 'peer')),
  record_uri text,
  record_cid text,
  status text NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'removed')),
  tags text[] NOT NULL DEFAULT '{}'::text[],
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, subject_uri)
);
CREATE INDEX listings_event_idx ON public.listings (event_id, status);
ALTER TABLE public.approval_requests
  ADD CONSTRAINT approval_requests_listing_id_fkey FOREIGN KEY (listing_id) REFERENCES public.listings(id) ON DELETE CASCADE;

CREATE TABLE public.peers (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  peer_did text NOT NULL CHECK (peer_did ~ '^did:[a-z]+:[A-Za-z0-9._:%-]+$'),
  label text,
  -- outward cross-listing of this peer's events onto our calendar: off until an organizer enables it
  cross_listing_enabled boolean NOT NULL DEFAULT false,
  added_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, peer_did)
);

-- ─────────────────────────────── role claims and time preferences ───────────────────────────────

CREATE TABLE public.role_claims (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  published_role integer NOT NULL,
  record_uri text NOT NULL,
  record_cid text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, account_id)
);

CREATE TABLE public.time_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  blackouts jsonb NOT NULL DEFAULT '[]'::jsonb,
  publish boolean NOT NULL DEFAULT false,
  record_uri text,
  record_cid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, account_id)
);
CREATE INDEX time_preferences_event_idx ON public.time_preferences (event_id, session_id);

-- ─────────────────────────────── indexing bookkeeping ───────────────────────────────

CREATE TABLE public.at_repo_state (
  did text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('own-pds', 'oauth', 'peer', 'authority')),
  reconciled_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS at_records_proposal_ref_idx ON public.at_records ((record -> 'proposal' ->> 'uri'))
  WHERE collection IN ('schellingpoint.draft.cohost', 'schellingpoint.draft.endorsement', 'schellingpoint.draft.timePreference', 'schellingpoint.draft.slot');
CREATE INDEX IF NOT EXISTS at_records_gathering_idx ON public.at_records ((record ->> 'gathering'))
  WHERE collection = 'schellingpoint.draft.proposal';

-- ─────────────────────────────── recurring gatherings ───────────────────────────────

CREATE TABLE public.at_series (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  rrule text NOT NULL CHECK (char_length(rrule) BETWEEN 1 AND 1024),
  freq text NOT NULL CHECK (freq IN ('daily', 'weekly', 'monthly', 'yearly')),
  "interval" integer NOT NULL DEFAULT 1 CHECK ("interval" >= 1),
  by_day text[] NOT NULL DEFAULT '{}'::text[],
  count integer CHECK (count IS NULL OR count >= 1),
  until timestamptz,
  exdates timestamptz[] NOT NULL DEFAULT '{}'::timestamptz[],
  timezone text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 1 AND 100000),
  materialize_ahead_days integer NOT NULL DEFAULT 90 CHECK (materialize_ahead_days BETWEEN 1 AND 730),
  first_event_uri text,
  first_event_cid text,
  record_uri text,
  record_cid text,
  created_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT at_series_count_or_until CHECK (count IS NULL OR until IS NULL)
);
CREATE INDEX at_series_event_idx ON public.at_series (event_id);

CREATE TABLE public.at_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  series_id uuid NOT NULL REFERENCES public.at_series(id) ON DELETE CASCADE,
  original_starts_at timestamptz NOT NULL,
  sequence integer NOT NULL CHECK (sequence >= 1),
  event_uri text,
  event_cid text,
  record_uri text,
  record_cid text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (series_id, original_starts_at)
);
CREATE INDEX at_occurrences_event_idx ON public.at_occurrences (event_id, series_id);

-- ─────────────────────────────── row security and grants ───────────────────────────────

ALTER TABLE public.approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_request_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.peers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.at_repo_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.at_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.at_occurrences ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.approval_requests, public.approval_request_approvals, public.listings,
  public.peers, public.role_claims, public.time_preferences, public.at_repo_state, public.at_series,
  public.at_occurrences
TO service_role;
