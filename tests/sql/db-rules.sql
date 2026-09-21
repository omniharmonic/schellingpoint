-- Database-boundary rules for the AppView schema (db/migrations). Local-only fixture:
-- everything runs in one transaction and ROLLBACK removes every write.
--
-- Signed-in writes run as `authenticated` with request.jwt.claims, exactly as
-- src/lib/db `asAccount` does, so these are the rules a compromised or buggy route
-- still cannot get past:
--   session guard (hosts edit content; organizers own status, scheduling, counters; event pinned)
--   proposal rules (approval requirement, per-person cap)
--   ticket insert lockout, roster administration, co-host event backfill
--   server-only secrets and ballots are unreadable to signed-in accounts
BEGIN;

DO $$
DECLARE
  host_id uuid; owner_id uuid; admin_id uuid;
  eid uuid; other_eid uuid; sid uuid; vid uuid; tier uuid;
  tag text := replace(gen_random_uuid()::text, '-', '');
BEGIN
  INSERT INTO public.accounts(did, handle, email, kind) VALUES
    ('did:plc:dbruleshost' || tag, 'host' || left(tag, 8) || '.test', 'host+' || tag || '@example.test', 'custodial') RETURNING id INTO host_id;
  INSERT INTO public.accounts(did, handle, email, kind) VALUES
    ('did:plc:dbrulesowner' || tag, 'owner' || left(tag, 8) || '.test', 'owner+' || tag || '@example.test', 'custodial') RETURNING id INTO owner_id;
  INSERT INTO public.accounts(did, handle, email, kind) VALUES
    ('did:plc:dbrulesadmin' || tag, 'admin' || left(tag, 8) || '.test', 'admin+' || tag || '@example.test', 'custodial') RETURNING id INTO admin_id;
  IF (SELECT count(*) FROM public.profiles WHERE id IN (host_id, owner_id, admin_id)) <> 3 THEN
    RAISE EXCEPTION 'Account insert did not create profiles';
  END IF;

  INSERT INTO public.events(slug, name, start_date, end_date, status, visibility, allowed_formats, allowed_durations, max_proposals_per_user, require_proposal_approval)
    VALUES ('db-rules-' || tag, 'Rollback only', '2026-10-16', '2026-10-17', 'proposals_open', 'public', ARRAY['discussion'], ARRAY[30], 2, true)
    RETURNING id INTO eid;
  INSERT INTO public.events(slug, name, start_date, end_date, status, visibility)
    VALUES ('db-rules-other-' || tag, 'Rollback only (other)', '2026-10-16', '2026-10-17', 'published', 'public')
    RETURNING id INTO other_eid;
  INSERT INTO public.event_members(event_id, user_id, role) VALUES
    (eid, owner_id, 'owner'), (eid, admin_id, 'admin'), (eid, host_id, 'attendee');
  INSERT INTO public.venues(event_id, name) VALUES (eid, 'Guard room') RETURNING id INTO vid;
  INSERT INTO public.ticket_tiers(event_id, name) VALUES (eid, 'General') RETURNING id INTO tier;

  PERFORM set_config('test.event', eid::text, true);
  PERFORM set_config('test.other_event', other_eid::text, true);
  PERFORM set_config('test.venue', vid::text, true);
  PERFORM set_config('test.tier', tier::text, true);
  PERFORM set_config('test.host', host_id::text, true);
  PERFORM set_config('test.owner', owner_id::text, true);
  PERFORM set_config('test.admin', admin_id::text, true);
END $$;

-- ---------------------------------------------------------------------------
-- As the proposer (an attendee)
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.host'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  me uuid := current_setting('test.host')::uuid;
  sid uuid;
  n integer;
BEGIN
  IF auth.uid() IS DISTINCT FROM me THEN RAISE EXCEPTION 'auth.uid() did not read the claims'; END IF;

  -- Proposal rules: the requested status is ignored when approval is required.
  INSERT INTO public.sessions(event_id, host_id, title, status, format, duration)
    VALUES (eid, me, 'Proposal one', 'scheduled', 'discussion', 30) RETURNING id INTO sid;
  IF (SELECT status FROM public.sessions WHERE id = sid) <> 'pending' THEN
    RAISE EXCEPTION 'Proposal approval requirement bypassed';
  END IF;
  PERFORM set_config('test.session', sid::text, true);
  BEGIN
    INSERT INTO public.sessions(event_id, host_id, title, format, duration) VALUES (eid, current_setting('test.owner')::uuid, 'As someone else', 'discussion', 30);
    RAISE EXCEPTION 'Proposed a session as another account';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.sessions(event_id, host_id, title, format, duration) VALUES (eid, me, 'Wrong format', 'talk', 30);
    RAISE EXCEPTION 'A disallowed format was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.sessions(event_id, host_id, title, format, duration) VALUES (eid, me, 'Proposal two', 'discussion', 30);
  BEGIN
    INSERT INTO public.sessions(event_id, host_id, title, format, duration) VALUES (eid, me, 'Too many', 'discussion', 30);
    RAISE EXCEPTION 'Proposal limit was ignored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'You have reached this event''s proposal limit' THEN RAISE; END IF;
  END;

  -- Session guard: content edits pass, including a PATCH that echoes unchanged protected fields.
  UPDATE public.sessions SET title = 'Proposal one (edited)', track_id = track_id, status = status WHERE id = sid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Host could not edit own session title'; END IF;
  BEGIN
    UPDATE public.sessions SET status = 'approved' WHERE id = sid;
    RAISE EXCEPTION 'Host approved own session';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Only organizers can change scheduling or status fields' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.sessions SET venue_id = current_setting('test.venue')::uuid WHERE id = sid;
    RAISE EXCEPTION 'Host assigned own session to a venue';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Only organizers can change scheduling or status fields' THEN RAISE; END IF;
  END;
  BEGIN
    UPDATE public.sessions SET rsvp_count = 999 WHERE id = sid;
    RAISE EXCEPTION 'Host inflated a counter';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Tickets are server-written only.
  BEGIN
    INSERT INTO public.tickets(event_id, tier_id, user_id) VALUES (eid, current_setting('test.tier')::uuid, me);
    RAISE EXCEPTION 'Authenticated account inserted a ticket directly';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Attendees cannot administer the roster (RLS filters the rows out).
  UPDATE public.event_members SET role = 'admin' WHERE event_id = eid AND user_id = me;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Attendee promoted themselves'; END IF;
  DELETE FROM public.event_members WHERE event_id = eid AND user_id = current_setting('test.admin')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Attendee removed an admin'; END IF;

  -- Server-only data stays server-only.
  BEGIN
    PERFORM wrapped_password FROM public.accounts LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read wrapped passwords';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.credit_ledger LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read the credit ledger';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.vote_rounds LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read vote rounds (and ballot keys)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.at_credentials LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read gathering credentials';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- As the owner: scheduling allowed, moving between events never
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  sid uuid := current_setting('test.session')::uuid;
  n integer;
