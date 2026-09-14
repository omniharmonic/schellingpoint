-- Write-path hardening at the database boundary. Every statement is idempotent
-- so the migration can be re-applied safely.

-- ============================================================================
-- 1. TICKETS: only the service role (checkout + Stripe webhook) inserts tickets.
-- ============================================================================
DROP POLICY IF EXISTS "Users can create own tickets" ON public.tickets;

-- ============================================================================
-- 7a. Caller's role in an event, evaluated as definer so RLS policies on
--     event_members can consult the roster without recursing into themselves.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.event_role(target_event uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.role FROM public.event_members m
  WHERE m.event_id = target_event AND m.user_id = auth.uid()
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.event_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_role(uuid) TO anon, authenticated, service_role;

-- ============================================================================
-- 2. SESSION UPDATE GUARD: hosts edit content; only organizers touch
--    scheduling, status, ownership and counters. Applies to JWT-bearing REST
--    calls; the service role (auth.uid() IS NULL) and counter maintenance
--    performed by other triggers (vote totals, RSVP counts) are trusted.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enforce_session_update_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  caller_role text;
BEGIN
  IF auth.uid() IS NULL OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION 'Sessions cannot move between events' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO caller_role FROM public.event_members
  WHERE event_id = OLD.event_id AND user_id = auth.uid();
  IF caller_role IN ('owner', 'admin', 'moderator') THEN
    RETURN NEW;
  END IF;

  IF NEW.host_id        IS DISTINCT FROM OLD.host_id
    OR NEW.status         IS DISTINCT FROM OLD.status
    OR NEW.venue_id       IS DISTINCT FROM OLD.venue_id
    OR NEW.time_slot_id   IS DISTINCT FROM OLD.time_slot_id
    OR NEW.is_votable     IS DISTINCT FROM OLD.is_votable
    OR NEW.total_votes    IS DISTINCT FROM OLD.total_votes
    OR NEW.total_credits  IS DISTINCT FROM OLD.total_credits
    OR NEW.voter_count    IS DISTINCT FROM OLD.voter_count
    OR NEW.rsvp_count     IS DISTINCT FROM OLD.rsvp_count
    OR NEW.waitlist_count IS DISTINCT FROM OLD.waitlist_count
    OR NEW.session_type   IS DISTINCT FROM OLD.session_type
  THEN
    RAISE EXCEPTION 'Only organizers can change scheduling or status fields' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_session_update_rules() FROM PUBLIC;
DROP TRIGGER IF EXISTS enforce_session_update_rules ON public.sessions;
CREATE TRIGGER enforce_session_update_rules BEFORE UPDATE ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.enforce_session_update_rules();

-- ============================================================================
-- 3. COHOST event_id BACKFILL: derive event_id from the session so clients
--    never have to supply it, and can never supply a mismatching one.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.fill_cohost_event_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  session_event uuid;
BEGIN
  SELECT event_id INTO session_event FROM public.sessions WHERE id = NEW.session_id;
  IF NEW.event_id IS NULL THEN
    NEW.event_id := session_event;
  ELSIF NEW.event_id IS DISTINCT FROM session_event THEN
    RAISE EXCEPTION 'Cohost event must match the session event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.fill_cohost_event_id() FROM PUBLIC;
DROP TRIGGER IF EXISTS fill_cohost_event_id ON public.session_cohosts;
CREATE TRIGGER fill_cohost_event_id BEFORE INSERT ON public.session_cohosts
FOR EACH ROW EXECUTE FUNCTION public.fill_cohost_event_id();
DROP TRIGGER IF EXISTS fill_cohost_event_id ON public.cohost_invites;
CREATE TRIGGER fill_cohost_event_id BEFORE INSERT ON public.cohost_invites
FOR EACH ROW EXECUTE FUNCTION public.fill_cohost_event_id();

UPDATE public.session_cohosts c SET event_id = s.event_id
FROM public.sessions s WHERE s.id = c.session_id AND c.event_id IS NULL;
UPDATE public.cohost_invites i SET event_id = s.event_id
FROM public.sessions s WHERE s.id = i.session_id AND i.event_id IS NULL;

-- ============================================================================
-- 4. NOTIFICATION URL FIX: /admin/proposals does not exist; point at /admin.
--    Body copied from 20260220185808_notification_triggers.sql; only the
--    action URL changes.
-- ============================================================================
CREATE OR REPLACE FUNCTION notify_new_proposal()
RETURNS TRIGGER AS $$
DECLARE
  v_admin RECORD;
  v_event_slug TEXT;
  v_action_url TEXT;
BEGIN
  -- Only for new proposals (status = pending)
  IF NEW.status != 'pending' THEN
    RETURN NEW;
  END IF;

  -- Get event slug
  SELECT slug INTO v_event_slug FROM events WHERE id = NEW.event_id;
  v_action_url := '/e/' || v_event_slug || '/admin';

  -- Notify all admins and owners of this event
  FOR v_admin IN
    SELECT user_id FROM event_members
    WHERE event_id = NEW.event_id
      AND role IN ('owner', 'admin')
      AND user_id != NEW.host_id  -- Don't notify the proposer if they're an admin
  LOOP
    INSERT INTO notifications (user_id, event_id, type, title, body, action_url, data)
    VALUES (
      v_admin.user_id,
      NEW.event_id,
      'new_proposal',
      'New session proposal',
      format('"%s" by %s needs review.', NEW.title, COALESCE(NEW.host_name, 'Unknown')),
      v_action_url,
      jsonb_build_object('session_id', NEW.id, 'session_title', NEW.title, 'host_name', NEW.host_name)
    );
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

UPDATE public.notifications
SET action_url = regexp_replace(action_url, '/admin/proposals$', '/admin')
WHERE action_url LIKE '%/admin/proposals';

-- ============================================================================
-- 5. REJECTION REASON: stored on the session and surfaced in the rejection
--    notification. Body copied from 20260220185808_notification_triggers.sql;
--    only the session_rejected branch and its payload change.
-- ============================================================================
ALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS rejection_reason text;

CREATE OR REPLACE FUNCTION notify_session_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_notification_type VARCHAR(50);
  v_title TEXT;
  v_body TEXT;
  v_action_url TEXT;
  v_data JSONB;
  v_cohost RECORD;
BEGIN
  -- Only fire on status change
  IF OLD.status = NEW.status THEN
    -- Check for reschedule (time_slot_id or venue_id changed while scheduled)
    IF NEW.status = 'scheduled' AND (
      OLD.time_slot_id IS DISTINCT FROM NEW.time_slot_id OR
      OLD.venue_id IS DISTINCT FROM NEW.venue_id
    ) THEN
      v_notification_type := 'session_rescheduled';
      v_title := 'Your session has been rescheduled';
      v_body := format('"%s" has been moved to a new time or venue.', NEW.title);
    ELSE
      RETURN NEW; -- No relevant change
    END IF;
  ELSE
    -- Status changed
    CASE
      WHEN OLD.status = 'pending' AND NEW.status = 'approved' THEN
        v_notification_type := 'session_approved';
        v_title := 'Your session has been approved!';
        v_body := format('"%s" has been approved and is now visible to attendees.', NEW.title);

      WHEN OLD.status = 'pending' AND NEW.status = 'rejected' THEN
        v_notification_type := 'session_rejected';
        v_title := 'Session not approved';
        v_body := format('"%s" was not selected for this event.', NEW.title);
        IF NEW.rejection_reason IS NOT NULL THEN
          v_body := v_body || ' Reason: ' || NEW.rejection_reason;
        END IF;

      WHEN NEW.status = 'scheduled' AND OLD.status != 'scheduled' THEN
        v_notification_type := 'session_scheduled';
        v_title := 'Your session has been scheduled!';
        v_body := format('"%s" has been added to the official schedule.', NEW.title);

      ELSE
        RETURN NEW; -- Other status changes don't generate notifications
    END CASE;
  END IF;

  -- Build action URL
  v_action_url := '/e/' || (
    SELECT slug FROM events WHERE id = NEW.event_id
  ) || '/sessions/' || NEW.id;

  v_data := jsonb_build_object('session_id', NEW.id, 'session_title', NEW.title);
  IF v_notification_type = 'session_rejected' THEN
    v_data := v_data || jsonb_build_object('rejection_reason', NEW.rejection_reason);
  END IF;

  -- Create notification for host
  INSERT INTO notifications (user_id, event_id, type, title, body, action_url, data)
  VALUES (
    NEW.host_id,
    NEW.event_id,
    v_notification_type,
    v_title,
    v_body,
    v_action_url,
    v_data
  );

  -- Create notifications for co-hosts (except for rejection)
  IF v_notification_type != 'session_rejected' THEN
    FOR v_cohost IN
      SELECT user_id FROM session_cohosts WHERE session_id = NEW.id
    LOOP
      INSERT INTO notifications (user_id, event_id, type, title, body, action_url, data)
      VALUES (
        v_cohost.user_id,
        NEW.event_id,
        v_notification_type,
        v_title,
        v_body,
        v_action_url,
        jsonb_build_object('session_id', NEW.id, 'session_title', NEW.title, 'is_cohost', true)
      );
    END LOOP;
  END IF;

  -- Notify admins of new proposals (when session is first created as pending)
  -- This is handled separately in the INSERT trigger below

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================================================
-- 6. INVITATION USE LIMITS (enforced by the API layer).
-- ============================================================================
ALTER TABLE public.event_invitations
  ADD COLUMN IF NOT EXISTS max_uses integer CHECK (max_uses IS NULL OR max_uses > 0);
ALTER TABLE public.event_invitations
  ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;

-- ============================================================================
-- 7b. EVENT MEMBER ADMINISTRATION: owners and admins manage their roster.
--     Owner rows are reserved for owners, both as target and as new value.
-- ============================================================================
DROP POLICY IF EXISTS "Event admins can update members" ON public.event_members;
CREATE POLICY "Event admins can update members" ON public.event_members
  FOR UPDATE TO authenticated
  USING (
    public.event_role(event_id) IN ('owner', 'admin')
    AND (role <> 'owner' OR public.event_role(event_id) = 'owner')
  )
  WITH CHECK (
    public.event_role(event_id) IN ('owner', 'admin')
    AND (role <> 'owner' OR public.event_role(event_id) = 'owner')
  );

DROP POLICY IF EXISTS "Event admins can delete members" ON public.event_members;
CREATE POLICY "Event admins can delete members" ON public.event_members
  FOR DELETE TO authenticated
  USING (
    public.event_role(event_id) IN ('owner', 'admin')
    AND (role <> 'owner' OR public.event_role(event_id) = 'owner')
  );
