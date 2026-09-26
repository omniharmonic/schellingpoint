-- Database-boundary rules for the AppView schema (db/migrations). Local-only fixture:
-- everything runs in one transaction and ROLLBACK removes every write.
--
-- Signed-in writes run as `authenticated` with request.jwt.claims, exactly as
-- src/lib/db `asAccount` does, so these are the rules a compromised or buggy route
-- still cannot get past:
--   session guard (hosts edit content; organizers own status, scheduling, counters; event pinned)
--   proposal rules (approval requirement, per-person cap)
--   ticket insert lockout, roster administration, co-host event backfill
--   server-only secrets, ballots and payment references are unreadable to signed-in accounts
--   checkout references are immutable money facts (0029)
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
  -- Migration 0031: a merger is a double opt-in through the merge route, never a direct write.
  BEGIN
    UPDATE public.sessions SET merged_into = sid WHERE id = sid;
    RAISE EXCEPTION 'Host merged a session by a direct update';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Only organizers can change scheduling or status fields' THEN RAISE; END IF;
  WHEN check_violation THEN NULL;  -- the self-merge CHECK may fire first
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
  -- Migration 0037: the gathering's sealed answer-model key is the AppView's alone. Even its
  -- ciphertext must be out of reach of a signed-in account.
  BEGIN
    PERFORM 1 FROM public.event_ai_settings LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read a gathering''s AI settings';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Migration 0031: merge offers and round controls are server-only.
  BEGIN
    PERFORM 1 FROM public.session_merge_requests LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read merge requests';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.round_actions LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read round actions';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Payment references and the webhook ledger are the AppView's alone: a signed-in account
  -- must not be able to read what anyone paid, or to forge a settlement by writing one.
  BEGIN
    PERFORM 1 FROM public.checkout_references LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read checkout references';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.checkout_references
      (session_id, connected_account_id, event_id, tier_id, holder_account_id,
       unit_amount, currency, contribution_percent, application_fee_amount, model)
    VALUES ('cs_forged', 'acct_forged', eid, current_setting('test.tier')::uuid, me, 2500, 'usd', 1, 25, 'direct');
    RAISE EXCEPTION 'A signed-in account inserted a checkout reference';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM 1 FROM public.stripe_events LIMIT 1;
    RAISE EXCEPTION 'A signed-in account could read the Stripe delivery ledger';
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
  col text;
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

  -- Migration 0038: what a member shares about themselves is consent, not administration. The
  -- 0001 admin UPDATE policy is column-agnostic, so a trigger draws the line: an admin may
  -- still set another member's role (asserted above) and may never touch these four columns.
  FOR col IN SELECT unnest(ARRAY['share_email', 'share_contact', 'directory_listing', 'mention_in_posts']) LOOP
    BEGIN
      EXECUTE format(
        'UPDATE public.event_members SET %I = NOT %I WHERE event_id = $1 AND user_id = $2', col, col
      ) USING eid, current_setting('test.host')::uuid;
      RAISE EXCEPTION 'Admin changed another member''s %', col;
    EXCEPTION WHEN insufficient_privilege THEN
      IF SQLERRM <> 'Only the member can change what they share' THEN RAISE; END IF;
    END;
  END LOOP;

  -- The member themselves can, on their own row.
  UPDATE public.event_members SET share_email = true, share_contact = false
   WHERE event_id = eid AND user_id = current_setting('test.admin')::uuid;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'A member could not change what they share about themselves'; END IF;
  SELECT count(*) INTO n FROM public.event_members
   WHERE event_id = eid AND user_id = current_setting('test.admin')::uuid
     AND share_email AND NOT share_contact;
  IF n <> 1 THEN RAISE EXCEPTION 'The member''s own sharing choice was not stored'; END IF;
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

  -- Mergers (0031): a session is never merged into itself, only one live offer per source,
  -- only the four known statuses, and round_actions never grows a column carrying a count.
  BEGIN
    UPDATE public.sessions SET merged_into = sid WHERE id = sid;
    RAISE EXCEPTION 'A session was merged into itself';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  DECLARE
    target_sid uuid;
  BEGIN
    INSERT INTO public.sessions(event_id, host_id, title, format, duration, status)
      VALUES (eid, current_setting('test.owner')::uuid, 'Merge target', 'discussion', 30, 'approved')
      RETURNING id INTO target_sid;
    INSERT INTO public.session_merge_requests(event_id, source_session_id, target_session_id, requested_by)
      VALUES (eid, sid, target_sid, current_setting('test.host')::uuid);
    BEGIN
      INSERT INTO public.session_merge_requests(event_id, source_session_id, target_session_id, requested_by)
        VALUES (eid, sid, target_sid, current_setting('test.host')::uuid);
      RAISE EXCEPTION 'A second pending merge offer was accepted for one source';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.session_merge_requests(event_id, source_session_id, target_session_id, status)
        VALUES (eid, target_sid, sid, 'maybe');
      RAISE EXCEPTION 'An unknown merge status was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    BEGIN
      INSERT INTO public.session_merge_requests(event_id, source_session_id, target_session_id)
        VALUES (eid, target_sid, target_sid);
      RAISE EXCEPTION 'A session was offered a merge into itself';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END;
  -- `merged_into` is ON DELETE RESTRICT, not SET NULL: a target cannot vanish and silently
  -- un-merge its sources. The gathering's own cascade still removes both rows together.
  IF (SELECT confdeltype FROM pg_constraint WHERE conname = 'sessions_merged_into_fkey') <> 'r' THEN
    RAISE EXCEPTION 'sessions.merged_into must be ON DELETE RESTRICT';
  END IF;
  DECLARE
    probe_event uuid; probe_target uuid; probe_source uuid;
  BEGIN
    INSERT INTO public.events(slug, name, start_date, end_date, status, visibility)
      VALUES ('db-rules-merge-' || left(replace(gen_random_uuid()::text, '-', ''), 8), 'Rollback only (merge)',
              '2026-10-16', '2026-10-17', 'proposals_open', 'public')
      RETURNING id INTO probe_event;
    INSERT INTO public.event_members(event_id, user_id, role)
      VALUES (probe_event, current_setting('test.owner')::uuid, 'owner');
    INSERT INTO public.sessions(event_id, host_id, title, format, duration, status)
      VALUES (probe_event, current_setting('test.owner')::uuid, 'Merge probe target', 'discussion', 30, 'approved')
      RETURNING id INTO probe_target;
    INSERT INTO public.sessions(event_id, host_id, title, format, duration, status)
      VALUES (probe_event, current_setting('test.owner')::uuid, 'Merge probe source', 'discussion', 30, 'approved')
      RETURNING id INTO probe_source;
    UPDATE public.sessions SET merged_into = probe_target, is_votable = false WHERE id = probe_source;
    BEGIN
      DELETE FROM public.sessions WHERE id = probe_target;
      RAISE EXCEPTION 'A merge target was deleted out from under its source';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
    -- Deleting the gathering removes both in one statement, which RESTRICT permits.
    DELETE FROM public.events WHERE id = probe_event;
    IF EXISTS (SELECT 1 FROM public.sessions WHERE id IN (probe_source, probe_target)) THEN
      RAISE EXCEPTION 'The gathering cascade left merged sessions behind';
    END IF;
  END;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'round_actions'
             AND column_name IN ('votes', 'voters', 'credits', 'tally', 'ballot_token', 'ballot_key')) THEN
    RAISE EXCEPTION 'round_actions grew a column that could carry a count';
  END IF;
  BEGIN
    INSERT INTO public.round_actions(event_id, phase, action) VALUES (eid, 'pre-event', 'peek');
    RAISE EXCEPTION 'An unknown round action was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  INSERT INTO public.round_actions(event_id, phase, action, actor_id)
    VALUES (eid, 'pre-event', 'close', current_setting('test.owner')::uuid);
  -- Checkout references (0029): the quote a settlement verifies against is write-once, and
  -- refunded totals only ever grow. Even the service connection cannot rewrite them.
  DECLARE
    tid uuid := current_setting('test.tier')::uuid;
  BEGIN
    INSERT INTO public.checkout_references
      (session_id, connected_account_id, event_id, tier_id, holder_account_id,
       unit_amount, currency, contribution_percent, application_fee_amount, model)
    VALUES ('cs_rules_' || eid::text, 'acct_rules', eid, tid, current_setting('test.host')::uuid,
            2500, 'usd', 1, 25, 'direct');
    BEGIN
      UPDATE public.checkout_references SET unit_amount = 1 WHERE session_id = 'cs_rules_' || eid::text;
      RAISE EXCEPTION 'A checkout reference price was rewritten';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE public.checkout_references SET connected_account_id = 'acct_other' WHERE session_id = 'cs_rules_' || eid::text;
      RAISE EXCEPTION 'A checkout reference was moved to another merchant account';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    UPDATE public.checkout_references SET refunded_amount = 500 WHERE session_id = 'cs_rules_' || eid::text;
    BEGIN
      UPDATE public.checkout_references SET refunded_amount = 0 WHERE session_id = 'cs_rules_' || eid::text;
      RAISE EXCEPTION 'A refunded amount was reduced';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
      UPDATE public.checkout_references SET refunded_amount = 9999 WHERE session_id = 'cs_rules_' || eid::text;
      RAISE EXCEPTION 'More was refunded than was ever charged';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    -- The hold may be forgotten by the sweep and filled in once by a delayed settlement, but
    -- a recorded sale must never be pointed at a different, live ticket.
    UPDATE public.checkout_references SET ticket_id = NULL WHERE session_id = 'cs_rules_' || eid::text;
    UPDATE public.checkout_references SET ticket_id = (
      SELECT id FROM public.tickets WHERE event_id = eid LIMIT 1
    ) WHERE session_id = 'cs_rules_' || eid::text AND EXISTS (SELECT 1 FROM public.tickets WHERE event_id = eid);
    IF EXISTS (SELECT 1 FROM public.checkout_references
               WHERE session_id = 'cs_rules_' || eid::text AND ticket_id IS NOT NULL) THEN
      BEGIN
        UPDATE public.checkout_references SET ticket_id = gen_random_uuid()
          WHERE session_id = 'cs_rules_' || eid::text;
        RAISE EXCEPTION 'A recorded sale was pointed at a different ticket';
      EXCEPTION WHEN insufficient_privilege THEN NULL;
        WHEN foreign_key_violation THEN NULL;
      END;
    END IF;

    -- The holder may only be forgotten, never reassigned (the 90-day retention rule).
    UPDATE public.checkout_references SET holder_account_id = NULL WHERE session_id = 'cs_rules_' || eid::text;
    BEGIN
      UPDATE public.checkout_references SET holder_account_id = current_setting('test.owner')::uuid
        WHERE session_id = 'cs_rules_' || eid::text;
      RAISE EXCEPTION 'A checkout reference was reassigned to another holder';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    -- A platform-fallback row has no merchant account, and a Connect row must have one.
    BEGIN
      INSERT INTO public.checkout_references
        (session_id, connected_account_id, event_id, tier_id, unit_amount, currency,
         contribution_percent, application_fee_amount, model)
      VALUES ('cs_rules_bad_' || eid::text, NULL, eid, tid, 2500, 'usd', 1, 0, 'direct');
      RAISE EXCEPTION 'A direct-charge reference was accepted with no merchant account';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END;

  RAISE NOTICE 'PASS: proposal approval/cap/format/self-authorship, session guard, event pinning, ticket lockout, roster administration, server-only secrets and ballots, co-host backfill, attendance voting defaults, checkout reference immutability, merge offers, merge-target deletion, and round actions';
