-- One transaction for the creation wizard. Any constraint failure rolls back
-- the event and all children, including the organizer membership.
-- The API authenticates the caller and supplies created_by; this RPC is server-only.
CREATE OR REPLACE FUNCTION public.create_event_with_program(
  p_event jsonb, p_venues jsonb, p_tracks jsonb, p_time_slots jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  event_data public.events;
  created public.events;
BEGIN
  event_data := jsonb_populate_record(NULL::public.events, p_event);
  INSERT INTO public.events (
    slug, name, tagline, description, start_date, end_date, timezone,
    location_name, location_address, status, vote_credits_per_user, voting_mechanism,
    voting_opens_at, voting_closes_at, proposals_open_at, proposals_close_at,
    allowed_formats, allowed_durations, max_proposals_per_user, require_proposal_approval,
    theme, logo_url, banner_url, created_by, visibility, suggested_topics
  ) VALUES (
    event_data.slug, event_data.name, event_data.tagline, event_data.description,
    event_data.start_date, event_data.end_date, event_data.timezone,
    event_data.location_name, event_data.location_address, 'draft',
    event_data.vote_credits_per_user, event_data.voting_mechanism,
    event_data.voting_opens_at, event_data.voting_closes_at,
    event_data.proposals_open_at, event_data.proposals_close_at,
    event_data.allowed_formats, event_data.allowed_durations,
    event_data.max_proposals_per_user, event_data.require_proposal_approval,
    event_data.theme, event_data.logo_url, event_data.banner_url,
    event_data.created_by, event_data.visibility, event_data.suggested_topics
  ) RETURNING * INTO created;

  INSERT INTO public.venues (id, event_id, name, slug, capacity, features, address)
  SELECT v.id, created.id, v.name, v.slug, v.capacity, v.features, v.address
  FROM jsonb_populate_recordset(NULL::public.venues, p_venues) v;

  INSERT INTO public.tracks (event_id, name, slug, description, color, display_order, is_active)
  SELECT created.id, t.name, t.slug, t.description, t.color, t.display_order, true
  FROM jsonb_populate_recordset(NULL::public.tracks, p_tracks) t;

  -- Never allow a schedule to reference rooms belonging to another event.
  IF EXISTS (
    SELECT 1 FROM jsonb_populate_recordset(NULL::public.time_slots, p_time_slots) s
    WHERE s.venue_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.venues v WHERE v.id = s.venue_id AND v.event_id = created.id
    )
  ) THEN RAISE EXCEPTION 'Schedule room does not belong to this event' USING ERRCODE = '23514'; END IF;

  INSERT INTO public.time_slots (event_id, venue_id, start_time, end_time, label, is_break, day_date, slot_type)
  SELECT created.id, s.venue_id, s.start_time, s.end_time, s.label, s.is_break, s.day_date, s.slot_type
  FROM jsonb_populate_recordset(NULL::public.time_slots, p_time_slots) s;

  INSERT INTO public.event_members (event_id, user_id, role, vote_credits)
  VALUES (created.id, created.created_by, 'owner', created.vote_credits_per_user);

  RETURN jsonb_build_object('id', created.id, 'slug', created.slug, 'name', created.name);
END;
$$;
REVOKE ALL ON FUNCTION public.create_event_with_program(jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_event_with_program(jsonb, jsonb, jsonb, jsonb) TO service_role;
