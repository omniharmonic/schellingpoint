-- Local-only integration fixture. ROLLBACK removes every write; the seeded
-- review profile and two other seeded profiles are borrowed as host, owner
-- and admin of a throwaway event. Roles are impersonated the way PostgREST
-- does it: request.jwt.claims plus SET LOCAL ROLE authenticated.
BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures (as the migration owner, no JWT)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  host_id uuid;
  owner_id uuid;
  admin_id uuid;
  eid uuid;
  sid uuid;
  vid uuid;
  tier uuid;
  url text;
BEGIN
  SELECT id INTO host_id FROM public.profiles WHERE email = 'ux-polish-review@example.test';
  IF host_id IS NULL THEN RAISE EXCEPTION 'Local review profile is required'; END IF;
  SELECT id INTO owner_id FROM public.profiles WHERE id <> host_id ORDER BY id LIMIT 1;
  SELECT id INTO admin_id FROM public.profiles WHERE id NOT IN (host_id, owner_id) ORDER BY id LIMIT 1;
  IF owner_id IS NULL OR admin_id IS NULL THEN RAISE EXCEPTION 'Three local seed profiles are required'; END IF;

  INSERT INTO public.events(slug,name,start_date,end_date,status,visibility,allowed_formats,allowed_durations,max_proposals_per_user)
    VALUES ('harden-writes-'||gen_random_uuid(),'Rollback only','2026-10-16','2026-10-17','proposals_open','public',ARRAY['discussion'],ARRAY[30],5)
    RETURNING id INTO eid;
  INSERT INTO public.event_members(event_id,user_id,role) VALUES
    (eid,owner_id,'owner'), (eid,admin_id,'admin'), (eid,host_id,'attendee');
  INSERT INTO public.venues(event_id,name) VALUES (eid,'Guard room') RETURNING id INTO vid;
  INSERT INTO public.ticket_tiers(event_id,name) VALUES (eid,'General') RETURNING id INTO tier;
  INSERT INTO public.sessions(event_id,host_id,host_name,title,format,duration)
    VALUES (eid,host_id,'Host','Host proposal','discussion',30) RETURNING id INTO sid;

  -- (4) New proposals send organizers to the admin page that exists.
  SELECT action_url INTO url FROM public.notifications
    WHERE type='new_proposal' AND user_id=owner_id AND (data->>'session_id')::uuid=sid;
  IF url IS NULL OR url !~ '/admin$' OR url ~ '/admin/proposals' THEN
    RAISE EXCEPTION 'New proposal action_url was %', url;
  END IF;

  PERFORM set_config('test.event', eid::text, true);
  PERFORM set_config('test.session', sid::text, true);
  PERFORM set_config('test.venue', vid::text, true);
  PERFORM set_config('test.tier', tier::text, true);
  PERFORM set_config('test.host', host_id::text, true);
  PERFORM set_config('test.owner', owner_id::text, true);
  PERFORM set_config('test.admin', admin_id::text, true);
END $$;

-- ---------------------------------------------------------------------------
-- As the host (an attendee who owns one proposal)
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.host'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  sid uuid := current_setting('test.session')::uuid;
  me uuid := current_setting('test.host')::uuid;
  n integer;
BEGIN
  -- (a) Content edits succeed, including a PATCH that echoes unchanged protected fields.
  UPDATE public.sessions SET title='Host proposal (edited)', description='More detail', track_id=track_id, status=status WHERE id=sid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Host could not edit own session title'; END IF;

  -- (a2) The host adds a co-host under their own JWT (policy recursion regression).
  INSERT INTO public.session_cohosts(session_id,user_id) VALUES (sid,current_setting('test.owner')::uuid);
  IF NOT EXISTS (SELECT 1 FROM public.session_cohosts WHERE session_id=sid AND user_id=current_setting('test.owner')::uuid AND event_id=eid) THEN
    RAISE EXCEPTION 'Host could not add a co-host';
  END IF;
  DELETE FROM public.session_cohosts WHERE session_id=sid AND user_id=current_setting('test.owner')::uuid;

  -- (b) Scheduling and status fields are organizer-only.
  BEGIN
    UPDATE public.sessions SET status='scheduled' WHERE id=sid;
    RAISE EXCEPTION 'Host promoted own session to scheduled';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Only organizers can change scheduling or status fields' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.sessions SET venue_id=current_setting('test.venue')::uuid WHERE id=sid;
    RAISE EXCEPTION 'Host assigned own session to a venue';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Only organizers can change scheduling or status fields' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.sessions SET total_votes=999 WHERE id=sid;
    RAISE EXCEPTION 'Host inflated own vote total';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Only organizers can change scheduling or status fields' THEN RAISE; END IF;
  END;

  -- Counter maintenance performed by other triggers is still allowed under a JWT.
  INSERT INTO public.session_rsvps(event_id,session_id,user_id) VALUES (eid,sid,me);
  IF (SELECT rsvp_count FROM public.sessions WHERE id=sid) <> 1 THEN
    RAISE EXCEPTION 'RSVP counter trigger was blocked by the session guard';
  END IF;

  -- (c) Tickets cannot be inserted with a user JWT.
  BEGIN
    INSERT INTO public.tickets(event_id,tier_id,user_id) VALUES (eid,current_setting('test.tier')::uuid,me);
    RAISE EXCEPTION 'Authenticated user inserted a ticket directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- (e) Attendees cannot administer the roster.
  UPDATE public.event_members SET role='admin' WHERE event_id=eid AND user_id=me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Attendee promoted themselves'; END IF;
  UPDATE public.event_members SET role='attendee' WHERE event_id=eid AND user_id=current_setting('test.owner')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Attendee demoted the owner'; END IF;
  DELETE FROM public.event_members WHERE event_id=eid AND user_id=current_setting('test.admin')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Attendee removed an admin'; END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- As the event owner
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  sid uuid := current_setting('test.session')::uuid;
  n integer;
