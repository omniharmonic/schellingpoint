-- =============================================================================
-- 0005_session_participation.sql — work package B (sessions & participation)
-- =============================================================================
-- RSVP capacity and waitlist rules live in the database, not in the browser:
--
--   1. assign_rsvp_status (BEFORE INSERT on session_rsvps) — the row's event comes from
--      its session; RSVPs open only for scheduled sessions; the session row is locked so
--      concurrent RSVPs cannot overbook the venue; the new row is `confirmed` while the
--      venue has room (or has no capacity) and otherwise `waitlist` at the next position.
--      Whatever status/position a caller sends is ignored.
--   2. update_session_rsvp_counts and promote_from_waitlist run as definer, so the
--      counters and waitlist promotion hold no matter which role deletes or cancels an
--      RSVP (they previously depended on the caller's RLS visibility of other rows).
-- =============================================================================

CREATE FUNCTION public.assign_rsvp_status() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  session_event uuid;
  session_status text;
  venue_capacity integer;
  confirmed_count integer;
  next_position integer;
BEGIN
  SELECT s.event_id, s.status, v.capacity
    INTO session_event, session_status, venue_capacity
  FROM public.sessions s
  LEFT JOIN public.venues v ON v.id = s.venue_id
  WHERE s.id = NEW.session_id
  FOR UPDATE OF s;

  IF session_event IS NULL THEN
    RAISE EXCEPTION 'Session % not found', NEW.session_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF session_status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'RSVPs open once a session is scheduled' USING ERRCODE = '23514';
  END IF;

  NEW.event_id := session_event;

  IF venue_capacity IS NULL THEN
    NEW.status := 'confirmed';
    NEW.waitlist_position := NULL;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO confirmed_count
  FROM public.session_rsvps
  WHERE session_id = NEW.session_id AND status = 'confirmed';

  IF confirmed_count < venue_capacity THEN
    NEW.status := 'confirmed';
    NEW.waitlist_position := NULL;
  ELSE
    SELECT coalesce(max(waitlist_position), 0) + 1 INTO next_position
    FROM public.session_rsvps
    WHERE session_id = NEW.session_id AND status = 'waitlist';
    NEW.status := 'waitlist';
    NEW.waitlist_position := next_position;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER assign_rsvp_status
  BEFORE INSERT ON public.session_rsvps
  FOR EACH ROW EXECUTE FUNCTION public.assign_rsvp_status();

REVOKE ALL ON FUNCTION public.assign_rsvp_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_rsvp_status() TO anon, authenticated, service_role;

ALTER FUNCTION public.update_session_rsvp_counts() SECURITY DEFINER;
ALTER FUNCTION public.update_session_rsvp_counts() SET search_path TO 'public';
ALTER FUNCTION public.promote_from_waitlist() SECURITY DEFINER;
ALTER FUNCTION public.promote_from_waitlist() SET search_path TO 'public';

COMMENT ON FUNCTION public.assign_rsvp_status() IS
  'RSVP capacity rule (work package B): event from session, scheduled sessions only, confirmed while the venue has room, else next waitlist position. Locks the session row.';
