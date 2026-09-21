-- Knowledge harvest follow-up (design §10.2): "request transcripts" is throttled per session.
-- The organizer action records when a session's hosts were last asked; a session asked within the
-- last 24 hours is skipped on the next request. Server-only column on a table members can read
-- (no policy change: the timestamp says nothing about anybody).
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS transcripts_requested_at timestamptz;
COMMENT ON COLUMN public.sessions.transcripts_requested_at IS 'When the organizers last asked this session''s hosts for a transcript (24 h throttle).';