BEGIN
  UPDATE public.sessions SET status='approved' WHERE id=sid;
  UPDATE public.sessions SET status='scheduled', venue_id=current_setting('test.venue')::uuid WHERE id=sid;
  IF (SELECT status FROM public.sessions WHERE id=sid) <> 'scheduled' THEN RAISE EXCEPTION 'Owner could not schedule'; END IF;
  BEGIN
    UPDATE public.sessions SET event_id=(SELECT id FROM public.events WHERE slug='ethboulder-2026') WHERE id=sid;
    RAISE EXCEPTION 'Owner moved a session between events';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Sessions cannot move between events' THEN RAISE; END IF;
  END;
  UPDATE public.event_members SET role='moderator' WHERE event_id=eid AND user_id=current_setting('test.host')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Owner could not change a member role'; END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- As an admin: may manage members, but never owner rows or the owner role
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.admin'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  n integer;
BEGIN
  UPDATE public.event_members SET role='volunteer' WHERE event_id=eid AND user_id=current_setting('test.host')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Admin could not change a member role'; END IF;
  UPDATE public.event_members SET role='attendee' WHERE event_id=eid AND user_id=current_setting('test.owner')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Admin demoted the owner'; END IF;
  BEGIN
    UPDATE public.event_members SET role='owner' WHERE event_id=eid AND user_id=current_setting('test.host')::uuid;
    RAISE EXCEPTION 'Admin granted the owner role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM public.event_members WHERE event_id=eid AND user_id=current_setting('test.owner')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Admin removed the owner'; END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Service-role path (no JWT): rejection reason reaches the notification
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  host_id uuid := current_setting('test.host')::uuid;
  sid uuid;
  got uuid;
  note record;
BEGIN
  INSERT INTO public.sessions(event_id,host_id,host_name,title,format,duration)
    VALUES (eid,host_id,'Host','Second proposal','discussion',30) RETURNING id INTO sid;
  UPDATE public.sessions SET status='rejected', rejection_reason='Overlaps the keynote' WHERE id=sid;
  SELECT body, data INTO note FROM public.notifications
    WHERE type='session_rejected' AND user_id=host_id AND (data->>'session_id')::uuid=sid;
  IF note.body IS NULL OR note.body NOT LIKE '% Reason: Overlaps the keynote' THEN
    RAISE EXCEPTION 'Rejection body was %', note.body;
  END IF;
  IF note.data->>'rejection_reason' IS DISTINCT FROM 'Overlaps the keynote' THEN
    RAISE EXCEPTION 'Rejection data was %', note.data;
  END IF;
  -- (d) Cohost rows pick up event_id from the session (the invite-accept
  -- route inserts these through the service role).
  INSERT INTO public.session_cohosts(session_id,user_id) VALUES (sid,current_setting('test.admin')::uuid);
  SELECT event_id INTO got FROM public.session_cohosts WHERE session_id=sid AND user_id=current_setting('test.admin')::uuid;
  IF got IS DISTINCT FROM eid THEN RAISE EXCEPTION 'Cohost event_id was not backfilled (got %)', got; END IF;
  BEGIN
    INSERT INTO public.session_cohosts(session_id,user_id,event_id) VALUES (sid,current_setting('test.owner')::uuid,gen_random_uuid());
    RAISE EXCEPTION 'Cohost row accepted a foreign event_id';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'Cohost event must match the session event' THEN RAISE; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.notifications WHERE action_url LIKE '%/admin/proposals') THEN
    RAISE EXCEPTION 'Stale /admin/proposals action_url rows remain';
  END IF;
  RAISE NOTICE 'PASS: host content edits, host cohost insert, organizer-only scheduling, event pinning, ticket insert lockout, cohost event backfill, roster administration, rejection reason';
END $$;
ROLLBACK;
