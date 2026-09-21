-- Cluster-aware scheduling constraints (release design §9.2).
--
--   sessions.pinned_venue_id  an organizer pins a session to one room ("ZK Workshop MUST be in
--                             Workshop Room A"). Organizer-only, set app-side; never a record field.
--   venues.allowed_formats    the PRD's per-room format restriction ("Workshops", "Discussions").
--                             NULL or empty means every format is welcome.
--
-- Both tables keep their existing privileges (0009: server-only); no grants change here.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS pinned_venue_id uuid REFERENCES public.venues(id) ON DELETE SET NULL;
COMMENT ON COLUMN public.sessions.pinned_venue_id IS
  'Organizer constraint for the scheduler: this session must be placed in this room. App-side only.';
CREATE INDEX IF NOT EXISTS idx_sessions_pinned_venue ON public.sessions (pinned_venue_id) WHERE pinned_venue_id IS NOT NULL;

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS allowed_formats text[];
COMMENT ON COLUMN public.venues.allowed_formats IS
  'Session formats this room may host (talk, workshop, ...). NULL or empty = all formats.';
