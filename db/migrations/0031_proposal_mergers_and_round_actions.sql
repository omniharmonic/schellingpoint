-- Session mergers (PRD §4.4) and organizer round controls (inventory P2-14, P2-16).
--
--   sessions.merged_into          the source proposal of an accepted merger points at the target.
--                                 App-side only: R9 forbids us editing the proposer's record, so
--                                 the source's `schellingpoint.draft.proposal` stays untouched in
--                                 its author's repo; only this column says "folded into that one".
--                                 Never a record field, never published. The calendar event is
--                                 only ever written for the target.
--   session_merge_requests        the double opt-in: the source's proposer asks, the target's
--                                 proposer accepts or declines. Nobody merges anyone else's work.
--   round_actions                 audit of organizer voting-round controls (open / extend / close).
--                                 It records WHO acted and WHEN, never a count: the ballot-key
--                                 invariants (spec §5.3) are untouched by anything here.
--
-- All three are server-only: migration 0009 revoked default privileges from anon/authenticated
-- and nothing below grants them back. The AppView's service connection is the only reader.

-- ── sessions.merged_into ──────────────────────────────────────────────────────
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS merged_into uuid;
COMMENT ON COLUMN public.sessions.merged_into IS
  'Accepted merger: this proposal was folded into that session. App-side only; the author''s record is never edited.';
CREATE INDEX IF NOT EXISTS idx_sessions_merged_into ON public.sessions (merged_into) WHERE merged_into IS NOT NULL;

-- ON DELETE RESTRICT, deliberately, not SET NULL. SET NULL would quietly un-merge the source
-- when its target went away: the source would be readable again but `is_votable = false`, so
-- every vote cast for it would be dropped at close and nobody would be told. Deleting a merge
-- target is refused instead — the route answers 409 and names the count, and an un-merge goes
-- through `unmergeSession`, which restores `is_votable` in the same statement.
-- Deleting the whole gathering still works: the event cascade removes both rows in one
-- statement, which RESTRICT is checked against only for rows that survive it.
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_merged_into_fkey;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_merged_into_fkey FOREIGN KEY (merged_into)
  REFERENCES public.sessions(id) ON DELETE RESTRICT;

-- A session can never be merged into itself, and a merge target must be in the same gathering
-- (enforced app-side too; this is the floor).
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_merged_into_not_self;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_merged_into_not_self CHECK (merged_into IS NULL OR merged_into <> id);

-- `merged_into` joins the organizer-only column set of the session guard: a signed-in host
-- cannot fold their session into another by a direct UPDATE, only through the merge route.
-- (Redefined from the 0002 body — the vote counters it dropped must stay dropped.)
CREATE OR REPLACE FUNCTION public.enforce_session_update_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_role text;
BEGIN
  IF auth.uid() IS NULL OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION 'Sessions cannot move between events' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO caller_role FROM public.event_members
  WHERE event_id = OLD.event_id AND user_id = auth.uid();
  IF caller_role IN ('owner', 'admin', 'moderator') THEN
    RETURN NEW;
  END IF;

  IF NEW.host_id        IS DISTINCT FROM OLD.host_id
    OR NEW.status         IS DISTINCT FROM OLD.status
    OR NEW.venue_id       IS DISTINCT FROM OLD.venue_id
    OR NEW.time_slot_id   IS DISTINCT FROM OLD.time_slot_id
    OR NEW.is_votable     IS DISTINCT FROM OLD.is_votable
    OR NEW.rsvp_count     IS DISTINCT FROM OLD.rsvp_count
    OR NEW.waitlist_count IS DISTINCT FROM OLD.waitlist_count
    OR NEW.session_type   IS DISTINCT FROM OLD.session_type
    OR NEW.merged_into    IS DISTINCT FROM OLD.merged_into
  THEN
    RAISE EXCEPTION 'Only organizers can change scheduling or status fields' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- ── session_merge_requests ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.session_merge_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  source_session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  target_session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  requested_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  message       text,
  status        text NOT NULL DEFAULT 'pending',
  decided_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  decline_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_merge_requests_status_check
    CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn')),
  CONSTRAINT session_merge_requests_distinct CHECK (source_session_id <> target_session_id)
);
COMMENT ON TABLE public.session_merge_requests IS
  'PRD §4.4 merger, double opt-in: the source proposer asks to fold their session into the target; the target proposer accepts or declines. Server-only.';

-- One live request per source at a time, and never two live requests between the same pair.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_merge_request_pending_source
  ON public.session_merge_requests (source_session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_merge_request_target ON public.session_merge_requests (target_session_id, status);
CREATE INDEX IF NOT EXISTS idx_merge_request_event ON public.session_merge_requests (event_id, created_at DESC);

ALTER TABLE public.session_merge_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.session_merge_requests FROM anon, authenticated;

-- ── round_actions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.round_actions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  round_id   uuid REFERENCES public.vote_rounds(id) ON DELETE SET NULL,
  phase      text NOT NULL,
  action     text NOT NULL,
  actor_id   uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT round_actions_action_check CHECK (action IN ('open', 'extend', 'close')),
  CONSTRAINT round_actions_phase_check CHECK (phase IN ('pre-event', 'attendance'))
);
COMMENT ON TABLE public.round_actions IS
  'Audit of organizer voting-round controls. Who opened, extended or force-closed a round and when. Never a vote count: spec §5.3 holds.';
CREATE INDEX IF NOT EXISTS idx_round_actions_event ON public.round_actions (event_id, created_at DESC);

ALTER TABLE public.round_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.round_actions FROM anon, authenticated;
