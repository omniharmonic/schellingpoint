-- =============================================================================
-- local-demo.sql — demo gatherings for the local stack (ALLOW_SEED=true only)
-- =============================================================================
-- Creates, relative to the day the seed runs:
--   demo-gathering   public, proposals_open, two days starting in two weeks,
--                    3 venues, 4 tracks, a time grid for 2 days × 3 venues
--   draft-gathering  public but draft (invisible to non-organizers)
--   past-gathering   completed a month ago, 3 scheduled sessions with no host
--                    (host_id and host_name NULL) for read-only pages
-- No accounts or profiles: those are created through sign-in.
--
-- Idempotent: each event is inserted with ON CONFLICT (slug) DO NOTHING and its
-- children are only created when the event row was new. Everything runs in one
-- DO block (one transaction), so it also works with plain `psql -f`.
-- =============================================================================

DO $seed$
DECLARE
  tz constant text := 'America/Denver';
  demo_id uuid;
  draft_id uuid;
  past_id uuid;
  venue_ids uuid[];
  v uuid;
  d integer;
  day date;
  slot record;
  past_slots uuid[];
BEGIN
  -- ---------------------------------------------------------------------------
  -- demo-gathering
  -- ---------------------------------------------------------------------------
  INSERT INTO public.events (
    slug, name, tagline, description, start_date, end_date, timezone,
    location_name, location_address, status, visibility,
    vote_credits_per_user, voting_mechanism,
    allowed_formats, allowed_durations, max_proposals_per_user, require_proposal_approval,
    suggested_topics, theme
  ) VALUES (
    'demo-gathering', 'Demo Gathering', 'A local unconference for trying things out',
    'Propose a session, vote with quadratic credits, and see the program come together.',
    current_date + 14, current_date + 15, tz,
    'Community Hall', '1 Local Street, Boulder, CO', 'proposals_open', 'public',
    100, 'quadratic',
    ARRAY['talk', 'workshop', 'panel', 'discussion'], ARRAY[15, 30, 45, 60], 5, false,
    ARRAY['governance', 'public goods', 'local food', 'open source'], '{}'::jsonb
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO demo_id;

  IF demo_id IS NOT NULL THEN
    WITH inserted AS (
      INSERT INTO public.venues (event_id, name, slug, capacity, features, is_primary)
      VALUES
        (demo_id, 'Main Hall',     'main-hall',     120, ARRAY['projector', 'microphone'], true),
        (demo_id, 'Workshop Room', 'workshop-room',  30, ARRAY['whiteboard'],              false),
        (demo_id, 'Garden',        'garden',         40, ARRAY[]::text[],                  false)
      RETURNING id, slug
    )
    SELECT array_agg(id ORDER BY slug) INTO venue_ids FROM inserted;

    INSERT INTO public.tracks (event_id, name, slug, description, color, display_order, is_active)
    VALUES
      (demo_id, 'Governance',   'governance',   'Coordination, decision making, institutions', '#6366f1', 0, true),
      (demo_id, 'Public Goods', 'public-goods', 'Funding and sustaining the commons',          '#10b981', 1, true),
      (demo_id, 'Local Life',   'local-life',   'Food, land, neighbourhoods',                  '#f59e0b', 2, true),
      (demo_id, 'Open Source',  'open-source',  'Building in the open',                        '#ec4899', 3, true);

    FOR d IN 0..1 LOOP
      day := current_date + 14 + d;
      FOREACH v IN ARRAY venue_ids LOOP
        FOR slot IN
          SELECT * FROM (VALUES
            (time '09:00', time '10:00', 'Morning session', false, 'session'),
            (time '10:15', time '11:15', 'Late morning',    false, 'session'),
            (time '11:30', time '12:30', 'Before lunch',    false, 'session'),
            (time '12:30', time '13:30', 'Lunch',           true,  'break'),
            (time '13:30', time '14:30', 'Afternoon',       false, 'session'),
            (time '14:45', time '15:45', 'Late afternoon',  false, 'session')
          ) AS s(starts, ends, label, is_break, slot_type)
        LOOP
          INSERT INTO public.time_slots (event_id, venue_id, day_date, start_time, end_time, label, is_break, slot_type)
          VALUES (
            demo_id, v, day,
            (day + slot.starts) AT TIME ZONE tz,
            (day + slot.ends) AT TIME ZONE tz,
            slot.label, slot.is_break, slot.slot_type
          );
        END LOOP;
      END LOOP;
    END LOOP;
  END IF;

  -- ---------------------------------------------------------------------------
  -- draft-gathering
  -- ---------------------------------------------------------------------------
  INSERT INTO public.events (
    slug, name, tagline, start_date, end_date, timezone, status, visibility,
    vote_credits_per_user, voting_mechanism, allowed_formats, allowed_durations,
    require_proposal_approval
  ) VALUES (
    'draft-gathering', 'Draft Gathering', 'Still being planned',
    current_date + 60, current_date + 60, tz, 'draft', 'public',
    100, 'quadratic', ARRAY['talk', 'workshop', 'panel', 'discussion'], ARRAY[15, 30, 45, 60],
    true
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO draft_id;

  -- ---------------------------------------------------------------------------
  -- past-gathering
  -- ---------------------------------------------------------------------------
  INSERT INTO public.events (
    slug, name, tagline, description, start_date, end_date, timezone,
    location_name, status, visibility, vote_credits_per_user, voting_mechanism,
    allowed_formats, allowed_durations, require_proposal_approval,
    schedule_published_at
  ) VALUES (
    'past-gathering', 'Past Gathering', 'It happened; here is what was on',
    'A completed gathering with a published program.',
    current_date - 30, current_date - 30, tz,
    'Old Library', 'completed', 'public', 100, 'quadratic',
    ARRAY['talk', 'workshop', 'panel', 'discussion'], ARRAY[15, 30, 45, 60], false,
    now() - interval '35 days'
  )
  ON CONFLICT (slug) DO NOTHING
  RETURNING id INTO past_id;

  IF past_id IS NOT NULL THEN
    day := current_date - 30;
    INSERT INTO public.venues (event_id, name, slug, capacity, features, is_primary)
    VALUES (past_id, 'Reading Room', 'reading-room', 60, ARRAY['projector'], true)
    RETURNING id INTO v;

    WITH inserted AS (
      INSERT INTO public.time_slots (event_id, venue_id, day_date, start_time, end_time, label, slot_type)
      SELECT past_id, v, day, (day + s.starts) AT TIME ZONE tz, (day + s.ends) AT TIME ZONE tz, s.label, 'session'
      FROM (VALUES
        (time '10:00', time '11:00', 'Opening'),
        (time '11:15', time '12:15', 'Midday'),
        (time '14:00', time '15:00', 'Afternoon')
      ) AS s(starts, ends, label)
      RETURNING id, start_time
    )
    SELECT array_agg(id ORDER BY start_time) INTO past_slots FROM inserted;

    -- The proposal trigger (rightly) refuses sessions for a completed event with
    -- no host; seed data is historical, so triggers are skipped for this insert
    -- only (transaction-local; requires the owner/superuser connection).
    PERFORM set_config('session_replication_role', 'replica', true);
    INSERT INTO public.sessions (
      event_id, title, description, format, duration, host_id, host_name,
      status, venue_id, time_slot_id, session_type, is_votable, topic_tags
    ) VALUES
      (past_id, 'What we learned running an unconference', 'A retrospective on the format.', 'talk', 60, NULL, NULL,
       'scheduled', v, past_slots[1], 'proposed', true, ARRAY['governance']),
      (past_id, 'Mapping the local commons', 'A hands-on mapping session.', 'workshop', 60, NULL, NULL,
       'scheduled', v, past_slots[2], 'proposed', true, ARRAY['local food']),
      (past_id, 'Open questions', 'Closing discussion.', 'discussion', 60, NULL, NULL,
       'scheduled', v, past_slots[3], 'proposed', true, ARRAY['open source']);
    PERFORM set_config('session_replication_role', 'origin', true);
  END IF;
END
$seed$;
