-- session_cohosts INSERT (host adds a cohost) evaluated a sessions SELECT policy that in
-- turn read session_cohosts, which Postgres reports as infinite policy recursion. Route
-- both lookups through SECURITY DEFINER predicates that answer only the caller's own
-- question, and replace the pre-multi-tenant profiles.is_admin grant with event roles.
CREATE OR REPLACE FUNCTION public.is_session_host(target_session uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = target_session AND s.host_id = auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.is_session_cohost(target_session uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.session_cohosts c WHERE c.session_id = target_session AND c.user_id = auth.uid());
$$;
CREATE OR REPLACE FUNCTION public.is_session_organizer(target_session uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sessions s JOIN public.event_members m ON m.event_id = s.event_id
    WHERE s.id = target_session AND m.user_id = auth.uid() AND m.role IN ('owner','admin','moderator')
  );
$$;
REVOKE ALL ON FUNCTION public.is_session_host(uuid), public.is_session_cohost(uuid), public.is_session_organizer(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_session_host(uuid), public.is_session_cohost(uuid), public.is_session_organizer(uuid) TO anon, authenticated, service_role;

DROP POLICY IF EXISTS "Cohosts can view their pending sessions" ON public.sessions;
CREATE POLICY "Cohosts can view their pending sessions" ON public.sessions
  FOR SELECT USING (status = 'pending' AND public.is_session_cohost(id));

DROP POLICY IF EXISTS "Primary host can add cohosts" ON public.session_cohosts;
CREATE POLICY "Primary host can add cohosts" ON public.session_cohosts
  FOR INSERT WITH CHECK (public.is_session_host(session_id));
DROP POLICY IF EXISTS "Primary host can remove cohosts" ON public.session_cohosts;
CREATE POLICY "Primary host can remove cohosts" ON public.session_cohosts
  FOR DELETE USING (public.is_session_host(session_id));
DROP POLICY IF EXISTS "Admins can manage session cohosts" ON public.session_cohosts;
CREATE POLICY "Organizers can manage session cohosts" ON public.session_cohosts
  FOR ALL USING (public.is_session_organizer(session_id)) WITH CHECK (public.is_session_organizer(session_id));
