-- A ticketed gathering requires a confirmed entitlement, even for free tiers or
-- before tiers have been configured. Membership alone is not proof of admission.
CREATE FUNCTION public.has_ticket_entitlement(gathering_id uuid, account_id uuid, action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM events e WHERE e.id = gathering_id AND (
      NOT e.ticketing_enabled
      OR EXISTS (SELECT 1 FROM event_members m WHERE m.event_id = e.id
        AND m.user_id = account_id AND m.role IN ('owner', 'admin', 'moderator'))
      OR EXISTS (SELECT 1 FROM tickets t JOIN ticket_tiers tt ON tt.id = t.tier_id AND tt.event_id = e.id
        WHERE t.event_id = e.id AND t.user_id = account_id AND t.status IN ('confirmed', 'checked_in')
        AND (action <> 'propose' OR tt.allows_proposals))
    )
  );
$$;
REVOKE ALL ON FUNCTION public.has_ticket_entitlement(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_ticket_entitlement(uuid, uuid, text) TO authenticated, service_role;

CREATE FUNCTION public.enforce_ticket_entitlement() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE eid uuid; uid uuid; action text;
BEGIN
  IF TG_TABLE_NAME = 'sessions' THEN
    eid := NEW.event_id; uid := NEW.host_id; action := 'propose';
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
REVOKE ALL ON FUNCTION public.enforce_ticket_entitlement() FROM PUBLIC;
CREATE TRIGGER enforce_ticket_entitlement BEFORE INSERT ON public.sessions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ticket_entitlement();
CREATE TRIGGER enforce_ticket_entitlement BEFORE INSERT ON public.session_rsvps
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ticket_entitlement();
