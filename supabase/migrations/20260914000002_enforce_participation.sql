-- Participation rules belong at the database boundary, including direct REST writes.
CREATE OR REPLACE FUNCTION public.enforce_event_vote_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  gathering public.events;
  budget integer;
  spent bigint;
  cost bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO gathering FROM public.events WHERE id = OLD.event_id;
    -- Cascading account/event deletion must still be able to remove its rows.
    IF FOUND AND EXISTS (SELECT 1 FROM public.profiles WHERE id = OLD.user_id)
      AND (gathering.status <> 'voting_open'
        OR (gathering.voting_opens_at IS NOT NULL AND now() < gathering.voting_opens_at)
        OR (gathering.voting_closes_at IS NOT NULL AND now() >= gathering.voting_closes_at)) THEN
      RAISE EXCEPTION 'Voting is not open for this event' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.session_id IS DISTINCT FROM OLD.session_id) THEN
    RAISE EXCEPTION 'Vote identity cannot be changed' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO gathering FROM public.events WHERE id = NEW.event_id;
  IF NOT FOUND OR gathering.status <> 'voting_open'
    OR (gathering.voting_opens_at IS NOT NULL AND now() < gathering.voting_opens_at)
    OR (gathering.voting_closes_at IS NOT NULL AND now() >= gathering.voting_closes_at) THEN
    RAISE EXCEPTION 'Voting is not open for this event' USING ERRCODE = '23514';
  END IF;
  -- Serialize each attendee's allocations, so concurrent requests cannot overspend.
  SELECT coalesce(m.vote_credits, gathering.vote_credits_per_user) INTO budget
    FROM public.event_members m WHERE m.event_id = NEW.event_id AND m.user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Join this event before voting' USING ERRCODE = '23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = NEW.session_id AND s.event_id = NEW.event_id AND s.status IN ('approved','scheduled') AND s.is_votable) THEN
    RAISE EXCEPTION 'This session is not available for voting in this event' USING ERRCODE = '23514';
  END IF;
  IF NEW.vote_count IS NULL OR NEW.vote_count <= 0 OR (gathering.voting_mechanism = 'approval' AND NEW.vote_count <> 1) THEN
    RAISE EXCEPTION 'Invalid vote count' USING ERRCODE = '23514';
  END IF;
  cost := CASE WHEN gathering.voting_mechanism = 'quadratic' THEN NEW.vote_count::bigint * NEW.vote_count ELSE NEW.vote_count END;
  SELECT coalesce(sum(CASE WHEN gathering.voting_mechanism = 'quadratic' THEN v.vote_count::bigint * v.vote_count ELSE v.vote_count END),0)
    INTO spent FROM public.votes v WHERE v.event_id = NEW.event_id AND v.user_id = NEW.user_id AND v.session_id <> NEW.session_id;
  IF cost + spent > budget THEN RAISE EXCEPTION 'Not enough voting credits' USING ERRCODE = '23514'; END IF;
  NEW.credits_spent := cost;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_event_vote_rules() FROM PUBLIC;
DROP TRIGGER IF EXISTS enforce_event_vote_rules ON public.votes;
CREATE TRIGGER enforce_event_vote_rules BEFORE INSERT OR UPDATE OR DELETE ON public.votes
FOR EACH ROW EXECUTE FUNCTION public.enforce_event_vote_rules();

CREATE OR REPLACE FUNCTION public.enforce_event_proposal_rules()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE gathering public.events; member_role text; proposal_count integer;
BEGIN
  SELECT * INTO gathering FROM public.events WHERE id = NEW.event_id;
  SELECT role INTO member_role FROM public.event_members WHERE event_id = NEW.event_id AND user_id = coalesce(auth.uid(), NEW.host_id) FOR UPDATE;
  -- Organizers can curate the program throughout setup and scheduling.
  IF member_role IN ('owner','admin') THEN RETURN NEW; END IF;
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
REVOKE ALL ON FUNCTION public.enforce_event_proposal_rules() FROM PUBLIC;
DROP TRIGGER IF EXISTS enforce_event_proposal_rules ON public.sessions;
CREATE TRIGGER enforce_event_proposal_rules BEFORE INSERT ON public.sessions
FOR EACH ROW EXECUTE FUNCTION public.enforce_event_proposal_rules();
