CREATE OR REPLACE FUNCTION public.enforce_ticket_entitlement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE eid uuid; uid uuid; action text;
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    eid := NEW.event_id; uid := NEW.host_id; action := 'propose';
    -- Organizer-curated sessions have no attributed author and consume no
    -- participant entitlement. The caller must still be an organizer.
    IF uid IS NULL AND (auth.uid() IS NULL OR EXISTS (
      SELECT 1 FROM event_members WHERE event_id = eid AND user_id = auth.uid()
        AND role IN ('owner', 'admin')
    )) THEN RETURN NEW; END IF;
    -- External proposals remain indexed for organizer review. They are not
    -- automatically accepted into the program by this application.
    IF auth.uid() IS NULL AND NEW.imported_from = 'atproto' THEN RETURN NEW; END IF;
  ELSE
    SELECT event_id INTO eid FROM sessions WHERE id = NEW.session_id;
    uid := NEW.user_id; action := 'attend';
  END IF;
  IF NOT public.has_ticket_entitlement(eid, uid, action) THEN
    RAISE EXCEPTION 'A confirmed ticket with the required participation rights is needed for this gathering'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
