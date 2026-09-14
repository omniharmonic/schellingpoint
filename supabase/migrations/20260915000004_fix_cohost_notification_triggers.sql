-- cohost_invites has never had an email column: invites are opaque token links and the
-- invitee is unknown until they accept. Both P4.2.3 triggers referenced NEW.email, so every
-- invite INSERT and every accept UPDATE failed with 'record "new" has no field "email"'.
-- The creation notification cannot name an invitee and is removed; the response
-- notification uses accepted_by.
DROP TRIGGER IF EXISTS trigger_cohost_invite_created ON public.cohost_invites;
DROP FUNCTION IF EXISTS public.notify_cohost_invite_created();

CREATE OR REPLACE FUNCTION public.notify_cohost_response()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_session RECORD;
  v_action_url TEXT;
  v_responder_name TEXT;
BEGIN
  IF OLD.status <> 'pending' OR NEW.status <> 'accepted' THEN
    RETURN NEW;
  END IF;

  SELECT s.*, e.slug AS event_slug INTO v_session
  FROM public.sessions s JOIN public.events e ON e.id = s.event_id
  WHERE s.id = NEW.session_id;
  IF NOT FOUND OR v_session.host_id IS NULL THEN RETURN NEW; END IF;

  SELECT COALESCE(display_name, 'A co-host') INTO v_responder_name
  FROM public.profiles WHERE id = NEW.accepted_by;

  v_action_url := '/e/' || v_session.event_slug || '/sessions/' || NEW.session_id;

  INSERT INTO public.notifications (user_id, event_id, type, title, body, action_url, data)
  VALUES (
    v_session.host_id,
    v_session.event_id,
    'cohost_accepted',
    'Co-host invitation accepted',
    format('%s accepted your invitation to co-host "%s"', COALESCE(v_responder_name, 'A co-host'), v_session.title),
    v_action_url,
    jsonb_build_object('session_id', NEW.session_id, 'session_title', v_session.title,
                       'cohost_id', NEW.accepted_by, 'cohost_name', v_responder_name)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_cohost_response ON public.cohost_invites;
CREATE TRIGGER trigger_cohost_response
  AFTER UPDATE ON public.cohost_invites
  FOR EACH ROW EXECUTE FUNCTION public.notify_cohost_response();
