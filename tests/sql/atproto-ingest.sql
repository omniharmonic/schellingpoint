-- Local-only integration fixture; ROLLBACK removes every write.
-- A proposal ingested from the network (service role, no host account) enters the
-- review queue while proposals are open, is refused when they are closed, and its
-- status changes never try to notify a NULL host.
BEGIN;
DO $$
DECLARE eid uuid; sid uuid; failed boolean := false;
BEGIN
  INSERT INTO public.events(slug,name,start_date,end_date,status,visibility,allowed_formats,allowed_durations,max_proposals_per_user)
    VALUES ('atproto-ingest-'||gen_random_uuid(),'Rollback only','2026-10-16','2026-10-17','proposals_open','public',ARRAY['workshop'],ARRAY[45],5)
    RETURNING id INTO eid;
  INSERT INTO public.sessions(event_id,host_id,host_name,host_did,title,format,duration,imported_from,proposal_uri,proposal_cid)
    VALUES (eid,NULL,NULL,'did:plc:networkauthor','From the network','workshop',45,'atproto','at://did:plc:networkauthor/schellingpoint.draft.proposal/3abc','bafy1')
    RETURNING id INTO sid;
  IF (SELECT status FROM public.sessions WHERE id=sid) <> 'pending' THEN RAISE EXCEPTION 'imported proposal should be pending'; END IF;
  -- Withdrawal on a host-less row must not fail on the host notification.
  UPDATE public.sessions SET status='rejected', rejection_reason='withdrawn on the network' WHERE id=sid;
  IF EXISTS (SELECT 1 FROM public.notifications WHERE (data->>'session_id')::uuid=sid) THEN RAISE EXCEPTION 'no notification expected for a host-less session'; END IF;
  -- Closed window refuses the import.
  UPDATE public.events SET status='voting_open' WHERE id=eid;
  BEGIN
    INSERT INTO public.sessions(event_id,host_id,host_did,title,format,duration,imported_from,proposal_uri)
      VALUES (eid,NULL,'did:plc:networkauthor','Too late','workshop',45,'atproto','at://did:plc:networkauthor/schellingpoint.draft.proposal/3late');
  EXCEPTION WHEN check_violation THEN failed := true; END;
  IF NOT failed THEN RAISE EXCEPTION 'closed proposals should refuse network imports'; END IF;
  RAISE NOTICE 'PASS: network-imported proposals respect the window and never notify a NULL host';
END $$;
ROLLBACK;