BEGIN
  UPDATE public.sessions SET status = 'approved' WHERE id = sid;
  UPDATE public.sessions SET status = 'scheduled', venue_id = current_setting('test.venue')::uuid WHERE id = sid;
  IF (SELECT status FROM public.sessions WHERE id = sid) <> 'scheduled' THEN RAISE EXCEPTION 'Owner could not schedule'; END IF;
  BEGIN
    UPDATE public.sessions SET event_id = current_setting('test.other_event')::uuid WHERE id = sid;
    RAISE EXCEPTION 'Owner moved a session between events';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Sessions cannot move between events' THEN RAISE; END IF;
  END;
  UPDATE public.event_members SET role = 'moderator' WHERE event_id = eid AND user_id = current_setting('test.host')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Owner could not change a member role'; END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- As an admin: manages members, never owner rows or the owner role
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.admin'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  n integer;
BEGIN
  UPDATE public.event_members SET role = 'volunteer' WHERE event_id = eid AND user_id = current_setting('test.host')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'Admin could not change a member role'; END IF;
  UPDATE public.event_members SET role = 'attendee' WHERE event_id = eid AND user_id = current_setting('test.owner')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Admin demoted the owner'; END IF;
  BEGIN
    UPDATE public.event_members SET role = 'owner' WHERE event_id = eid AND user_id = current_setting('test.host')::uuid;
    RAISE EXCEPTION 'Admin granted the owner role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM public.event_members WHERE event_id = eid AND user_id = current_setting('test.owner')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'Admin removed the owner'; END IF;
END $$;
RESET ROLE;

-- ---------------------------------------------------------------------------
-- Service connection (no claims): co-host rows take the session's event
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  sid uuid := current_setting('test.session')::uuid;
  got uuid;
BEGIN
  IF auth.uid() IS NOT NULL THEN RAISE EXCEPTION 'auth.uid() leaked a previous account'; END IF;
  INSERT INTO public.session_cohosts(session_id, user_id) VALUES (sid, current_setting('test.admin')::uuid);
  SELECT event_id INTO got FROM public.session_cohosts WHERE session_id = sid AND user_id = current_setting('test.admin')::uuid;
  IF got IS DISTINCT FROM eid THEN RAISE EXCEPTION 'Co-host event_id was not backfilled (got %)', got; END IF;
  BEGIN
    INSERT INTO public.session_cohosts(session_id, user_id, event_id) VALUES (sid, current_setting('test.owner')::uuid, current_setting('test.other_event')::uuid);
    RAISE EXCEPTION 'Co-host row accepted a foreign event_id';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Attendance voting (migration 0026): off by default, a positive fresh budget, and the
  -- attendance round shares the pre-event round's tables and key lifecycle.
  IF (SELECT attendance_voting_enabled FROM public.events WHERE id = eid) THEN
    RAISE EXCEPTION 'events.attendance_voting_enabled must default to false';
  END IF;
  IF (SELECT attendance_credits FROM public.events WHERE id = eid) <> 100 THEN
    RAISE EXCEPTION 'events.attendance_credits must default to 100';
  END IF;
  BEGIN
    UPDATE public.events SET attendance_credits = 0 WHERE id = eid;
    RAISE EXCEPTION 'events.attendance_credits accepted 0';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.vote_rounds(event_id, phase, mechanism, credits, opens_at, closes_at)
    VALUES (eid, 'attendance', 'quadratic', 100, now(), now() + interval '1 day');
  BEGIN
    INSERT INTO public.vote_rounds(event_id, phase, mechanism, credits, opens_at, closes_at)
      VALUES (eid, 'attendance', 'quadratic', 100, now(), now() + interval '1 day');
    RAISE EXCEPTION 'A second open attendance round was accepted for one event';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- A pre-event round may still be open alongside it: the index is per (event, phase).
  INSERT INTO public.vote_rounds(event_id, phase, mechanism, credits, opens_at, closes_at)
    VALUES (eid, 'pre-event', 'quadratic', 100, now(), now() + interval '1 day');
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('vote_entries', 'vote_ballots')
             AND column_name IN ('account_id', 'user_id', 'did', 'voter_id')) THEN
    RAISE EXCEPTION 'ballot tables grew an identifying column';
  END IF;
  RAISE NOTICE 'PASS: proposal approval/cap/format/self-authorship, session guard, event pinning, ticket lockout, roster administration, server-only secrets and ballots, co-host backfill, attendance voting defaults';
END $$;

ROLLBACK;
