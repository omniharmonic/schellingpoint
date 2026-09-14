-- This narrowly scoped predicate avoids recursive RLS across events/members.
-- It returns only the current caller's access decision, never event data.
CREATE OR REPLACE FUNCTION public.can_read_event(target_event uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.events e WHERE e.id = target_event AND (
      (e.visibility IN ('public', 'unlisted') AND e.status <> 'draft')
      OR EXISTS (
        SELECT 1 FROM public.event_members m
        WHERE m.event_id = e.id AND m.user_id = auth.uid()
          AND (e.status <> 'draft' OR m.role IN ('owner', 'admin'))
      )
    )
  );
$$;
REVOKE ALL ON FUNCTION public.can_read_event(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_event(uuid) TO anon, authenticated, service_role;

-- Restrictive policies AND with all existing permissive policies, including
-- the legacy "approved sessions are public" rule.
DROP POLICY IF EXISTS "Event visibility boundary" ON public.events;
CREATE POLICY "Event visibility boundary" ON public.events AS RESTRICTIVE
  FOR SELECT TO anon, authenticated USING (public.can_read_event(id));
DROP POLICY IF EXISTS "Members can read their event" ON public.events;
CREATE POLICY "Members can read their event" ON public.events
  FOR SELECT TO authenticated USING (public.can_read_event(id));
DROP POLICY IF EXISTS "Session event visibility boundary" ON public.sessions;
CREATE POLICY "Session event visibility boundary" ON public.sessions AS RESTRICTIVE
  FOR SELECT TO anon, authenticated USING (public.can_read_event(event_id));
DROP POLICY IF EXISTS "Venue event visibility boundary" ON public.venues;
CREATE POLICY "Venue event visibility boundary" ON public.venues AS RESTRICTIVE
  FOR SELECT TO anon, authenticated USING (public.can_read_event(event_id));
DROP POLICY IF EXISTS "Time slot event visibility boundary" ON public.time_slots;
CREATE POLICY "Time slot event visibility boundary" ON public.time_slots AS RESTRICTIVE
  FOR SELECT TO anon, authenticated USING (public.can_read_event(event_id));
DROP POLICY IF EXISTS "Track event visibility boundary" ON public.tracks;
CREATE POLICY "Track event visibility boundary" ON public.tracks AS RESTRICTIVE
  FOR SELECT TO anon, authenticated USING (public.can_read_event(event_id));
DROP POLICY IF EXISTS "Roster event visibility boundary" ON public.event_members;
CREATE POLICY "Roster event visibility boundary" ON public.event_members AS RESTRICTIVE
  FOR SELECT TO anon, authenticated USING (public.can_read_event(event_id));
-- A definer predicate prevents cycles with the sessions cohost policy.
CREATE OR REPLACE FUNCTION public.can_read_session_event(target_session uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = target_session AND public.can_read_event(s.event_id));
$$;
REVOKE ALL ON FUNCTION public.can_read_session_event(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_session_event(uuid) TO anon, authenticated, service_role;
DROP POLICY IF EXISTS "Cohost event visibility boundary" ON public.session_cohosts;
CREATE POLICY "Cohost event visibility boundary" ON public.session_cohosts AS RESTRICTIVE
  FOR SELECT TO anon, authenticated USING (public.can_read_session_event(session_id));
