-- 0022: the gathering feed (design §7): posts from the gathering's own account about its activity.
--
-- events.feed_posts             gathering-level gate, off by default ("Post activity to the
--                               gathering's feed" in Feed & network settings).
-- events.feed_digest_threshold  when one schedule publish would post about more sessions than
--                               this, ONE digest post replaces the per-session posts.
-- event_members.mention_in_posts
--                               the person's own per-gathering consent to be @-mentioned in posts
--                               about sessions they host. One of three structural gates (R9): the
--                               port also requires them to be the session's host or a self-written
--                               co-host, and their repo to be visible. Never set by an organiser.
-- feed_posts                    the ledger every post goes through: the row is claimed BEFORE the
--                               record is written (one per event+kind+subject), so re-running a
--                               publish never double-posts. `mentions` records which DIDs were named
--                               with consent at post time (the privacy audit checks against it).
--                               Server-only (migration 0009's rule): RLS on, no policies, no
--                               privileges for anon/authenticated. Organisers read it through the
--                               AppView's feed route; members never need their own row.
-- publish_jobs.kind             gains 'feed': one live delivery job per gathering, drained by the
--                               scheduler's /api/jobs/publish minute loop like schedule publishes.

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS feed_posts boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS feed_digest_threshold integer NOT NULL DEFAULT 10;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_feed_digest_threshold_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_feed_digest_threshold_check CHECK (feed_digest_threshold BETWEEN 1 AND 100);
COMMENT ON COLUMN public.events.feed_posts IS
  'Post the gathering''s activity from its own network account (design §7). Off by default; organisers switch it on.';
COMMENT ON COLUMN public.events.feed_digest_threshold IS
  'One schedule publish posting about more sessions than this writes a single digest post instead of one per session.';

ALTER TABLE public.event_members
  ADD COLUMN IF NOT EXISTS mention_in_posts boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.event_members.mention_in_posts IS
  'The member''s own consent to be @-mentioned in this gathering''s posts about sessions they host (R9 gate; design §7.2). Per gathering, off by default, never set by an organiser.';

CREATE TABLE IF NOT EXISTS public.feed_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'gathering-published', 'proposals-open', 'voting-open', 'schedule-published', 'schedule-digest',
    'session-scheduled', 'session-moved', 'session-cancelled'
  )),
  -- The session for session kinds; NULL for gathering kinds.
  subject_id uuid,
  -- Idempotency key: the session id for session kinds, '' for gathering kinds, a batch id for digests.
  subject_key text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'posted', 'failed', 'digested', 'deleted')),
  -- Filled when the record is written.
  uri text,
  cid text,
  rkey text,
  text text NOT NULL DEFAULT '',
  facets jsonb NOT NULL DEFAULT '[]'::jsonb,
  embed jsonb,
  -- DIDs named by a mention facet, each with consent at post time: [{did, handle}].
  mentions jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Kind-specific inputs known at enqueue time (digest count, schedule-published totals).
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS feed_posts_once_idx ON public.feed_posts (event_id, kind, subject_key);
CREATE INDEX IF NOT EXISTS feed_posts_event_idx ON public.feed_posts (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS feed_posts_queued_idx ON public.feed_posts (event_id, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS feed_posts_uri_idx ON public.feed_posts (uri) WHERE uri IS NOT NULL;

COMMENT ON TABLE public.feed_posts IS
  'Ledger of the gathering account''s app.bsky.feed.post records: claimed before the write (idempotent per event+kind+subject), delivered by publish_jobs kind=feed. Server-only.';
COMMENT ON COLUMN public.feed_posts.mentions IS
  'DIDs a mention facet named, each consented at post time (event_members.mention_in_posts + host/co-host + visible repo). The privacy audit allows a foreign DID in a post only when it is listed here.';

ALTER TABLE public.feed_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feed_posts FROM anon, authenticated;

-- Feed delivery reuses the resumable job machinery (one live job per gathering and kind).
ALTER TABLE public.publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_kind_check;
ALTER TABLE public.publish_jobs ADD CONSTRAINT publish_jobs_kind_check CHECK (kind IN ('schedule', 'feed'));