END $$;

-- ---------------------------------------------------------------------------
-- Community, moderation and subject rights (migrations 0033, 0034)
-- ---------------------------------------------------------------------------
--
-- The moderation queue is a case file: reasons, free text and the reporter's identity. Spec §9
-- puts it out of reach of every signed-in role, not merely behind a policy. Calendar feed
-- tokens are credentials. And a paid ticket must survive its holder's deletion with its amount
-- intact, which is a foreign-key rule, not a route's good intentions.
RESET ROLE;
SELECT set_config('request.jwt.claims', NULL, true);

DO $$
DECLARE
  eid uuid := current_setting('test.event')::uuid;
  n integer;
BEGIN
  -- Defaults a new row must have: nothing is hidden, and nobody has accepted anything, until
  -- somebody decides so explicitly.
  IF (SELECT bool_or(hidden_by_moderation) FROM public.sessions WHERE event_id = eid) THEN
    RAISE EXCEPTION 'A session was hidden by moderation without anyone hiding it';
  END IF;
  IF EXISTS (SELECT 1 FROM public.event_members WHERE event_id = eid AND conduct_accepted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'A membership recorded a code-of-conduct acceptance nobody gave';
  END IF;

  -- A report must name the subject its kind promises.
  BEGIN
    INSERT INTO public.moderation_reports (event_id, subject_kind, reason) VALUES (eid, 'session', 'spam');
    RAISE EXCEPTION 'A session report was accepted with no session';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.moderation_reports (event_id, subject_kind, subject_ref, reason) VALUES (eid, 'comment', 'x', 'nonsense');
    RAISE EXCEPTION 'A report was accepted with a reason outside the enum';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- One open case per person per subject: a second click is the same report.
  INSERT INTO public.moderation_reports (event_id, reporter_account_id, subject_kind, subject_ref, reason)
    VALUES (eid, current_setting('test.host')::uuid, 'comment', 'c-1', 'spam');
  BEGIN
    INSERT INTO public.moderation_reports (event_id, reporter_account_id, subject_kind, subject_ref, reason)
      VALUES (eid, current_setting('test.host')::uuid, 'comment', 'c-1', 'harassment');
    RAISE EXCEPTION 'The same person filed two open reports about the same thing';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- A code of conduct is a link, and only ever an http(s) one.
  BEGIN
    UPDATE public.events SET code_of_conduct_url = 'javascript:alert(1)' WHERE id = eid;
    RAISE EXCEPTION 'A non-http code-of-conduct link was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Migration 0040. The merchant-create idempotency key is scoped by this counter, so a failed
  -- create can be retried at once instead of being handed Stripe's cached error for 24 hours.
  -- It counts failures: a gathering that has never tried starts at zero, and it never goes back.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'events' AND column_name = 'stripe_connect_attempts'
     AND is_nullable = 'NO' AND column_default = '0';
  IF n <> 1 THEN RAISE EXCEPTION 'events.stripe_connect_attempts must exist, be NOT NULL and default to 0'; END IF;
  IF (SELECT stripe_connect_attempts FROM public.events WHERE id = eid) <> 0 THEN
    RAISE EXCEPTION 'a new gathering must start with no failed Connect attempts';
  END IF;
  BEGIN
    UPDATE public.events SET stripe_connect_attempts = -1 WHERE id = eid;
    RAISE EXCEPTION 'a negative Connect attempt count was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Money facts keep no holder: deleting the person detaches the ticket, it does not delete it.
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'tickets' AND column_name = 'user_id' AND is_nullable = 'YES';
  IF n <> 1 THEN RAISE EXCEPTION 'tickets.user_id must be nullable so a paid ticket can outlive its holder'; END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND conrelid = 'public.tickets'::regclass AND conname = 'tickets_user_id_fkey' AND confdeltype = 'n';
  IF n <> 1 THEN RAISE EXCEPTION 'tickets.user_id must be ON DELETE SET NULL, not CASCADE'; END IF;

  -- Migration 0035. Nothing that names a person may BLOCK their deletion, and nothing that
  -- belongs to a gathering may be taken away WITH them. NO ACTION does the first; CASCADE on
  -- `at_credentials.created_by` would do the second.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND conrelid = 'public.events'::regclass AND conname = 'events_created_by_fkey' AND confdeltype = 'n';
  IF n <> 1 THEN RAISE EXCEPTION 'events.created_by must be ON DELETE SET NULL: a gathering outlives its founder'; END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND conrelid = 'public.tracks'::regclass AND conname = 'tracks_lead_user_id_fkey' AND confdeltype = 'n';
  IF n <> 1 THEN RAISE EXCEPTION 'tracks.lead_user_id must be ON DELETE SET NULL: a track outlives its lead'; END IF;
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f' AND conrelid = 'public.at_credentials'::regclass AND conname = 'at_credentials_created_by_fkey' AND confdeltype = 'n';
  IF n <> 1 THEN RAISE EXCEPTION 'at_credentials.created_by must be ON DELETE SET NULL: forgetting the organizer must not delete the gathering credential'; END IF;

  -- Nothing else may still BLOCK a deletion: no foreign key into accounts or profiles may be
  -- NO ACTION or RESTRICT, or "delete my account" fails for whoever happens to own such a row.
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid IN ('public.accounts'::regclass, 'public.profiles'::regclass)
     AND confdeltype IN ('a', 'r');
  IF n <> 0 THEN
    RAISE EXCEPTION 'a foreign key into accounts/profiles still blocks account deletion (%)',
      (SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ') FROM pg_constraint
        WHERE contype = 'f' AND confrelid IN ('public.accounts'::regclass, 'public.profiles'::regclass)
          AND confdeltype IN ('a', 'r'));
  END IF;
END $$;

-- Server-only, by privilege and not merely by the absence of a policy (migration 0009's rule).
SELECT set_config('request.jwt.claims', json_build_object('sub', current_setting('test.owner'), 'role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE n integer;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM public.moderation_reports;
    RAISE EXCEPTION 'A signed-in account could read the moderation queue';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.moderation_reports (event_id, subject_kind, subject_ref, reason)
      VALUES (current_setting('test.event')::uuid, 'comment', 'forged', 'spam');
    RAISE EXCEPTION 'A signed-in account could write into the moderation queue';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    SELECT count(*) INTO n FROM public.calendar_feed_tokens;
    RAISE EXCEPTION 'A signed-in account could read calendar feed credentials';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'PASS: moderation reports and calendar feed tokens are server-only; conduct acceptance, hiding and money-keeps-no-holder hold at the database boundary';
END $$;
RESET ROLE;

ROLLBACK;
