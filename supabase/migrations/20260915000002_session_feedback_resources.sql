-- Migration: Post-session feedback (P6.6) and session resources (P6.7)
--
-- session_feedback  - one rating/comment per attendee per session, only
--                     accepted once a scheduled session has started.
-- session_resources - links (slides, recording, notes, repo, ...) curated
--                     by the session host, cohosts, or event organizers.

-- ============================================================================
-- SHARED HELPERS
-- ============================================================================

-- True when the caller is the session host, a cohost, or an event organizer
-- (owner/admin/moderator). SECURITY DEFINER so policies on the new tables do
-- not recurse through the sessions / session_cohosts policies.
CREATE OR REPLACE FUNCTION public.can_manage_session(target_session uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = target_session AND (
      s.host_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.session_cohosts c
        WHERE c.session_id = s.id AND c.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.event_members m
        WHERE m.event_id = s.event_id AND m.user_id = auth.uid()
          AND m.role IN ('owner', 'admin', 'moderator')
      )
    )
  );
$$;
REVOKE ALL ON FUNCTION public.can_manage_session(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_session(uuid) TO anon, authenticated, service_role;

-- When a scheduled session started (time slot, or self-hosted start). NULL if
-- the session is not scheduled or has no start time yet.
CREATE OR REPLACE FUNCTION public.session_started_at(target_session uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN s.status <> 'scheduled' THEN NULL
    WHEN s.is_self_hosted THEN s.self_hosted_start_time
    ELSE ts.start_time
  END
  FROM public.sessions s
  LEFT JOIN public.time_slots ts ON ts.id = s.time_slot_id
  WHERE s.id = target_session;
$$;
REVOKE ALL ON FUNCTION public.session_started_at(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_started_at(uuid) TO anon, authenticated, service_role;

-- Keeps event_id consistent with the parent session on both new tables.
CREATE OR REPLACE FUNCTION public.set_event_id_from_session()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  parent_event uuid;
BEGIN
  SELECT event_id INTO parent_event FROM public.sessions WHERE id = NEW.session_id;
  IF parent_event IS NULL THEN
    RAISE EXCEPTION 'Session % not found', NEW.session_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.event_id := parent_event;
  RETURN NEW;
END;
$$;

-- ============================================================================
-- SESSION FEEDBACK
-- ============================================================================

CREATE TABLE public.session_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR char_length(comment) <= 2000),
  would_attend_again BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (session_id, user_id)
);

CREATE INDEX idx_session_feedback_event ON public.session_feedback(event_id);
CREATE INDEX idx_session_feedback_session ON public.session_feedback(session_id);
CREATE INDEX idx_session_feedback_user ON public.session_feedback(user_id);

-- Feedback is only accepted for scheduled sessions whose start time has
-- passed. Enforced in a trigger (applies to every client, including the
-- service role) rather than in RLS.
CREATE OR REPLACE FUNCTION public.enforce_session_feedback_window()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  started timestamptz;
BEGIN
  started := public.session_started_at(NEW.session_id);
  IF started IS NULL THEN
    RAISE EXCEPTION 'Feedback is only accepted for scheduled sessions'
      USING ERRCODE = 'check_violation';
  END IF;
  IF started > NOW() THEN
    RAISE EXCEPTION 'Feedback opens once the session has started'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trigger_session_feedback_event_id
  BEFORE INSERT ON public.session_feedback
  FOR EACH ROW EXECUTE FUNCTION public.set_event_id_from_session();

CREATE TRIGGER trigger_session_feedback_window
  BEFORE INSERT OR UPDATE ON public.session_feedback
  FOR EACH ROW EXECUTE FUNCTION public.enforce_session_feedback_window();

-- Aggregate summary. Returns NULLs when fewer than 3 responses exist so an
-- individual attendee's rating can not be inferred from the average.
CREATE OR REPLACE FUNCTION public.session_feedback_summary(target_session uuid)
RETURNS TABLE (avg_rating numeric, count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    CASE WHEN COUNT(*) >= 3 THEN ROUND(AVG(f.rating)::numeric, 2) ELSE NULL END AS avg_rating,
    CASE WHEN COUNT(*) >= 3 THEN COUNT(*)::integer ELSE NULL END AS count
  FROM public.session_feedback f
  WHERE f.session_id = target_session;
$$;
REVOKE ALL ON FUNCTION public.session_feedback_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_feedback_summary(uuid) TO anon, authenticated, service_role;

ALTER TABLE public.session_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own feedback"
  ON public.session_feedback
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Hosts and organizers can view session feedback"
  ON public.session_feedback
  FOR SELECT
  USING (public.can_manage_session(session_id));

CREATE POLICY "Users can submit own feedback"
  ON public.session_feedback
  FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND public.can_read_session_event(session_id)
  );

CREATE POLICY "Users can update own feedback"
  ON public.session_feedback
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own feedback"
  ON public.session_feedback
  FOR DELETE
  USING (user_id = auth.uid());

-- ============================================================================
-- SESSION RESOURCES
-- ============================================================================

CREATE TABLE public.session_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  added_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  url TEXT NOT NULL CHECK (url ~* '^https?://' AND char_length(url) <= 2048),
  kind TEXT NOT NULL DEFAULT 'link' CHECK (kind IN ('slides', 'recording', 'notes', 'link', 'repo')),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_session_resources_event ON public.session_resources(event_id);
CREATE INDEX idx_session_resources_session ON public.session_resources(session_id, display_order);

CREATE TRIGGER trigger_session_resources_event_id
  BEFORE INSERT ON public.session_resources
  FOR EACH ROW EXECUTE FUNCTION public.set_event_id_from_session();

ALTER TABLE public.session_resources ENABLE ROW LEVEL SECURITY;

-- Readable by anyone who can read the parent session (delegates to the
-- sessions policies, including the event visibility boundary).
CREATE POLICY "Anyone who can view the session can view resources"
  ON public.session_resources
  FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = session_resources.session_id)
  );

CREATE POLICY "Hosts and organizers can add resources"
  ON public.session_resources
  FOR INSERT
  WITH CHECK (public.can_manage_session(session_id));

CREATE POLICY "Hosts and organizers can update resources"
  ON public.session_resources
  FOR UPDATE
  USING (public.can_manage_session(session_id))
  WITH CHECK (public.can_manage_session(session_id));

CREATE POLICY "Hosts and organizers can delete resources"
  ON public.session_resources
  FOR DELETE
  USING (public.can_manage_session(session_id));
