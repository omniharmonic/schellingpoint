-- Local-only integration fixture. ROLLBACK removes every write; no roles or
-- events become visible to other connections, and no owner role is granted.
BEGIN;
DO $$
DECLARE
  uid uuid;
  eid uuid;
  sid uuid;
  sid2 uuid;
  vid uuid;
  actual integer;
BEGIN
  SELECT id INTO uid FROM public.profiles WHERE email = 'ux-polish-review@example.test';
  IF uid IS NULL THEN RAISE EXCEPTION 'Local review profile is required'; END IF;
  INSERT INTO public.events(slug,name,start_date,end_date,status,visibility,vote_credits_per_user,voting_mechanism,allowed_formats,allowed_durations,max_proposals_per_user)
    VALUES ('transaction-test-'||gen_random_uuid(),'Rollback only','2026-10-16','2026-10-17','voting_open','private',9,'quadratic',ARRAY['discussion'],ARRAY[30],1) RETURNING id INTO eid;
  INSERT INTO public.event_members(event_id,user_id,role) VALUES(eid,uid,'attendee');
  -- Borrow two existing session rows only inside this transaction. Other
  -- connections continue to see their original event throughout the test.
  SELECT id INTO sid FROM public.sessions ORDER BY id LIMIT 1;
  SELECT id INTO sid2 FROM public.sessions WHERE id <> sid ORDER BY id LIMIT 1;
  IF sid IS NULL OR sid2 IS NULL THEN RAISE EXCEPTION 'Two local seed sessions are required'; END IF;
  UPDATE public.sessions SET event_id=eid, status='approved', is_votable=true WHERE id IN (sid,sid2);
  INSERT INTO public.votes(event_id,user_id,session_id,vote_count,credits_spent) VALUES(eid,uid,sid,3,1) RETURNING id,credits_spent INTO vid,actual;
  IF actual <> 9 THEN RAISE EXCEPTION 'Quadratic cost was trusted from the client'; END IF;
  BEGIN
    INSERT INTO public.votes(event_id,user_id,session_id,vote_count,credits_spent) VALUES(eid,uid,sid2,1,1);
    RAISE EXCEPTION 'Overspending was accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'Not enough voting credits' THEN RAISE; END IF;
  END;
  INSERT INTO public.votes(event_id,user_id,session_id,vote_count,credits_spent)
    VALUES(eid,uid,sid,2,4)
    ON CONFLICT(user_id,session_id) DO UPDATE SET vote_count=excluded.vote_count,credits_spent=excluded.credits_spent;
  SELECT credits_spent INTO actual FROM public.votes WHERE id=vid;
  IF actual <> 4 THEN RAISE EXCEPTION 'Vote reduction did not refund credits'; END IF;
  UPDATE public.events SET voting_mechanism='linear' WHERE id=eid;
  UPDATE public.votes SET vote_count=3 WHERE id=vid;
  SELECT credits_spent INTO actual FROM public.votes WHERE id=vid;
  IF actual <> 3 THEN RAISE EXCEPTION 'Linear cost is incorrect'; END IF;
  UPDATE public.events SET voting_mechanism='approval' WHERE id=eid;
  BEGIN
    UPDATE public.votes SET vote_count=2 WHERE id=vid;
    RAISE EXCEPTION 'Approval voting accepted more than one vote';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'Invalid vote count' THEN RAISE; END IF;
  END;
  UPDATE public.events SET status='completed' WHERE id=eid;
  BEGIN
    DELETE FROM public.votes WHERE id=vid;
    RAISE EXCEPTION 'Closed votes could be withdrawn';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'Voting is not open for this event' THEN RAISE; END IF;
  END;
  UPDATE public.events SET status='proposals_open' WHERE id=eid;
  INSERT INTO public.sessions(event_id,host_id,title,status,format,duration) VALUES(eid,uid,'Participant proposal','scheduled','discussion',30) RETURNING id INTO sid;
  IF (SELECT status FROM public.sessions WHERE id=sid) <> 'pending' THEN RAISE EXCEPTION 'Proposal approval requirement bypassed'; END IF;
  BEGIN
    INSERT INTO public.sessions(event_id,host_id,title,format,duration) VALUES(eid,uid,'Too many','discussion',30);
    RAISE EXCEPTION 'Proposal limit was ignored';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'You have reached this event''s proposal limit' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS: quadratic and linear costs, refunds, credit cap, approval votes, proposal approval and proposal cap';
END $$;
ROLLBACK;
