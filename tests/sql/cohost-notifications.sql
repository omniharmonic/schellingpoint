-- Local-only integration fixture; ROLLBACK removes every write.
-- Regression: cohost_invites triggers used to reference a non-existent NEW.email column,
-- so creating or accepting a co-host invite failed at the database boundary.
BEGIN;
DO $$
DECLARE sid uuid; hid uuid; uid2 uuid; iid uuid; n int;
BEGIN
  SELECT id, host_id INTO sid, hid FROM public.sessions WHERE host_id IS NOT NULL LIMIT 1;
  IF sid IS NULL THEN RAISE EXCEPTION 'A seeded session with a host is required'; END IF;
  SELECT id INTO uid2 FROM public.profiles WHERE id <> hid LIMIT 1;
  INSERT INTO public.cohost_invites(session_id, created_by) VALUES (sid, hid) RETURNING id INTO iid;
  IF (SELECT event_id FROM public.cohost_invites WHERE id = iid) IS NULL THEN RAISE EXCEPTION 'event_id was not derived'; END IF;
  UPDATE public.cohost_invites SET status='accepted', accepted_by=uid2, accepted_at=now() WHERE id=iid;
  SELECT count(*) INTO n FROM public.notifications
    WHERE type='cohost_accepted' AND user_id=hid AND (data->>'cohost_id')::uuid = uid2;
  IF n <> 1 THEN RAISE EXCEPTION 'expected 1 cohost_accepted notification, got %', n; END IF;
  RAISE NOTICE 'PASS: co-host invite creation and acceptance fire notifications without error';
END $$;
ROLLBACK;
