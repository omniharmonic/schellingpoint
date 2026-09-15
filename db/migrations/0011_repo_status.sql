-- 0011: account/identity status of the repos we index, and resumable publish jobs.
--
-- at_repo_status   the hosting status of a repo as last reported by the relay (Jetstream `#account`
--                  / `#identity` frames) or by the repo's own PDS (`com.atproto.sync.getRepoStatus`
--                  during reconciliation). A repo whose status hides it (takendown, suspended,
--                  deactivated, deleted, or any other inactive status we do not recognise) has its
--                  records filtered out of every read that serves them; app rows are FLAGGED, never
--                  deleted (sessions.author_inactive_at, session_cohosts.cohost_inactive_at).
--                  `desynchronized` / `throttled` are relay-side sync states, not moderation: the row
--                  records them but `hidden` stays false and reconciliation re-checks the PDS.
--                  `handle` is the bidirectionally verified handle (NULL = invalid / unverified).
-- publish_jobs     long network publishes (a schedule of more than 25 sessions) run as a job the
--                  scheduler drains through /api/jobs/publish, with progress the organiser UI polls.
--
-- Both tables are server-only (plan §6 item 25, migration 0009's rule): RLS on, no policies, no
-- privileges for anon/authenticated. Only the AppView's service connection reads or writes them.

CREATE TABLE IF NOT EXISTS public.at_repo_status (
  did text PRIMARY KEY,
  active boolean NOT NULL,
  status text,
  -- Who last asserted the status: 'relay' (Jetstream frame) or 'pds' (getRepoStatus on the repo's host).
  status_source text NOT NULL DEFAULT 'relay' CHECK (status_source IN ('relay', 'pds')),
  handle text,
  handle_verified_at timestamptz,
  hidden boolean GENERATED ALWAYS AS (NOT active AND coalesce(status, '') NOT IN ('desynchronized', 'throttled')) STORED,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS at_repo_status_hidden_idx ON public.at_repo_status (did) WHERE hidden;

COMMENT ON TABLE public.at_repo_status IS
  'Hosting status of indexed repos (relay #account frames, PDS getRepoStatus). hidden = records filtered from every read. Server-only.';
COMMENT ON COLUMN public.at_repo_status.handle IS
  'Handle verified both ways (DID doc alsoKnownAs -> handle resolves back to the DID). NULL when invalid; display falls back to the DID.';

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS author_inactive_at timestamptz;
COMMENT ON COLUMN public.sessions.author_inactive_at IS
  'Set when the proposer''s repo is taken down, suspended or deactivated: the session is hidden from queues and public reads and organisers are told. Cleared when the repo is active again.';

ALTER TABLE public.session_cohosts
  ADD COLUMN IF NOT EXISTS cohost_inactive_at timestamptz;
COMMENT ON COLUMN public.session_cohosts.cohost_inactive_at IS
  'Set when the co-host''s repo is inactive: the pairing is not rendered until the repo is active again.';

-- A targeted reconcile asked for by ingest (a Jetstream record that did not match its author's PDS, a
-- repo that became active again). The indexer and /api/atproto/sync drain these.
ALTER TABLE public.at_repo_state
  ADD COLUMN IF NOT EXISTS reconcile_requested_at timestamptz;
CREATE INDEX IF NOT EXISTS at_repo_state_reconcile_requested_idx ON public.at_repo_state (reconcile_requested_at) WHERE reconcile_requested_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_author_inactive_idx ON public.sessions (event_id) WHERE author_inactive_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'schedule' CHECK (kind IN ('schedule')),
  requested_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  -- The sessions to publish, resolved when the job is queued; `position` of them are done.
  session_ids uuid[] NOT NULL DEFAULT '{}',
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  published integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  -- Per-record results (kind, id, uri, error, skipped), capped by the job runner.
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publish_jobs_event_idx ON public.publish_jobs (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS publish_jobs_due_idx ON public.publish_jobs (run_after) WHERE status IN ('queued', 'running');
-- One live schedule publish per gathering: queueing again returns the job already in flight.
CREATE UNIQUE INDEX IF NOT EXISTS publish_jobs_one_active_idx ON public.publish_jobs (event_id, kind) WHERE status IN ('queued', 'running');

COMMENT ON TABLE public.publish_jobs IS
  'Resumable network publishes drained by /api/jobs/publish (scheduler). Server-only.';

ALTER TABLE public.at_repo_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.publish_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.at_repo_status FROM anon, authenticated;
REVOKE ALL ON public.publish_jobs FROM anon, authenticated;
