-- Network-ingested proposals: allow host-less imported rows through the proposal
-- rules (window and format still apply) and skip host notifications for them.
CREATE OR REPLACE FUNCTION public.enforce_event_proposal_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE gathering public.events; member_role text; proposal_count integer;
BEGIN
  SELECT * INTO gathering FROM public.events WHERE id = NEW.event_id;
  SELECT role INTO member_role FROM public.event_members WHERE event_id = NEW.event_id AND user_id = coalesce(auth.uid(), NEW.host_id) FOR UPDATE;
  -- Organizers can curate the program throughout setup and scheduling.
  IF member_role IN ('owner','admin') THEN RETURN NEW; END IF;
  -- Proposals ingested from the network (a schellingpoint.draft.proposal in the
  -- author's own repo) arrive via the service role with no app account behind
  -- them. They still respect the proposal window and format rules, but membership
  -- and self-authorship cannot apply: the record is its own signature.
  IF auth.uid() IS NULL AND NEW.imported_from = 'atproto' THEN
    IF gathering.status IS DISTINCT FROM 'proposals_open'
      OR (gathering.proposals_open_at IS NOT NULL AND now() < gathering.proposals_open_at)
      OR (gathering.proposals_close_at IS NOT NULL AND now() >= gathering.proposals_close_at) THEN
      RAISE EXCEPTION 'Proposals are not open for this event' USING ERRCODE = '23514';
    END IF;
    IF NEW.format IS NULL OR NEW.duration IS NULL OR NOT (NEW.format = ANY(gathering.allowed_formats)) OR NOT (NEW.duration = ANY(gathering.allowed_durations)) THEN
      RAISE EXCEPTION 'Choose an allowed session format and duration' USING ERRCODE = '23514';
    END IF;
    NEW.status := 'pending';
    RETURN NEW;
  END IF;
  IF auth.uid() IS NOT NULL AND NEW.host_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'You can only propose a session as yourself' USING ERRCODE = '23514';
  END IF;
  IF gathering.status IS DISTINCT FROM 'proposals_open'
    OR (gathering.proposals_open_at IS NOT NULL AND now() < gathering.proposals_open_at)
    OR (gathering.proposals_close_at IS NOT NULL AND now() >= gathering.proposals_close_at) THEN
    RAISE EXCEPTION 'Proposals are not open for this event' USING ERRCODE = '23514';
  END IF;
  IF member_role IS NULL THEN RAISE EXCEPTION 'Join this event before proposing a session' USING ERRCODE = '23514'; END IF;
  IF NEW.format IS NULL OR NEW.duration IS NULL OR NOT (NEW.format = ANY(gathering.allowed_formats)) OR NOT (NEW.duration = ANY(gathering.allowed_durations)) THEN
    RAISE EXCEPTION 'Choose an allowed session format and duration' USING ERRCODE = '23514';
  END IF;
  SELECT count(*) INTO proposal_count FROM public.sessions WHERE event_id = NEW.event_id AND host_id = NEW.host_id;
  IF gathering.max_proposals_per_user > 0 AND proposal_count >= gathering.max_proposals_per_user THEN
    RAISE EXCEPTION 'You have reached this event''s proposal limit' USING ERRCODE = '23514';
  END IF;
  NEW.status := CASE WHEN gathering.require_proposal_approval THEN 'pending' ELSE 'approved' END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_session_status_change ON public.sessions;
CREATE TRIGGER trigger_session_status_change
  AFTER UPDATE ON public.sessions
  FOR EACH ROW
  WHEN (NEW.host_id IS NOT NULL)
  EXECUTE FUNCTION notify_session_status_change();
