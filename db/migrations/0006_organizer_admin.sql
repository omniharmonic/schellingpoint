-- =============================================================================
-- 0006_organizer_admin.sql — work package D (organizer admin)
-- =============================================================================
-- 1. Organizer-listed speakers (spec §3 R9, §11): a name an organizer typed for an
--    external speaker is app-side, organizer-only, and never published. It lives in
--    its own table so no `select * from sessions` can ever carry it to a public API.
-- 2. Moderators review proposals (permissions.ts `approveProposals`): RLS lets them
--    read and update sessions of their event when writes run as the account.
-- 3. Schedule draft → publish (spec §6): `sessions.published_slot_id` is the slot a
--    session held at the last app-side publish, so the publish step can tell hosts
--    exactly what changed and the builder can tell organizers what is unpublished.
-- 4. `update_event_schedule_change` runs as definer, so schedule edits made as an
--    organizer account (not the event's creator) still stamp the event.
-- 5. Invitations (spec §9): each redemption is timestamped, so the retention job can
--    null the inviter 30 days after a shareable link was last used (link invites have
--    no accepted_at).
-- 6. Tracks carry shared-taxonomy skill URIs (`tracks.skill_uris`, published by package F).
-- =============================================================================

-- 1. Organizer-listed speaker names ------------------------------------------------

CREATE TABLE public.session_host_listings (
  session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE CASCADE,
  event_id   uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  host_name  text NOT NULL CHECK (char_length(btrim(host_name)) BETWEEN 1 AND 200),
  created_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_host_listings_event_id_idx ON public.session_host_listings (event_id);

COMMENT ON TABLE public.session_host_listings IS
  'Organizer-typed "listed as" names for host-less sessions (R9). Organizer-only; never served publicly, never written to any record.';

ALTER TABLE public.session_host_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Organizers can read listed hosts" ON public.session_host_listings
  FOR SELECT TO authenticated
  USING (public.event_role(event_id) IN ('owner', 'admin', 'moderator'));

CREATE POLICY "Organizers can manage listed hosts" ON public.session_host_listings
  FOR ALL TO authenticated
  USING (public.event_role(event_id) IN ('owner', 'admin'))
  WITH CHECK (public.event_role(event_id) IN ('owner', 'admin'));

-- The listing must belong to the session's own event.
CREATE FUNCTION public.enforce_session_host_listing_event() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = NEW.session_id AND s.event_id = NEW.event_id) THEN
    RAISE EXCEPTION 'Listed host does not belong to this event' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_session_host_listing_event
  BEFORE INSERT OR UPDATE ON public.session_host_listings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_session_host_listing_event();

-- Existing free-text names on host-less sessions (curated-speaker imports) move to
-- the organizer-only table; the public column is cleared. Names on sessions with a
-- host account were written by that host and stay where they are.
INSERT INTO public.session_host_listings (session_id, event_id, host_name)
SELECT s.id, s.event_id, left(btrim(s.host_name), 200)
FROM public.sessions s
WHERE s.host_id IS NULL AND s.host_name IS NOT NULL AND btrim(s.host_name) <> ''
ON CONFLICT (session_id) DO NOTHING;

UPDATE public.sessions SET host_name = NULL WHERE host_id IS NULL AND host_name IS NOT NULL;

-- 2. Moderators review proposals --------------------------------------------------

CREATE POLICY "Event moderators can view sessions" ON public.sessions
  FOR SELECT TO authenticated
  USING (public.event_role(event_id) = 'moderator');

CREATE POLICY "Event moderators can review sessions" ON public.sessions
  FOR UPDATE TO authenticated
  USING (public.event_role(event_id) = 'moderator')
  WITH CHECK (public.event_role(event_id) = 'moderator');

-- 3. Schedule publish bookkeeping -----------------------------------------------

ALTER TABLE public.sessions
  ADD COLUMN published_slot_id uuid REFERENCES public.time_slots(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.sessions.published_slot_id IS
  'The time slot this session held when the schedule was last published app-side (NULL: not on the published schedule).';

-- Sessions already on a published schedule count as published where they are.
UPDATE public.sessions s
SET published_slot_id = s.time_slot_id
FROM public.events e
WHERE e.id = s.event_id AND e.schedule_published_at IS NOT NULL
  AND s.status = 'scheduled' AND s.time_slot_id IS NOT NULL;

-- 4. Schedule change stamp runs as definer ------------------------------------

ALTER FUNCTION public.update_event_schedule_change() SECURITY DEFINER;
ALTER FUNCTION public.update_event_schedule_change() SET search_path TO 'public';

-- 5. Invitations: redemption time ------------------------------------------------
-- (0003, package E, makes created_by nullable with ON DELETE SET NULL.)

ALTER TABLE public.event_invitations ADD COLUMN IF NOT EXISTS last_redeemed_at timestamptz;

COMMENT ON COLUMN public.event_invitations.last_redeemed_at IS
  'Most recent redemption (email acceptance or link use). The retention job nulls created_by 30 days after it (spec §9).';

UPDATE public.event_invitations
SET last_redeemed_at = accepted_at
WHERE last_redeemed_at IS NULL AND accepted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS event_invitations_last_redeemed_at_idx
  ON public.event_invitations (last_redeemed_at)
  WHERE created_by IS NOT NULL AND last_redeemed_at IS NOT NULL;

-- 6. Track skills ----------------------------------------------------------------
-- Tracks carry shared-taxonomy skill URIs (spec §4.1, §10); package F publishes them on the
-- track record. Validated against the skills authority's index before they are written.

ALTER TABLE public.tracks ADD COLUMN IF NOT EXISTS skill_uris text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.tracks DROP CONSTRAINT IF EXISTS tracks_skill_uris_max;
ALTER TABLE public.tracks ADD CONSTRAINT tracks_skill_uris_max CHECK (cardinality(skill_uris) <= 20);

COMMENT ON COLUMN public.tracks.skill_uris IS
  'at:// URIs of freeschool.draft.skill records from the shared skills authority (spec §4.1, §10); at most 20.';
