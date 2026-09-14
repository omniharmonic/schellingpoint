-- Local-only checks use existing fixture roles and roll back every mutation.
BEGIN;
SELECT set_config('test.event', id::text, true) FROM public.events WHERE slug='ethboulder-2026';
SELECT set_config('test.organizer', user_id::text, true) FROM public.event_members WHERE event_id=current_setting('test.event')::uuid AND role='owner' LIMIT 1;
UPDATE public.events SET visibility='private', status='draft' WHERE id=current_setting('test.event')::uuid;
SET LOCAL ROLE anon;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.events WHERE id=current_setting('test.event')::uuid) THEN RAISE EXCEPTION 'Anonymous event disclosure'; END IF;
  IF EXISTS (SELECT 1 FROM public.sessions WHERE event_id=current_setting('test.event')::uuid) THEN RAISE EXCEPTION 'Anonymous session disclosure'; END IF;
  IF EXISTS (SELECT 1 FROM public.venues WHERE event_id=current_setting('test.event')::uuid) THEN RAISE EXCEPTION 'Anonymous venue disclosure'; END IF;
  PERFORM * FROM public.session_cohosts LIMIT 1; -- Must not cause an RLS recursion.
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claim.sub', current_setting('test.organizer'), true);
SET LOCAL ROLE authenticated;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.events WHERE id=current_setting('test.event')::uuid) THEN RAISE EXCEPTION 'Organizer cannot read draft'; END IF;
  INSERT INTO public.sessions(event_id,title,host_name,host_id,format,duration,status,session_type)
    VALUES(current_setting('test.event')::uuid,'Curated external host regression','External speaker',NULL,'talk',30,'approved','curated');
  RAISE NOTICE 'PASS: private event/session/room isolation and organizer creation with external host in draft';
END $$;
RESET ROLE;
ROLLBACK;
