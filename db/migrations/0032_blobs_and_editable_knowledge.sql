-- =============================================================================
-- 0032_blobs_and_editable_knowledge.sql — avatar blobs, retracting a feed post,
--                                          editable summaries and themes
-- =============================================================================
--
-- 1. at_blobs      Blobs a repo we hold the credential for has already uploaded, keyed by the
--                  sha256 of the BYTES WE SENT (after sharp re-encoding). A blob upload is an
--                  ordinary repo write: pacing it and re-uploading the same image on every
--                  publish would be waste, so the (did, source_hash) → cid mapping is cached
--                  here. It holds no image data — only a content hash, the blob's CID, its
--                  MIME type and size — and it is server-only.
--
--                  A blob is NOT a record: nothing here is indexed into `at_records` and the
--                  CID is meaningful only inside the repo that uploaded it.
--
-- 2. approval_requests gains the destructive action 'delete-post' and the feed post it acts on.
--                  Retracting a post people may already have seen or shared is destructive
--                  exactly like moving or cancelling a published session: it needs the policy's
--                  `destructiveActionStewards` approvals, each a `freeschool.draft.approval`
--                  record in the approving organiser's own repo (spec §6, design §7.4).
--
-- 3. session_transcripts.summary_edited_at / _by  and  events.themes_edited_at / _by
--                  Design §10.3: summaries and themes are generated AND editable. Who last
--                  edited them is organiser-facing provenance, so a member reading the summary
--                  is reading what an organiser stands behind, not only what a model wrote.
-- =============================================================================

-- ─────────────────────────────── 1. blobs ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.at_blobs (
  did text NOT NULL,
  -- sha256 (hex) of the exact bytes uploaded, so the cache key survives re-encoding changes.
  source_hash text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  cid text NOT NULL,
  mime_type text NOT NULL,
  size integer NOT NULL CHECK (size > 0),
  -- What the blob is for, for the audit trail only ('gathering-avatar', 'person-avatar').
  purpose text NOT NULL DEFAULT 'avatar',
  event_id uuid REFERENCES public.events(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (did, source_hash)
);
CREATE INDEX IF NOT EXISTS at_blobs_did_idx ON public.at_blobs (did, created_at DESC);

COMMENT ON TABLE public.at_blobs IS
  'Blobs already uploaded to a repo we hold the credential for: (did, sha256 of the uploaded bytes) → blob CID. No image data, never indexed as a record, server-only.';

ALTER TABLE public.at_blobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.at_blobs FROM anon, authenticated;

-- ─────────────────────────────── 2. delete-post approvals ───────────────────────────────

ALTER TABLE public.approval_requests
  ADD COLUMN IF NOT EXISTS feed_post_id uuid REFERENCES public.feed_posts(id) ON DELETE CASCADE;
COMMENT ON COLUMN public.approval_requests.feed_post_id IS
  'The feed post a ''delete-post'' request retracts (design §7.4). NULL for every other action.';

ALTER TABLE public.approval_requests DROP CONSTRAINT IF EXISTS approval_requests_action_check;
ALTER TABLE public.approval_requests
  ADD CONSTRAINT approval_requests_action_check CHECK (action IN ('move', 'cancel', 'remove-listing', 'delete-post'));

-- One open retraction per post, mirroring the session and listing indexes.
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_open_post_idx
  ON public.approval_requests (event_id, feed_post_id, action)
  WHERE status IN ('pending', 'applying') AND feed_post_id IS NOT NULL;

-- ─────────────────────────────── 3. editable summaries and themes ───────────────────────────────

ALTER TABLE public.session_transcripts
  ADD COLUMN IF NOT EXISTS summary_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS summary_edited_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.session_transcripts.summary_edited_at IS
  'When an organiser last edited the generated summary (design §10.3). NULL = exactly as generated.';

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS themes_edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS themes_edited_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.events.themes_edited_at IS
  'When an organiser last edited the generated gathering themes (design §10.3). NULL = exactly as generated.';
