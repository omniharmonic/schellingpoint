-- Knowledge harvest (design §10): session transcripts, their chunks (with app-ranked embeddings —
-- no pgvector, see §10.3), the corpus export log and a small job queue for embedding / summaries.
--
-- Transcripts are never records and never public: they are served through the app to members of
-- the gathering (or organizers only, per gathering setting and per transcript). They cascade with
-- the session and the gathering. Everything here is private by default (0009); the two tables a
-- signed-in account may read are granted explicitly together with their RLS policies below.

-- ── Gathering policy ────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS transcripts_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS transcripts_visibility text NOT NULL DEFAULT 'members',
  ADD COLUMN IF NOT EXISTS themes jsonb;
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_transcripts_visibility_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_transcripts_visibility_check CHECK (transcripts_visibility IN ('members', 'organizers'));
COMMENT ON COLUMN public.events.transcripts_enabled IS 'Participation setting: hosts and organizers may attach transcripts to sessions.';
COMMENT ON COLUMN public.events.transcripts_visibility IS 'Default reading tier for transcripts: members of the gathering, or organizers only.';
COMMENT ON COLUMN public.events.themes IS 'Organizer-generated gathering themes {generated_at, model, themes:[{title, summary, sessions:[id]}]}; members-only, never a record.';

-- ── Transcripts ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.session_transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  uploaded_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('upload', 'paste')),
  format text NOT NULL CHECK (format IN ('txt', 'md', 'vtt', 'srt')),
  -- The normalized text lives in `content` so it is deleted with the row (cascade-safe); the
  -- column from the spec is kept for a future move to disk storage.
  storage_path text,
  content text NOT NULL,
  char_count integer NOT NULL CHECK (char_count >= 0),
  language text,
  consent_confirmed_at timestamptz NOT NULL,
  visibility text NOT NULL DEFAULT 'members' CHECK (visibility IN ('members', 'organizers')),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'processing', 'failed')),
  summary text,
  summary_generated_at timestamptz,
  -- A re-upload marks the previous transcript replaced; the job runner purges it after 30 days.
  replaced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS session_transcripts_current_idx
  ON public.session_transcripts (session_id) WHERE replaced_at IS NULL;
CREATE INDEX IF NOT EXISTS session_transcripts_event_idx ON public.session_transcripts (event_id);
CREATE INDEX IF NOT EXISTS session_transcripts_replaced_idx ON public.session_transcripts (replaced_at) WHERE replaced_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.transcript_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id uuid NOT NULL REFERENCES public.session_transcripts(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  text text NOT NULL,
  embedding real[],
  embedding_model text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transcript_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS transcript_chunks_event_idx ON public.transcript_chunks (event_id);

-- ── Reading tiers (RLS) ─────────────────────────────────────────────────────────────────────────
-- Organizers always; members when both the gathering's setting and the transcript's own tier say
-- 'members'. Replaced transcripts are organizer business only. Writes are server-only (no INSERT /
-- UPDATE / DELETE grant): the AppView writes through its service connection after its own checks.
ALTER TABLE public.session_transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcript_chunks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Transcripts readable by tier" ON public.session_transcripts;
CREATE POLICY "Transcripts readable by tier" ON public.session_transcripts
  FOR SELECT TO authenticated
  USING (
    public.event_role(event_id) IN ('owner', 'admin', 'moderator')
    OR (
      replaced_at IS NULL
      AND visibility = 'members'
      AND public.event_role(event_id) IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.events e WHERE e.id = event_id AND e.transcripts_visibility = 'members')
    )
  );

DROP POLICY IF EXISTS "Chunks follow their transcript" ON public.transcript_chunks;
CREATE POLICY "Chunks follow their transcript" ON public.transcript_chunks
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.session_transcripts t WHERE t.id = transcript_id));

GRANT SELECT ON public.session_transcripts TO authenticated;
GRANT SELECT ON public.transcript_chunks TO authenticated;

-- ── Export log and jobs (server-only, per 0009 defaults) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.knowledge_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  exported_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  session_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  bytes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_exports_event_idx ON public.knowledge_exports (event_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.knowledge_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('embed', 'summaries')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  requested_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  run_after timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  processed integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One live job per gathering and kind.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_jobs_live_idx
  ON public.knowledge_jobs (event_id, kind) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS knowledge_jobs_due_idx ON public.knowledge_jobs (run_after) WHERE status IN ('queued', 'running');

-- Belt and braces on top of 0009's default privileges.
REVOKE ALL ON public.knowledge_exports FROM anon, authenticated;
REVOKE ALL ON public.knowledge_jobs FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.session_transcripts FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.transcript_chunks FROM anon, authenticated;
