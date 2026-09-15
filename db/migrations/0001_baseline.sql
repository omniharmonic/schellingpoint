-- =============================================================================
-- 0001_baseline.sql — unconference.events AppView schema (plain PostgreSQL 16)
-- =============================================================================
--
-- The full application schema of the previous (Supabase-hosted) pass, as of
-- supabase/migrations/20260916000002_atproto_ingest_rules.sql, minus every
-- Supabase-only object, with the identity changes from
-- docs/ATPROTO_APPVIEW_PLAN.md §3.1:
--
--   * public.accounts replaces auth.users everywhere (FKs, handle_new_user).
--   * public.auth_email_tokens holds magic-link / reveal tokens.
--   * auth.uid() is the only piece of the auth schema kept: it reads the `sub`
--     claim from the `request.jwt.claims` setting, which src/lib/db asAccount()
--     sets per transaction, so RLS policies and participation triggers keep
--     working as defense in depth.
--   * at_sessions.kind is ('custodial','oauth'); at_sessions.user_id → accounts.
--
-- Generated from `pg_dump --schema-only --schema=public --no-owner` of the local
-- Supabase stack, then transformed (see db/README.md for the list). Sections:
--   1. session settings        5. application functions, tables, constraints,
--   2. extensions                 indexes, triggers, RLS policies (from dump)
--   3. roles                   6. identity trigger on public.accounts
--   4. auth schema + identity  7. grants and default privileges
--
-- Applied by scripts/db-migrate.mjs inside one transaction; also applies
-- cleanly with `psql -v ON_ERROR_STOP=1` to an empty database. Not re-runnable:
-- the migrator records the version in public.app_migrations.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Session settings (reset at the end of the file)
-- -----------------------------------------------------------------------------
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
-- SQL-language functions below reference tables created later in this file.
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- -----------------------------------------------------------------------------
-- 2. Extensions
-- -----------------------------------------------------------------------------
-- Existing column defaults call extensions.gen_random_bytes(), so pgcrypto lives
-- in an `extensions` schema exactly as it did on Supabase. gen_random_uuid() is
-- core (pg_catalog) since PostgreSQL 13 and needs no extension.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- -----------------------------------------------------------------------------
-- 3. Roles
-- -----------------------------------------------------------------------------
-- anon / authenticated / service_role keep the names RLS policies were written
-- against. None can log in. The application login role (APP_DB_USER) is created
-- by scripts/db-migrate.mjs and made a member of anon + authenticated so that
-- asAccount() can `SET LOCAL ROLE authenticated`.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 4. auth schema (compatibility shim) and identity tables
-- -----------------------------------------------------------------------------
CREATE SCHEMA auth;

-- The signed-in account for the current transaction, or NULL for service code.
-- asAccount() runs set_config('request.jwt.claims', '{"sub":…,"role":"authenticated"}', true).
-- The inner nullif() matters: once a transaction-local setting ends, a pooled
-- connection reports '' (not NULL), and ''::jsonb would raise.
CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  SELECT nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

-- table: accounts — one row per person who can sign in (replaces auth.users)
CREATE TABLE public.accounts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    did text UNIQUE NOT NULL,
    handle text,
    email text UNIQUE,                      -- lowercased; NULL for OAuth-only accounts
    kind text NOT NULL CHECK (kind IN ('custodial', 'oauth')),
    wrapped_password bytea,                 -- custodial only; AES-256-GCM (src/lib/atproto/crypto.ts)
    key_version text,
    email_verified_at timestamptz,
    owned_at timestamptz,                   -- set by take-ownership
    created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.accounts IS 'Sign-in identities keyed by DID. kind=custodial: email account minted on our PDS; kind=oauth: Bluesky/ATProto OAuth account.';

-- table: auth_email_tokens — single-use emailed tokens (sign-in links, password reveal)
CREATE TABLE public.auth_email_tokens (
    token_hash text PRIMARY KEY,            -- sha256 hex of the emailed token
    email text NOT NULL,
    account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('signin', 'reveal')),
    next_path text,
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX auth_email_tokens_email_idx ON public.auth_email_tokens USING btree (email, created_at DESC);
CREATE INDEX auth_email_tokens_account_id_idx ON public.auth_email_tokens USING btree (account_id);
CREATE INDEX auth_email_tokens_expires_at_idx ON public.auth_email_tokens USING btree (expires_at);

-- Identity rows are server-only. Defense in depth for asAccount() transactions:
-- a person may read their own account row (never wrapped_password, see §7);
-- email tokens are invisible to everyone but the table owner / BYPASSRLS roles.
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_email_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Accounts can read their own row" ON public.accounts FOR SELECT TO authenticated USING ((id = auth.uid()));

-- -----------------------------------------------------------------------------
-- 5. Application schema (transformed pg_dump of the previous pass)
-- -----------------------------------------------------------------------------

-- function: add_ticket_holder_as_member()

CREATE FUNCTION public.add_ticket_holder_as_member() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  tier_vote_credits INTEGER;
  event_vote_credits INTEGER;
BEGIN
  -- Only when ticket is confirmed
  IF NEW.status = 'confirmed' THEN
    -- Get vote credits (tier override or event default)
    SELECT
      tt.vote_credits_override,
      e.vote_credits_per_user
    INTO tier_vote_credits, event_vote_credits
    FROM ticket_tiers tt
    JOIN events e ON tt.event_id = e.id
    WHERE tt.id = NEW.tier_id;

    -- Add as attendee if not already a member
    INSERT INTO event_members (event_id, user_id, role, vote_credits)
    VALUES (
      NEW.event_id,
      NEW.user_id,
      'attendee',
      COALESCE(tier_vote_credits, event_vote_credits)
    )
    ON CONFLICT (event_id, user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

-- function: can_manage_session(uuid)

CREATE FUNCTION public.can_manage_session(target_session uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sessions s
    WHERE s.id = target_session AND (
      s.host_id = auth.uid()
      OR EXISTS (
        SELECT 1 FROM public.session_cohosts c
        WHERE c.session_id = s.id AND c.user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.event_members m
        WHERE m.event_id = s.event_id AND m.user_id = auth.uid()
          AND m.role IN ('owner', 'admin', 'moderator')
      )
    )
  );
$$;

-- function: can_read_event(uuid)

CREATE FUNCTION public.can_read_event(target_event uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.events e WHERE e.id = target_event AND (
      (e.visibility IN ('public', 'unlisted') AND e.status <> 'draft')
      OR EXISTS (
        SELECT 1 FROM public.event_members m
        WHERE m.event_id = e.id AND m.user_id = auth.uid()
          AND (e.status <> 'draft' OR m.role IN ('owner', 'admin'))
      )
    )
  );
$$;

-- function: can_read_session_event(uuid)

CREATE FUNCTION public.can_read_session_event(target_session uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = target_session AND public.can_read_event(s.event_id));
$$;

-- function: create_event_with_program(jsonb, jsonb, jsonb, jsonb)

CREATE FUNCTION public.create_event_with_program(p_event jsonb, p_venues jsonb, p_tracks jsonb, p_time_slots jsonb) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
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

-- function: enforce_event_proposal_rules()

CREATE FUNCTION public.enforce_event_proposal_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

-- function: enforce_event_vote_rules()

CREATE FUNCTION public.enforce_event_vote_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
      AND EXISTS (SELECT 1 FROM public.sessions WHERE id = OLD.session_id)
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

-- function: enforce_session_feedback_window()

CREATE FUNCTION public.enforce_session_feedback_window() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  started timestamptz;
BEGIN
  started := public.session_started_at(NEW.session_id);
  IF started IS NULL THEN
    RAISE EXCEPTION 'Feedback is only accepted for scheduled sessions'
      USING ERRCODE = 'check_violation';
  END IF;
  IF started > NOW() THEN
    RAISE EXCEPTION 'Feedback opens once the session has started'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := NOW();
  END IF;
  RETURN NEW;
END;
$$;

-- function: enforce_session_update_rules()

CREATE FUNCTION public.enforce_session_update_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

-- function: event_role(uuid)

CREATE FUNCTION public.event_role(target_event uuid) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT m.role FROM public.event_members m
  WHERE m.event_id = target_event AND m.user_id = auth.uid()
  LIMIT 1;
$$;

-- function: fill_cohost_event_id()

CREATE FUNCTION public.fill_cohost_event_id() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

-- function: get_notification_category(character varying)

CREATE FUNCTION public.get_notification_category(notification_type character varying) RETURNS character varying
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
  RETURN CASE notification_type
    -- Session lifecycle
    WHEN 'session_submitted' THEN 'session_updates'
    WHEN 'session_approved' THEN 'session_updates'
    WHEN 'session_rejected' THEN 'session_updates'
    WHEN 'session_scheduled' THEN 'session_updates'
    WHEN 'session_rescheduled' THEN 'session_updates'
    WHEN 'session_cancelled' THEN 'session_updates'
    -- Voting
    WHEN 'vote_milestone' THEN 'voting_updates'
    -- Collaboration
    WHEN 'cohost_invited' THEN 'collaboration'
    WHEN 'cohost_accepted' THEN 'collaboration'
    WHEN 'cohost_declined' THEN 'collaboration'
    -- Event-wide
    WHEN 'voting_opened' THEN 'event_announcements'
    WHEN 'voting_closed' THEN 'event_announcements'
    WHEN 'schedule_published' THEN 'event_announcements'
    WHEN 'event_reminder' THEN 'event_announcements'
    WHEN 'admin_announcement' THEN 'event_announcements'
    -- Admin
    WHEN 'new_proposal' THEN 'admin_alerts'
    WHEN 'proposal_needs_review' THEN 'admin_alerts'
    ELSE 'session_updates'  -- Default fallback
  END;
END;
$$;

-- function: handle_new_user()

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- baseline: previously fired on the hosted auth user table and read the display name from user metadata.
  -- public.accounts has no metadata; the display name starts as the handle's first label,
  -- then the email local part. profiles.email is NOT NULL, so OAuth-only accounts (no
  -- email) store '' until the person adds one.
  INSERT INTO public.profiles (id, email, display_name)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, ''),
    COALESCE(NULLIF(split_part(NEW.handle, '.', 1), ''), NULLIF(split_part(NEW.email, '@', 1), ''))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- function: is_session_cohost(uuid)

CREATE FUNCTION public.is_session_cohost(target_session uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM public.session_cohosts c WHERE c.session_id = target_session AND c.user_id = auth.uid());
$$;

-- function: is_session_host(uuid)

CREATE FUNCTION public.is_session_host(target_session uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (SELECT 1 FROM public.sessions s WHERE s.id = target_session AND s.host_id = auth.uid());
$$;

-- function: is_session_organizer(uuid)

CREATE FUNCTION public.is_session_organizer(target_session uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.sessions s JOIN public.event_members m ON m.event_id = s.event_id
    WHERE s.id = target_session AND m.user_id = auth.uid() AND m.role IN ('owner','admin','moderator')
  );
$$;

-- function: notify_cohost_response()

CREATE FUNCTION public.notify_cohost_response() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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

-- function: notify_new_proposal()

CREATE FUNCTION public.notify_new_proposal() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
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
$$;

-- function: notify_session_status_change()

CREATE FUNCTION public.notify_session_status_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
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
$$;

-- function: notify_vote_milestone()

CREATE FUNCTION public.notify_vote_milestone() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_old_votes INTEGER;
  v_new_votes INTEGER;
  v_milestone INTEGER;
  v_event_slug TEXT;
  v_action_url TEXT;
  v_session RECORD;
BEGIN
  -- Get old and new vote counts
  v_old_votes := COALESCE(OLD.total_votes, 0);
  v_new_votes := COALESCE(NEW.total_votes, 0);

  -- Only check if votes increased
  IF v_new_votes <= v_old_votes THEN
    RETURN NEW;
  END IF;

  -- Check each milestone
  FOREACH v_milestone IN ARRAY ARRAY[10, 25, 50, 100]
  LOOP
    -- If we crossed this milestone
    IF v_old_votes < v_milestone AND v_new_votes >= v_milestone THEN
      -- Get session info
      SELECT s.*, e.slug as event_slug
      INTO v_session
      FROM sessions s
      JOIN events e ON e.id = s.event_id
      WHERE s.id = NEW.id;

      v_action_url := '/e/' || v_session.event_slug || '/sessions/' || NEW.id;

      -- Notify host
      INSERT INTO notifications (user_id, event_id, type, title, body, action_url, data)
      VALUES (
        NEW.host_id,
        NEW.event_id,
        'vote_milestone',
        format('Your session reached %s votes!', v_milestone),
        format('"%s" is gaining traction with %s total votes.', NEW.title, v_new_votes),
        v_action_url,
        jsonb_build_object('session_id', NEW.id, 'milestone', v_milestone, 'total_votes', v_new_votes)
      );

      -- Only notify for the highest milestone crossed
      EXIT;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

-- function: promote_from_waitlist()

CREATE FUNCTION public.promote_from_waitlist() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  session_capacity INTEGER;
  current_confirmed INTEGER;
  next_waitlist_id UUID;
BEGIN
  -- Only process when an RSVP is cancelled or deleted
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.status = 'cancelled' AND OLD.status = 'confirmed') THEN
    -- Get session capacity from venue
    SELECT v.capacity INTO session_capacity
    FROM sessions s
    LEFT JOIN venues v ON s.venue_id = v.id
    WHERE s.id = COALESCE(NEW.session_id, OLD.session_id);

    -- If no capacity limit, no promotion needed
    IF session_capacity IS NULL THEN
      RETURN COALESCE(NEW, OLD);
    END IF;

    -- Get current confirmed count
    SELECT COUNT(*) INTO current_confirmed
    FROM session_rsvps
    WHERE session_id = COALESCE(NEW.session_id, OLD.session_id)
      AND status = 'confirmed';

    -- If there's room, promote the first waitlisted person
    IF current_confirmed < session_capacity THEN
      SELECT id INTO next_waitlist_id
      FROM session_rsvps
      WHERE session_id = COALESCE(NEW.session_id, OLD.session_id)
        AND status = 'waitlist'
      ORDER BY waitlist_position ASC NULLS LAST, created_at ASC
      LIMIT 1;

      IF next_waitlist_id IS NOT NULL THEN
        UPDATE session_rsvps
        SET status = 'confirmed',
            waitlist_position = NULL,
            updated_at = NOW()
        WHERE id = next_waitlist_id;

        -- Reorder remaining waitlist positions
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY waitlist_position ASC NULLS LAST, created_at ASC) as new_pos
          FROM session_rsvps
          WHERE session_id = COALESCE(NEW.session_id, OLD.session_id)
            AND status = 'waitlist'
        )
        UPDATE session_rsvps r
        SET waitlist_position = o.new_pos
        FROM ordered o
        WHERE r.id = o.id;
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- function: session_feedback_summary(uuid)

CREATE FUNCTION public.session_feedback_summary(target_session uuid) RETURNS TABLE(avg_rating numeric, count integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT
    CASE WHEN COUNT(*) >= 3 THEN ROUND(AVG(f.rating)::numeric, 2) ELSE NULL END AS avg_rating,
    CASE WHEN COUNT(*) >= 3 THEN COUNT(*)::integer ELSE NULL END AS count
  FROM public.session_feedback f
  WHERE f.session_id = target_session;
$$;

-- function: session_started_at(uuid)

CREATE FUNCTION public.session_started_at(target_session uuid) RETURNS timestamp with time zone
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT CASE
    WHEN s.status <> 'scheduled' THEN NULL
    WHEN s.is_self_hosted THEN s.self_hosted_start_time
    ELSE ts.start_time
  END
  FROM public.sessions s
  LEFT JOIN public.time_slots ts ON ts.id = s.time_slot_id
  WHERE s.id = target_session;
$$;

-- function: set_event_id_from_session()

CREATE FUNCTION public.set_event_id_from_session() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  parent_event uuid;
BEGIN
  SELECT event_id INTO parent_event FROM public.sessions WHERE id = NEW.session_id;
  IF parent_event IS NULL THEN
    RAISE EXCEPTION 'Session % not found', NEW.session_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  NEW.event_id := parent_event;
  RETURN NEW;
END;
$$;

-- function: should_send_notification(uuid, uuid, character varying, character varying)

CREATE FUNCTION public.should_send_notification(p_user_id uuid, p_event_id uuid, p_type character varying, p_channel character varying) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_category VARCHAR(50);
  v_pref notification_preferences%ROWTYPE;
BEGIN
  -- Get the category for this notification type
  v_category := get_notification_category(p_type);

  -- Look for event-specific preference first
  SELECT * INTO v_pref
  FROM notification_preferences
  WHERE user_id = p_user_id
    AND event_id = p_event_id
    AND category = v_category;

  -- If no event-specific preference, check global preference
  IF NOT FOUND THEN
    SELECT * INTO v_pref
    FROM notification_preferences
    WHERE user_id = p_user_id
      AND event_id IS NULL
      AND category = v_category;
  END IF;

  -- If still no preference found, use defaults (email=true, in_app=true, push=false)
  IF NOT FOUND THEN
    RETURN CASE p_channel
      WHEN 'email' THEN true
      WHEN 'in_app' THEN true
      WHEN 'push' THEN false
      ELSE false
    END;
  END IF;

  -- Return the appropriate channel setting
  RETURN CASE p_channel
    WHEN 'email' THEN v_pref.email_enabled
    WHEN 'in_app' THEN v_pref.in_app_enabled
    WHEN 'push' THEN v_pref.push_enabled
    ELSE false
  END;
END;
$$;

-- function: update_event_schedule_change()

CREATE FUNCTION public.update_event_schedule_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- When a session's time_slot_id or venue_id changes, update the event's last_schedule_change_at
  IF (TG_OP = 'UPDATE' AND (
    OLD.time_slot_id IS DISTINCT FROM NEW.time_slot_id OR
    OLD.venue_id IS DISTINCT FROM NEW.venue_id OR
    OLD.status IS DISTINCT FROM NEW.status
  )) OR TG_OP = 'INSERT' OR TG_OP = 'DELETE' THEN
    UPDATE events
    SET last_schedule_change_at = NOW()
    WHERE id = COALESCE(NEW.event_id, OLD.event_id);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- function: update_notification_preferences_updated_at()

CREATE FUNCTION public.update_notification_preferences_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- function: update_session_rsvp_counts()

CREATE FUNCTION public.update_session_rsvp_counts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Update counts for affected session
  IF TG_OP = 'DELETE' THEN
    UPDATE sessions
    SET rsvp_count = (
      SELECT COUNT(*) FROM session_rsvps
      WHERE session_id = OLD.session_id AND status = 'confirmed'
    ),
    waitlist_count = (
      SELECT COUNT(*) FROM session_rsvps
      WHERE session_id = OLD.session_id AND status = 'waitlist'
    )
    WHERE id = OLD.session_id;
    RETURN OLD;
  ELSE
    UPDATE sessions
    SET rsvp_count = (
      SELECT COUNT(*) FROM session_rsvps
      WHERE session_id = NEW.session_id AND status = 'confirmed'
    ),
    waitlist_count = (
      SELECT COUNT(*) FROM session_rsvps
      WHERE session_id = NEW.session_id AND status = 'waitlist'
    )
    WHERE id = NEW.session_id;
    RETURN NEW;
  END IF;
END;
$$;

-- function: update_session_vote_counts()

CREATE FUNCTION public.update_session_vote_counts() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE sessions SET
      total_votes = COALESCE((SELECT SUM(vote_count) FROM votes WHERE session_id = OLD.session_id), 0),
      total_credits = COALESCE((SELECT SUM(credits_spent) FROM votes WHERE session_id = OLD.session_id), 0),
      voter_count = COALESCE((SELECT COUNT(*) FROM votes WHERE session_id = OLD.session_id), 0),
      updated_at = NOW()
    WHERE id = OLD.session_id;
    RETURN OLD;
  ELSE
    UPDATE sessions SET
      total_votes = COALESCE((SELECT SUM(vote_count) FROM votes WHERE session_id = NEW.session_id), 0),
      total_credits = COALESCE((SELECT SUM(credits_spent) FROM votes WHERE session_id = NEW.session_id), 0),
      voter_count = COALESCE((SELECT COUNT(*) FROM votes WHERE session_id = NEW.session_id), 0),
      updated_at = NOW()
    WHERE id = NEW.session_id;
    RETURN NEW;
  END IF;
END;
$$;

-- function: update_tier_quantity_sold()

CREATE FUNCTION public.update_tier_quantity_sold() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'confirmed' THEN
    UPDATE ticket_tiers
    SET quantity_sold = quantity_sold + 1,
        updated_at = NOW()
    WHERE id = NEW.tier_id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Handle status changes
    IF OLD.status != 'confirmed' AND NEW.status = 'confirmed' THEN
      UPDATE ticket_tiers
      SET quantity_sold = quantity_sold + 1,
          updated_at = NOW()
      WHERE id = NEW.tier_id;
    ELSIF OLD.status = 'confirmed' AND NEW.status = 'cancelled' THEN
      UPDATE ticket_tiers
      SET quantity_sold = GREATEST(0, quantity_sold - 1),
          updated_at = NOW()
      WHERE id = NEW.tier_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

SET default_tablespace = '';

SET default_table_access_method = heap;

-- table: at_audit

CREATE TABLE public.at_audit (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid,
    actor_did text,
    caller_user_id uuid,
    action text NOT NULL,
    collection text,
    rkey text,
    uri text,
    decision text NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT at_audit_decision_check CHECK ((decision = ANY (ARRAY['allow'::text, 'deny'::text])))
);

-- table: at_credentials

CREATE TABLE public.at_credentials (
    did text NOT NULL,
    kind text NOT NULL,
    identifier text,
    wrapped bytea,
    key_version text,
    pds_url text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone,
    last_ok_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error text,
    CONSTRAINT at_credentials_kind_check CHECK ((kind = ANY (ARRAY['oauth'::text, 'app-password'::text])))
);

-- table: at_oauth_client_key

CREATE TABLE public.at_oauth_client_key (
    kid text NOT NULL,
    jwk jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- table: at_oauth_session

CREATE TABLE public.at_oauth_session (
    sub text NOT NULL,
    session jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- table: at_oauth_state

CREATE TABLE public.at_oauth_state (
    key text NOT NULL,
    state jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- table: at_records

CREATE TABLE public.at_records (
    uri text NOT NULL,
    did text NOT NULL,
    collection text NOT NULL,
    rkey text NOT NULL,
    cid text,
    record jsonb NOT NULL,
    indexed_at timestamp with time zone DEFAULT now() NOT NULL,
    source text
);

-- table: at_sessions

CREATE TABLE public.at_sessions (
    id text NOT NULL,
    did text NOT NULL,
    user_id uuid,
    kind text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT at_sessions_kind_check CHECK ((kind = ANY (ARRAY['custodial'::text, 'oauth'::text])))
);

-- table: at_slot_grids

CREATE TABLE public.at_slot_grids (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    venue_id uuid,
    day_date date NOT NULL,
    uri text,
    cid text
);

-- table: at_sync_cursor

CREATE TABLE public.at_sync_cursor (
    source text NOT NULL,
    cursor text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- table: cohost_invites

CREATE TABLE public.cohost_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
    created_by uuid NOT NULL,
    accepted_by uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    accepted_at timestamp with time zone,
    event_id uuid NOT NULL,
    CONSTRAINT cohost_invites_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'revoked'::text]))),
    CONSTRAINT token_length CHECK ((length(token) = 64))
);

-- table: event_invitations

CREATE TABLE public.event_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    email text,
    token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
    role text DEFAULT 'attendee'::text NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    accepted_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    max_uses integer,
    use_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT event_invitations_max_uses_check CHECK (((max_uses IS NULL) OR (max_uses > 0))),
    CONSTRAINT event_invitations_role_check CHECK ((role = ANY (ARRAY['attendee'::text, 'volunteer'::text, 'moderator'::text, 'admin'::text])))
);

-- table: event_members

CREATE TABLE public.event_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'attendee'::text NOT NULL,
    vote_credits integer,
    joined_at timestamp with time zone DEFAULT now(),
    CONSTRAINT event_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'moderator'::text, 'track_lead'::text, 'volunteer'::text, 'attendee'::text])))
);

-- table: events

CREATE TABLE public.events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    tagline text,
    description text,
    start_date date NOT NULL,
    end_date date NOT NULL,
    timezone text DEFAULT 'America/Denver'::text NOT NULL,
    location_name text,
    location_address text,
    location_geo point,
    status text DEFAULT 'draft'::text,
    vote_credits_per_user integer DEFAULT 100,
    voting_opens_at timestamp with time zone,
    voting_closes_at timestamp with time zone,
    proposals_open_at timestamp with time zone,
    proposals_close_at timestamp with time zone,
    allowed_formats text[] DEFAULT ARRAY['talk'::text, 'workshop'::text, 'discussion'::text, 'panel'::text, 'demo'::text],
    allowed_durations integer[] DEFAULT ARRAY[15, 30, 60, 90],
    max_proposals_per_user integer DEFAULT 5,
    require_proposal_approval boolean DEFAULT true,
    max_attendees integer,
    theme jsonb DEFAULT '{}'::jsonb,
    logo_url text,
    banner_url text,
    favicon_url text,
    created_by uuid,
    is_featured boolean DEFAULT false,
    visibility text DEFAULT 'public'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    schedule_published_at timestamp with time zone,
    last_schedule_change_at timestamp with time zone,
    ticketing_enabled boolean DEFAULT false NOT NULL,
    stripe_account_id text,
    suggested_topics text[],
    voting_mechanism text DEFAULT 'quadratic'::text NOT NULL,
    actor_did text,
    actor_handle text,
    gathering_uri text,
    gathering_cid text,
    calendar_event_uri text,
    calendar_event_cid text,
    policy_uri text,
    atproto_published_at timestamp with time zone,
    atproto_tags text[] DEFAULT '{}'::text[],
    CONSTRAINT events_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'proposals_open'::text, 'voting_open'::text, 'scheduling'::text, 'live'::text, 'completed'::text, 'archived'::text]))),
    CONSTRAINT events_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text, 'private'::text]))),
    CONSTRAINT events_voting_mechanism_check CHECK ((voting_mechanism = ANY (ARRAY['quadratic'::text, 'linear'::text, 'approval'::text])))
);

-- comment: COLUMN events.status

COMMENT ON COLUMN public.events.status IS 'Event lifecycle status: draft -> published -> proposals_open -> voting_open -> scheduling -> live -> completed -> archived';

-- comment: COLUMN events.suggested_topics

COMMENT ON COLUMN public.events.suggested_topics IS 'Suggested interest topics for this event, defined by the organizer in the creation wizard. Shown in onboarding and proposal forms.';

-- table: favorites

CREATE TABLE public.favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    event_id uuid NOT NULL
);

-- table: notification_preferences

CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    event_id uuid,
    category character varying(50) NOT NULL,
    email_enabled boolean DEFAULT true NOT NULL,
    in_app_enabled boolean DEFAULT true NOT NULL,
    push_enabled boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT valid_preference_category CHECK (((category)::text = ANY ((ARRAY['session_updates'::character varying, 'voting_updates'::character varying, 'collaboration'::character varying, 'event_announcements'::character varying, 'admin_alerts'::character varying])::text[])))
);

-- table: notifications

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    event_id uuid,
    type character varying(50) NOT NULL,
    title text NOT NULL,
    body text,
    data jsonb DEFAULT '{}'::jsonb,
    action_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    read_at timestamp with time zone,
    email_sent_at timestamp with time zone,
    push_sent_at timestamp with time zone,
    CONSTRAINT valid_notification_type CHECK (((type)::text = ANY ((ARRAY['session_submitted'::character varying, 'session_approved'::character varying, 'session_rejected'::character varying, 'session_scheduled'::character varying, 'session_rescheduled'::character varying, 'session_cancelled'::character varying, 'vote_milestone'::character varying, 'cohost_invited'::character varying, 'cohost_accepted'::character varying, 'cohost_declined'::character varying, 'voting_opened'::character varying, 'voting_closed'::character varying, 'schedule_published'::character varying, 'event_reminder'::character varying, 'admin_announcement'::character varying, 'new_proposal'::character varying, 'proposal_needs_review'::character varying])::text[])))
);

-- table: profiles

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text NOT NULL,
    display_name text,
    bio text,
    avatar_url text,
    affiliation text,
    building text,
    telegram text,
    interests text[],
    is_admin boolean DEFAULT false,
    onboarding_completed boolean DEFAULT false,
    vote_credits integer DEFAULT 100,
    created_at timestamp with time zone DEFAULT now(),
    ens text,
    did text,
    atproto_handle text,
    atproto_linked_at timestamp with time zone,
    publish_proposals boolean DEFAULT false NOT NULL
);

-- comment: COLUMN profiles.ens

COMMENT ON COLUMN public.profiles.ens IS 'User ENS name (e.g., yourname.eth)';

-- table: session_cohosts

CREATE TABLE public.session_cohosts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    display_order integer DEFAULT 0,
    added_at timestamp with time zone DEFAULT now(),
    event_id uuid NOT NULL,
    cohost_uri text
);

-- table: session_feedback

CREATE TABLE public.session_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    rating smallint NOT NULL,
    comment text,
    would_attend_again boolean,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_feedback_comment_check CHECK (((comment IS NULL) OR (char_length(comment) <= 2000))),
    CONSTRAINT session_feedback_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

-- table: session_resources

CREATE TABLE public.session_resources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    session_id uuid NOT NULL,
    added_by uuid,
    title text NOT NULL,
    url text NOT NULL,
    kind text DEFAULT 'link'::text NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT session_resources_kind_check CHECK ((kind = ANY (ARRAY['slides'::text, 'recording'::text, 'notes'::text, 'link'::text, 'repo'::text]))),
    CONSTRAINT session_resources_title_check CHECK (((char_length(title) >= 1) AND (char_length(title) <= 200))),
    CONSTRAINT session_resources_url_check CHECK (((url ~* '^https?://'::text) AND (char_length(url) <= 2048)))
);

-- table: session_rsvps

CREATE TABLE public.session_rsvps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    session_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'confirmed'::text NOT NULL,
    waitlist_position integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    rsvp_uri text,
    CONSTRAINT session_rsvps_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'waitlist'::text, 'cancelled'::text])))
);

-- table: sessions

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    format text,
    duration integer DEFAULT 60,
    host_id uuid,
    host_name text,
    topic_tags text[],
    status text DEFAULT 'pending'::text,
    venue_id uuid,
    time_slot_id uuid,
    is_self_hosted boolean DEFAULT false,
    custom_location text,
    total_votes integer DEFAULT 0,
    total_credits integer DEFAULT 0,
    voter_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    track_id uuid,
    session_type text DEFAULT 'proposed'::text,
    is_votable boolean DEFAULT true,
    time_preferences text[],
    self_hosted_start_time timestamp with time zone,
    self_hosted_end_time timestamp with time zone,
    telegram_group_url text,
    host_notified_at timestamp with time zone,
    event_id uuid NOT NULL,
    rsvp_count integer DEFAULT 0 NOT NULL,
    waitlist_count integer DEFAULT 0 NOT NULL,
    expected_attendance integer,
    required_features text[] DEFAULT ARRAY[]::text[],
    rejection_reason text,
    host_did text,
    proposal_uri text,
    proposal_cid text,
    calendar_event_uri text,
    calendar_event_cid text,
    slot_uri text,
    slot_cid text,
    atproto_published_at timestamp with time zone,
    imported_from text,
    CONSTRAINT sessions_expected_attendance_check CHECK (((expected_attendance IS NULL) OR (expected_attendance > 0))),
    CONSTRAINT sessions_format_check CHECK ((format = ANY (ARRAY['talk'::text, 'workshop'::text, 'discussion'::text, 'panel'::text, 'demo'::text, 'fireside'::text, 'ceremony'::text]))),
    CONSTRAINT sessions_session_type_check CHECK ((session_type = ANY (ARRAY['curated'::text, 'proposed'::text, 'workshop'::text, 'track_reserved'::text]))),
    CONSTRAINT sessions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'scheduled'::text])))
);

-- comment: COLUMN sessions.expected_attendance

COMMENT ON COLUMN public.sessions.expected_attendance IS 'Expected number of attendees, used for venue capacity matching';

-- comment: COLUMN sessions.required_features

COMMENT ON COLUMN public.sessions.required_features IS 'Array of venue feature tags required for this session (e.g., projector, whiteboard, microphone)';

-- table: ticket_tiers

CREATE TABLE public.ticket_tiers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    price_cents integer DEFAULT 0 NOT NULL,
    currency text DEFAULT 'usd'::text NOT NULL,
    quantity_total integer,
    quantity_sold integer DEFAULT 0 NOT NULL,
    sale_starts_at timestamp with time zone,
    sale_ends_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    display_order integer DEFAULT 0 NOT NULL,
    allows_proposals boolean DEFAULT true NOT NULL,
    allows_voting boolean DEFAULT true NOT NULL,
    vote_credits_override integer,
    stripe_price_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- table: tickets

CREATE TABLE public.tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    tier_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    qr_code text,
    qr_generated_at timestamp with time zone,
    checked_in_at timestamp with time zone,
    checked_in_by uuid,
    payment_intent_id text,
    amount_paid_cents integer,
    payment_confirmed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'cancelled'::text, 'checked_in'::text])))
);

-- table: time_slots

CREATE TABLE public.time_slots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    start_time timestamp with time zone NOT NULL,
    end_time timestamp with time zone NOT NULL,
    label text,
    is_break boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    venue_id uuid,
    day_date date,
    slot_type text DEFAULT 'session'::text,
    event_id uuid NOT NULL,
    CONSTRAINT time_slots_slot_type_check CHECK ((slot_type = ANY (ARRAY['session'::text, 'break'::text, 'checkin'::text, 'unconference'::text, 'track'::text])))
);

-- table: tracks

CREATE TABLE public.tracks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    color text,
    lead_name text,
    lead_email text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    event_id uuid NOT NULL,
    lead_user_id uuid,
    max_sessions integer,
    display_order integer DEFAULT 0,
    at_uri text,
    at_cid text
);

-- table: venues

CREATE TABLE public.venues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    capacity integer,
    features text[],
    created_at timestamp with time zone DEFAULT now(),
    slug text,
    style text,
    address text,
    notes text,
    is_primary boolean DEFAULT false,
    event_id uuid NOT NULL,
    at_uri text,
    at_cid text
);

-- table: votes

CREATE TABLE public.votes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid NOT NULL,
    credits_spent integer NOT NULL,
    vote_count integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    event_id uuid NOT NULL,
    CONSTRAINT votes_credits_spent_check CHECK ((credits_spent > 0)),
    CONSTRAINT votes_vote_count_check CHECK ((vote_count > 0))
);

-- constraint: at_audit at_audit_pkey

ALTER TABLE ONLY public.at_audit
    ADD CONSTRAINT at_audit_pkey PRIMARY KEY (id);

-- constraint: at_credentials at_credentials_pkey

ALTER TABLE ONLY public.at_credentials
    ADD CONSTRAINT at_credentials_pkey PRIMARY KEY (did);

-- constraint: at_oauth_client_key at_oauth_client_key_pkey

ALTER TABLE ONLY public.at_oauth_client_key
    ADD CONSTRAINT at_oauth_client_key_pkey PRIMARY KEY (kid);

-- constraint: at_oauth_session at_oauth_session_pkey

ALTER TABLE ONLY public.at_oauth_session
    ADD CONSTRAINT at_oauth_session_pkey PRIMARY KEY (sub);

-- constraint: at_oauth_state at_oauth_state_pkey

ALTER TABLE ONLY public.at_oauth_state
    ADD CONSTRAINT at_oauth_state_pkey PRIMARY KEY (key);

-- constraint: at_records at_records_pkey

ALTER TABLE ONLY public.at_records
    ADD CONSTRAINT at_records_pkey PRIMARY KEY (uri);

-- constraint: at_sessions at_sessions_pkey

ALTER TABLE ONLY public.at_sessions
    ADD CONSTRAINT at_sessions_pkey PRIMARY KEY (id);

-- constraint: at_slot_grids at_slot_grids_event_id_venue_id_day_date_key

ALTER TABLE ONLY public.at_slot_grids
    ADD CONSTRAINT at_slot_grids_event_id_venue_id_day_date_key UNIQUE (event_id, venue_id, day_date);

-- constraint: at_slot_grids at_slot_grids_pkey

ALTER TABLE ONLY public.at_slot_grids
    ADD CONSTRAINT at_slot_grids_pkey PRIMARY KEY (id);

-- constraint: at_sync_cursor at_sync_cursor_pkey

ALTER TABLE ONLY public.at_sync_cursor
    ADD CONSTRAINT at_sync_cursor_pkey PRIMARY KEY (source);

-- constraint: cohost_invites cohost_invites_pkey

ALTER TABLE ONLY public.cohost_invites
    ADD CONSTRAINT cohost_invites_pkey PRIMARY KEY (id);

-- constraint: cohost_invites cohost_invites_token_key

ALTER TABLE ONLY public.cohost_invites
    ADD CONSTRAINT cohost_invites_token_key UNIQUE (token);

-- constraint: event_invitations event_invitations_pkey

ALTER TABLE ONLY public.event_invitations
    ADD CONSTRAINT event_invitations_pkey PRIMARY KEY (id);

-- constraint: event_invitations event_invitations_token_key

ALTER TABLE ONLY public.event_invitations
    ADD CONSTRAINT event_invitations_token_key UNIQUE (token);

-- constraint: event_members event_members_event_id_user_id_key

ALTER TABLE ONLY public.event_members
    ADD CONSTRAINT event_members_event_id_user_id_key UNIQUE (event_id, user_id);

-- constraint: event_members event_members_pkey

ALTER TABLE ONLY public.event_members
    ADD CONSTRAINT event_members_pkey PRIMARY KEY (id);

-- constraint: events events_pkey

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);

-- constraint: events events_slug_key

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_slug_key UNIQUE (slug);

-- constraint: favorites favorites_pkey

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_pkey PRIMARY KEY (id);

-- constraint: favorites favorites_user_id_session_id_key

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_user_id_session_id_key UNIQUE (user_id, session_id);

-- constraint: notification_preferences notification_preferences_pkey

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);

-- constraint: notification_preferences notification_preferences_user_id_event_id_category_key

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_event_id_category_key UNIQUE (user_id, event_id, category);

-- constraint: notifications notifications_pkey

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);

-- constraint: profiles profiles_pkey

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);

-- constraint: session_cohosts session_cohosts_pkey

ALTER TABLE ONLY public.session_cohosts
    ADD CONSTRAINT session_cohosts_pkey PRIMARY KEY (id);

-- constraint: session_cohosts session_cohosts_session_id_user_id_key

ALTER TABLE ONLY public.session_cohosts
    ADD CONSTRAINT session_cohosts_session_id_user_id_key UNIQUE (session_id, user_id);

-- constraint: session_feedback session_feedback_pkey

ALTER TABLE ONLY public.session_feedback
    ADD CONSTRAINT session_feedback_pkey PRIMARY KEY (id);

-- constraint: session_feedback session_feedback_session_id_user_id_key

ALTER TABLE ONLY public.session_feedback
    ADD CONSTRAINT session_feedback_session_id_user_id_key UNIQUE (session_id, user_id);

-- constraint: session_resources session_resources_pkey

ALTER TABLE ONLY public.session_resources
    ADD CONSTRAINT session_resources_pkey PRIMARY KEY (id);

-- constraint: session_rsvps session_rsvps_pkey

ALTER TABLE ONLY public.session_rsvps
    ADD CONSTRAINT session_rsvps_pkey PRIMARY KEY (id);

-- constraint: session_rsvps session_rsvps_session_id_user_id_key

ALTER TABLE ONLY public.session_rsvps
    ADD CONSTRAINT session_rsvps_session_id_user_id_key UNIQUE (session_id, user_id);

-- constraint: sessions sessions_pkey

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);

-- constraint: ticket_tiers ticket_tiers_pkey

ALTER TABLE ONLY public.ticket_tiers
    ADD CONSTRAINT ticket_tiers_pkey PRIMARY KEY (id);

-- constraint: tickets tickets_pkey

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);

-- constraint: tickets tickets_qr_code_key

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_qr_code_key UNIQUE (qr_code);

-- constraint: time_slots time_slots_pkey

ALTER TABLE ONLY public.time_slots
    ADD CONSTRAINT time_slots_pkey PRIMARY KEY (id);

-- constraint: tracks tracks_event_slug_unique

ALTER TABLE ONLY public.tracks
    ADD CONSTRAINT tracks_event_slug_unique UNIQUE (event_id, slug);

-- constraint: tracks tracks_pkey

ALTER TABLE ONLY public.tracks
    ADD CONSTRAINT tracks_pkey PRIMARY KEY (id);

-- constraint: venues venues_event_slug_unique

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_event_slug_unique UNIQUE (event_id, slug);

-- constraint: venues venues_pkey

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_pkey PRIMARY KEY (id);

-- constraint: votes votes_pkey

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_pkey PRIMARY KEY (id);

-- constraint: votes votes_user_id_session_id_key

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_user_id_session_id_key UNIQUE (user_id, session_id);

-- index: at_audit_event_id_idx

CREATE INDEX at_audit_event_id_idx ON public.at_audit USING btree (event_id, created_at DESC);

-- index: at_records_collection_did_idx

CREATE INDEX at_records_collection_did_idx ON public.at_records USING btree (collection, did);

-- index: at_sessions_did_idx

CREATE INDEX at_sessions_did_idx ON public.at_sessions USING btree (did);

-- index: at_sessions_expires_at_idx

CREATE INDEX at_sessions_expires_at_idx ON public.at_sessions USING btree (expires_at);

-- index: at_slot_grids_event_id_idx

CREATE INDEX at_slot_grids_event_id_idx ON public.at_slot_grids USING btree (event_id);

-- index: events_actor_did_idx

CREATE INDEX events_actor_did_idx ON public.events USING btree (actor_did) WHERE (actor_did IS NOT NULL);

-- index: idx_cohost_invites_session

CREATE INDEX idx_cohost_invites_session ON public.cohost_invites USING btree (session_id);

-- index: idx_cohost_invites_token

CREATE INDEX idx_cohost_invites_token ON public.cohost_invites USING btree (token);

-- index: idx_event_invitations_email

CREATE INDEX idx_event_invitations_email ON public.event_invitations USING btree (email) WHERE (email IS NOT NULL);

-- index: idx_event_invitations_event

CREATE INDEX idx_event_invitations_event ON public.event_invitations USING btree (event_id);

-- index: idx_event_invitations_token

CREATE INDEX idx_event_invitations_token ON public.event_invitations USING btree (token);

-- index: idx_event_members_event

CREATE INDEX idx_event_members_event ON public.event_members USING btree (event_id);

-- index: idx_event_members_role

CREATE INDEX idx_event_members_role ON public.event_members USING btree (event_id, role);

-- index: idx_event_members_user

CREATE INDEX idx_event_members_user ON public.event_members USING btree (user_id);

-- index: idx_events_schedule_published

CREATE INDEX idx_events_schedule_published ON public.events USING btree (schedule_published_at) WHERE (schedule_published_at IS NOT NULL);

-- index: idx_events_status

CREATE INDEX idx_events_status ON public.events USING btree (status);

-- index: idx_favorites_event

CREATE INDEX idx_favorites_event ON public.favorites USING btree (event_id);

-- index: idx_favorites_user

CREATE INDEX idx_favorites_user ON public.favorites USING btree (user_id);

-- index: idx_notification_preferences_event

CREATE INDEX idx_notification_preferences_event ON public.notification_preferences USING btree (user_id, event_id) WHERE (event_id IS NOT NULL);

-- index: idx_notification_preferences_user

CREATE INDEX idx_notification_preferences_user ON public.notification_preferences USING btree (user_id);

-- index: idx_notifications_event

CREATE INDEX idx_notifications_event ON public.notifications USING btree (event_id, created_at DESC) WHERE (event_id IS NOT NULL);

-- index: idx_notifications_pending_email

CREATE INDEX idx_notifications_pending_email ON public.notifications USING btree (created_at) WHERE (email_sent_at IS NULL);

-- index: idx_notifications_user_all

CREATE INDEX idx_notifications_user_all ON public.notifications USING btree (user_id, created_at DESC);

-- index: idx_notifications_user_unread

CREATE INDEX idx_notifications_user_unread ON public.notifications USING btree (user_id, created_at DESC) WHERE (read_at IS NULL);

-- index: idx_session_cohosts_session

CREATE INDEX idx_session_cohosts_session ON public.session_cohosts USING btree (session_id);

-- index: idx_session_cohosts_user

CREATE INDEX idx_session_cohosts_user ON public.session_cohosts USING btree (user_id);

-- index: idx_session_feedback_event

CREATE INDEX idx_session_feedback_event ON public.session_feedback USING btree (event_id);

-- index: idx_session_feedback_session

CREATE INDEX idx_session_feedback_session ON public.session_feedback USING btree (session_id);

-- index: idx_session_feedback_user

CREATE INDEX idx_session_feedback_user ON public.session_feedback USING btree (user_id);

-- index: idx_session_resources_event

CREATE INDEX idx_session_resources_event ON public.session_resources USING btree (event_id);

-- index: idx_session_resources_session

CREATE INDEX idx_session_resources_session ON public.session_resources USING btree (session_id, display_order);

-- index: idx_session_rsvps_event

CREATE INDEX idx_session_rsvps_event ON public.session_rsvps USING btree (event_id);

-- index: idx_session_rsvps_session

CREATE INDEX idx_session_rsvps_session ON public.session_rsvps USING btree (session_id, status);

-- index: idx_session_rsvps_user

CREATE INDEX idx_session_rsvps_user ON public.session_rsvps USING btree (user_id);

-- index: idx_sessions_event_status

CREATE INDEX idx_sessions_event_status ON public.sessions USING btree (event_id, status);

-- index: idx_sessions_event_votes

CREATE INDEX idx_sessions_event_votes ON public.sessions USING btree (event_id, total_votes DESC);

-- index: idx_sessions_required_features

CREATE INDEX idx_sessions_required_features ON public.sessions USING gin (required_features);

-- index: idx_sessions_status

CREATE INDEX idx_sessions_status ON public.sessions USING btree (status);

-- index: idx_sessions_total_votes

CREATE INDEX idx_sessions_total_votes ON public.sessions USING btree (total_votes DESC);

-- index: idx_sessions_track

CREATE INDEX idx_sessions_track ON public.sessions USING btree (track_id);

-- index: idx_ticket_tiers_event

CREATE INDEX idx_ticket_tiers_event ON public.ticket_tiers USING btree (event_id, is_active);

-- index: idx_tickets_event

CREATE INDEX idx_tickets_event ON public.tickets USING btree (event_id, status);

-- index: idx_tickets_payment

CREATE INDEX idx_tickets_payment ON public.tickets USING btree (payment_intent_id);

-- index: idx_tickets_qr

CREATE INDEX idx_tickets_qr ON public.tickets USING btree (qr_code);

-- index: idx_tickets_user

CREATE INDEX idx_tickets_user ON public.tickets USING btree (user_id);

-- index: idx_time_slots_event

CREATE INDEX idx_time_slots_event ON public.time_slots USING btree (event_id);

-- index: idx_time_slots_venue_day

CREATE INDEX idx_time_slots_venue_day ON public.time_slots USING btree (venue_id, day_date);

-- index: idx_tracks_event

CREATE INDEX idx_tracks_event ON public.tracks USING btree (event_id);

-- index: idx_venues_event

CREATE INDEX idx_venues_event ON public.venues USING btree (event_id);

-- index: idx_votes_event_user

CREATE INDEX idx_votes_event_user ON public.votes USING btree (event_id, user_id);

-- index: idx_votes_session

CREATE INDEX idx_votes_session ON public.votes USING btree (session_id);

-- index: idx_votes_user

CREATE INDEX idx_votes_user ON public.votes USING btree (user_id);

-- index: profiles_did_key

CREATE UNIQUE INDEX profiles_did_key ON public.profiles USING btree (did) WHERE (did IS NOT NULL);

-- index: sessions_host_did_idx

CREATE INDEX sessions_host_did_idx ON public.sessions USING btree (host_did) WHERE (host_did IS NOT NULL);

-- index: sessions_proposal_uri_key

CREATE UNIQUE INDEX sessions_proposal_uri_key ON public.sessions USING btree (proposal_uri) WHERE (proposal_uri IS NOT NULL);

-- trigger: sessions enforce_event_proposal_rules

CREATE TRIGGER enforce_event_proposal_rules BEFORE INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.enforce_event_proposal_rules();

-- trigger: votes enforce_event_vote_rules

CREATE TRIGGER enforce_event_vote_rules BEFORE INSERT OR DELETE OR UPDATE ON public.votes FOR EACH ROW EXECUTE FUNCTION public.enforce_event_vote_rules();

-- trigger: sessions enforce_session_update_rules

CREATE TRIGGER enforce_session_update_rules BEFORE UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.enforce_session_update_rules();

-- trigger: cohost_invites fill_cohost_event_id

CREATE TRIGGER fill_cohost_event_id BEFORE INSERT ON public.cohost_invites FOR EACH ROW EXECUTE FUNCTION public.fill_cohost_event_id();

-- trigger: session_cohosts fill_cohost_event_id

CREATE TRIGGER fill_cohost_event_id BEFORE INSERT ON public.session_cohosts FOR EACH ROW EXECUTE FUNCTION public.fill_cohost_event_id();

-- trigger: votes on_vote_change

CREATE TRIGGER on_vote_change AFTER INSERT OR DELETE OR UPDATE ON public.votes FOR EACH ROW EXECUTE FUNCTION public.update_session_vote_counts();

-- trigger: notification_preferences set_notification_preferences_updated_at

CREATE TRIGGER set_notification_preferences_updated_at BEFORE UPDATE ON public.notification_preferences FOR EACH ROW EXECUTE FUNCTION public.update_notification_preferences_updated_at();

-- trigger: tickets trigger_add_ticket_holder_as_member

CREATE TRIGGER trigger_add_ticket_holder_as_member AFTER INSERT OR UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.add_ticket_holder_as_member();

-- trigger: cohost_invites trigger_cohost_response

CREATE TRIGGER trigger_cohost_response AFTER UPDATE ON public.cohost_invites FOR EACH ROW EXECUTE FUNCTION public.notify_cohost_response();

-- trigger: sessions trigger_new_proposal

CREATE TRIGGER trigger_new_proposal AFTER INSERT ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.notify_new_proposal();

-- trigger: session_rsvps trigger_promote_from_waitlist

CREATE TRIGGER trigger_promote_from_waitlist AFTER DELETE OR UPDATE ON public.session_rsvps FOR EACH ROW EXECUTE FUNCTION public.promote_from_waitlist();

-- trigger: session_feedback trigger_session_feedback_event_id

CREATE TRIGGER trigger_session_feedback_event_id BEFORE INSERT ON public.session_feedback FOR EACH ROW EXECUTE FUNCTION public.set_event_id_from_session();

-- trigger: session_feedback trigger_session_feedback_window

CREATE TRIGGER trigger_session_feedback_window BEFORE INSERT OR UPDATE ON public.session_feedback FOR EACH ROW EXECUTE FUNCTION public.enforce_session_feedback_window();

-- trigger: session_resources trigger_session_resources_event_id

CREATE TRIGGER trigger_session_resources_event_id BEFORE INSERT ON public.session_resources FOR EACH ROW EXECUTE FUNCTION public.set_event_id_from_session();

-- trigger: sessions trigger_session_status_change

CREATE TRIGGER trigger_session_status_change AFTER UPDATE ON public.sessions FOR EACH ROW WHEN ((new.host_id IS NOT NULL)) EXECUTE FUNCTION public.notify_session_status_change();

-- trigger: sessions trigger_update_event_schedule_change

CREATE TRIGGER trigger_update_event_schedule_change AFTER INSERT OR DELETE OR UPDATE ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.update_event_schedule_change();

-- trigger: session_rsvps trigger_update_session_rsvp_counts

CREATE TRIGGER trigger_update_session_rsvp_counts AFTER INSERT OR DELETE OR UPDATE ON public.session_rsvps FOR EACH ROW EXECUTE FUNCTION public.update_session_rsvp_counts();

-- trigger: tickets trigger_update_tier_quantity_sold

CREATE TRIGGER trigger_update_tier_quantity_sold AFTER INSERT OR UPDATE ON public.tickets FOR EACH ROW EXECUTE FUNCTION public.update_tier_quantity_sold();

-- trigger: sessions trigger_vote_milestone

CREATE TRIGGER trigger_vote_milestone AFTER UPDATE OF total_votes ON public.sessions FOR EACH ROW EXECUTE FUNCTION public.notify_vote_milestone();

-- fk constraint: at_audit at_audit_event_id_fkey

ALTER TABLE ONLY public.at_audit
    ADD CONSTRAINT at_audit_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE SET NULL;

-- fk constraint: at_sessions at_sessions_user_id_fkey

ALTER TABLE ONLY public.at_sessions
    ADD CONSTRAINT at_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

-- fk constraint: at_slot_grids at_slot_grids_event_id_fkey

ALTER TABLE ONLY public.at_slot_grids
    ADD CONSTRAINT at_slot_grids_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: at_slot_grids at_slot_grids_venue_id_fkey

ALTER TABLE ONLY public.at_slot_grids
    ADD CONSTRAINT at_slot_grids_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

-- fk constraint: cohost_invites cohost_invites_accepted_by_fkey

ALTER TABLE ONLY public.cohost_invites
    ADD CONSTRAINT cohost_invites_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- fk constraint: cohost_invites cohost_invites_created_by_fkey

ALTER TABLE ONLY public.cohost_invites
    ADD CONSTRAINT cohost_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- fk constraint: cohost_invites cohost_invites_event_id_fkey

ALTER TABLE ONLY public.cohost_invites
    ADD CONSTRAINT cohost_invites_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: cohost_invites cohost_invites_session_id_fkey

ALTER TABLE ONLY public.cohost_invites
    ADD CONSTRAINT cohost_invites_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

-- fk constraint: event_invitations event_invitations_created_by_fkey

ALTER TABLE ONLY public.event_invitations
    ADD CONSTRAINT event_invitations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.accounts(id);

-- fk constraint: event_invitations event_invitations_event_id_fkey

ALTER TABLE ONLY public.event_invitations
    ADD CONSTRAINT event_invitations_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: event_members event_members_event_id_fkey

ALTER TABLE ONLY public.event_members
    ADD CONSTRAINT event_members_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: event_members event_members_user_id_fkey

ALTER TABLE ONLY public.event_members
    ADD CONSTRAINT event_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- fk constraint: events events_created_by_fkey

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);

-- fk constraint: favorites favorites_event_id_fkey

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: favorites favorites_session_id_fkey

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

-- fk constraint: favorites favorites_user_id_fkey

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- fk constraint: notification_preferences notification_preferences_event_id_fkey

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: notification_preferences notification_preferences_user_id_fkey

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

-- fk constraint: notifications notifications_event_id_fkey

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: notifications notifications_user_id_fkey

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.accounts(id) ON DELETE CASCADE;

-- fk constraint: profiles profiles_id_fkey

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES public.accounts(id) ON DELETE CASCADE;

-- fk constraint: session_cohosts session_cohosts_event_id_fkey

ALTER TABLE ONLY public.session_cohosts
    ADD CONSTRAINT session_cohosts_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: session_cohosts session_cohosts_session_id_fkey

ALTER TABLE ONLY public.session_cohosts
    ADD CONSTRAINT session_cohosts_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

-- fk constraint: session_cohosts session_cohosts_user_id_fkey

ALTER TABLE ONLY public.session_cohosts
    ADD CONSTRAINT session_cohosts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- fk constraint: session_feedback session_feedback_event_id_fkey

ALTER TABLE ONLY public.session_feedback
    ADD CONSTRAINT session_feedback_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: session_feedback session_feedback_session_id_fkey

ALTER TABLE ONLY public.session_feedback
    ADD CONSTRAINT session_feedback_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

-- fk constraint: session_feedback session_feedback_user_id_fkey

ALTER TABLE ONLY public.session_feedback
    ADD CONSTRAINT session_feedback_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- fk constraint: session_resources session_resources_added_by_fkey

ALTER TABLE ONLY public.session_resources
    ADD CONSTRAINT session_resources_added_by_fkey FOREIGN KEY (added_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- fk constraint: session_resources session_resources_event_id_fkey

ALTER TABLE ONLY public.session_resources
    ADD CONSTRAINT session_resources_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: session_resources session_resources_session_id_fkey

ALTER TABLE ONLY public.session_resources
    ADD CONSTRAINT session_resources_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

-- fk constraint: session_rsvps session_rsvps_event_id_fkey

ALTER TABLE ONLY public.session_rsvps
    ADD CONSTRAINT session_rsvps_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: session_rsvps session_rsvps_session_id_fkey

ALTER TABLE ONLY public.session_rsvps
    ADD CONSTRAINT session_rsvps_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

-- fk constraint: session_rsvps session_rsvps_user_id_fkey

ALTER TABLE ONLY public.session_rsvps
    ADD CONSTRAINT session_rsvps_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- fk constraint: sessions sessions_event_id_fkey

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: sessions sessions_host_id_fkey

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_host_id_fkey FOREIGN KEY (host_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- fk constraint: sessions sessions_time_slot_id_fkey

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_time_slot_id_fkey FOREIGN KEY (time_slot_id) REFERENCES public.time_slots(id) ON DELETE SET NULL;

-- fk constraint: sessions sessions_track_id_fkey

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_track_id_fkey FOREIGN KEY (track_id) REFERENCES public.tracks(id) ON DELETE SET NULL;

-- fk constraint: sessions sessions_venue_id_fkey

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE SET NULL;

-- fk constraint: ticket_tiers ticket_tiers_event_id_fkey

ALTER TABLE ONLY public.ticket_tiers
    ADD CONSTRAINT ticket_tiers_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: tickets tickets_checked_in_by_fkey

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_checked_in_by_fkey FOREIGN KEY (checked_in_by) REFERENCES public.profiles(id);

-- fk constraint: tickets tickets_event_id_fkey

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: tickets tickets_tier_id_fkey

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_tier_id_fkey FOREIGN KEY (tier_id) REFERENCES public.ticket_tiers(id) ON DELETE RESTRICT;

-- fk constraint: tickets tickets_user_id_fkey

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- fk constraint: time_slots time_slots_event_id_fkey

ALTER TABLE ONLY public.time_slots
    ADD CONSTRAINT time_slots_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: time_slots time_slots_venue_id_fkey

ALTER TABLE ONLY public.time_slots
    ADD CONSTRAINT time_slots_venue_id_fkey FOREIGN KEY (venue_id) REFERENCES public.venues(id) ON DELETE CASCADE;

-- fk constraint: tracks tracks_event_id_fkey

ALTER TABLE ONLY public.tracks
    ADD CONSTRAINT tracks_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: tracks tracks_lead_user_id_fkey

ALTER TABLE ONLY public.tracks
    ADD CONSTRAINT tracks_lead_user_id_fkey FOREIGN KEY (lead_user_id) REFERENCES public.profiles(id);

-- fk constraint: venues venues_event_id_fkey

ALTER TABLE ONLY public.venues
    ADD CONSTRAINT venues_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: votes votes_event_id_fkey

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE;

-- fk constraint: votes votes_session_id_fkey

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE;

-- fk constraint: votes votes_user_id_fkey

ALTER TABLE ONLY public.votes
    ADD CONSTRAINT votes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;

-- policy: session_rsvps Admins can manage all RSVPs

CREATE POLICY "Admins can manage all RSVPs" ON public.session_rsvps USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = session_rsvps.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: cohost_invites Admins can manage cohost invites

CREATE POLICY "Admins can manage cohost invites" ON public.cohost_invites USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));

-- policy: ticket_tiers Admins can manage ticket tiers

CREATE POLICY "Admins can manage ticket tiers" ON public.ticket_tiers USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = ticket_tiers.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: tracks Admins can manage tracks

CREATE POLICY "Admins can manage tracks" ON public.tracks USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));

-- policy: tickets Admins can view all event tickets

CREATE POLICY "Admins can view all event tickets" ON public.tickets FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = tickets.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: sessions Anyone can view approved sessions

CREATE POLICY "Anyone can view approved sessions" ON public.sessions FOR SELECT USING (((status = ANY (ARRAY['approved'::text, 'scheduled'::text])) OR (host_id = auth.uid())));

-- policy: event_members Anyone can view public event members

CREATE POLICY "Anyone can view public event members" ON public.event_members FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_members.event_id) AND (e.visibility = 'public'::text)))));

-- policy: events Anyone can view public events

CREATE POLICY "Anyone can view public events" ON public.events FOR SELECT USING ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])));

-- policy: session_cohosts Anyone can view session cohosts

CREATE POLICY "Anyone can view session cohosts" ON public.session_cohosts FOR SELECT USING (true);

-- policy: session_resources Anyone who can view the session can view resources

CREATE POLICY "Anyone who can view the session can view resources" ON public.session_resources FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.sessions s
  WHERE (s.id = session_resources.session_id))));

-- policy: events Authenticated users can create events

CREATE POLICY "Authenticated users can create events" ON public.events FOR INSERT WITH CHECK (((auth.uid() IS NOT NULL) AND (created_by = auth.uid())));

-- policy: session_cohosts Cohost event visibility boundary

CREATE POLICY "Cohost event visibility boundary" ON public.session_cohosts AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (public.can_read_session_event(session_id));

-- policy: session_cohosts Cohosts can remove themselves

CREATE POLICY "Cohosts can remove themselves" ON public.session_cohosts FOR DELETE USING ((user_id = auth.uid()));

-- policy: sessions Cohosts can view their pending sessions

CREATE POLICY "Cohosts can view their pending sessions" ON public.sessions FOR SELECT USING (((status = 'pending'::text) AND public.is_session_cohost(id)));

-- policy: event_invitations Event admins can create invitations

CREATE POLICY "Event admins can create invitations" ON public.event_invitations FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = event_invitations.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))) AND (created_by = auth.uid())));

-- policy: event_invitations Event admins can delete invitations

CREATE POLICY "Event admins can delete invitations" ON public.event_invitations FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = event_invitations.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: event_members Event admins can delete members

CREATE POLICY "Event admins can delete members" ON public.event_members FOR DELETE TO authenticated USING (((public.event_role(event_id) = ANY (ARRAY['owner'::text, 'admin'::text])) AND ((role <> 'owner'::text) OR (public.event_role(event_id) = 'owner'::text))));

-- policy: sessions Event admins can manage sessions

CREATE POLICY "Event admins can manage sessions" ON public.sessions USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = sessions.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: time_slots Event admins can manage time slots

CREATE POLICY "Event admins can manage time slots" ON public.time_slots USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = time_slots.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: tracks Event admins can manage tracks

CREATE POLICY "Event admins can manage tracks" ON public.tracks USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = tracks.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: venues Event admins can manage venues

CREATE POLICY "Event admins can manage venues" ON public.venues USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = venues.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: event_invitations Event admins can update invitations

CREATE POLICY "Event admins can update invitations" ON public.event_invitations FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = event_invitations.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: event_members Event admins can update members

CREATE POLICY "Event admins can update members" ON public.event_members FOR UPDATE TO authenticated USING (((public.event_role(event_id) = ANY (ARRAY['owner'::text, 'admin'::text])) AND ((role <> 'owner'::text) OR (public.event_role(event_id) = 'owner'::text)))) WITH CHECK (((public.event_role(event_id) = ANY (ARRAY['owner'::text, 'admin'::text])) AND ((role <> 'owner'::text) OR (public.event_role(event_id) = 'owner'::text))));

-- policy: event_invitations Event admins can view invitations

CREATE POLICY "Event admins can view invitations" ON public.event_invitations FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = event_invitations.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));

-- policy: sessions Event members can create sessions

CREATE POLICY "Event members can create sessions" ON public.sessions FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = sessions.event_id) AND (event_members.user_id = auth.uid())))));

-- policy: events Event owners can delete their events

CREATE POLICY "Event owners can delete their events" ON public.events FOR DELETE USING ((created_by = auth.uid()));

-- policy: events Event owners can update their events

CREATE POLICY "Event owners can update their events" ON public.events FOR UPDATE USING ((created_by = auth.uid())) WITH CHECK ((created_by = auth.uid()));

-- policy: events Event visibility boundary

CREATE POLICY "Event visibility boundary" ON public.events AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (public.can_read_event(id));

-- policy: cohost_invites Host can create invites

CREATE POLICY "Host can create invites" ON public.cohost_invites FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.sessions
  WHERE ((sessions.id = cohost_invites.session_id) AND (sessions.host_id = auth.uid())))));

-- policy: cohost_invites Host can update invites

CREATE POLICY "Host can update invites" ON public.cohost_invites FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.sessions
  WHERE ((sessions.id = cohost_invites.session_id) AND (sessions.host_id = auth.uid())))));

-- policy: cohost_invites Host can view invites

CREATE POLICY "Host can view invites" ON public.cohost_invites FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.sessions
  WHERE ((sessions.id = cohost_invites.session_id) AND (sessions.host_id = auth.uid())))));

-- policy: sessions Hosts and cohosts can update own sessions

CREATE POLICY "Hosts and cohosts can update own sessions" ON public.sessions FOR UPDATE USING (((host_id = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.session_cohosts
  WHERE ((session_cohosts.session_id = sessions.id) AND (session_cohosts.user_id = auth.uid()))))));

-- policy: session_resources Hosts and organizers can add resources

CREATE POLICY "Hosts and organizers can add resources" ON public.session_resources FOR INSERT WITH CHECK (public.can_manage_session(session_id));

-- policy: session_resources Hosts and organizers can delete resources

CREATE POLICY "Hosts and organizers can delete resources" ON public.session_resources FOR DELETE USING (public.can_manage_session(session_id));

-- policy: session_resources Hosts and organizers can update resources

CREATE POLICY "Hosts and organizers can update resources" ON public.session_resources FOR UPDATE USING (public.can_manage_session(session_id)) WITH CHECK (public.can_manage_session(session_id));

-- policy: session_feedback Hosts and organizers can view session feedback

CREATE POLICY "Hosts and organizers can view session feedback" ON public.session_feedback FOR SELECT USING (public.can_manage_session(session_id));

-- policy: sessions Hosts can delete own sessions

CREATE POLICY "Hosts can delete own sessions" ON public.sessions FOR DELETE USING ((host_id = auth.uid()));

-- policy: events Members can read their event

CREATE POLICY "Members can read their event" ON public.events FOR SELECT TO authenticated USING (public.can_read_event(id));

-- policy: session_rsvps Members can view RSVPs

CREATE POLICY "Members can view RSVPs" ON public.session_rsvps FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = session_rsvps.event_id) AND (event_members.user_id = auth.uid())))));

-- policy: ticket_tiers Members can view all ticket tiers

CREATE POLICY "Members can view all ticket tiers" ON public.ticket_tiers FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = ticket_tiers.event_id) AND (event_members.user_id = auth.uid())))));

-- policy: session_cohosts Organizers can manage session cohosts

CREATE POLICY "Organizers can manage session cohosts" ON public.session_cohosts USING (public.is_session_organizer(session_id)) WITH CHECK (public.is_session_organizer(session_id));

-- policy: events Owners can view their own events

CREATE POLICY "Owners can view their own events" ON public.events FOR SELECT USING ((created_by = auth.uid()));

-- policy: session_cohosts Primary host can add cohosts

CREATE POLICY "Primary host can add cohosts" ON public.session_cohosts FOR INSERT WITH CHECK (public.is_session_host(session_id));

-- policy: session_cohosts Primary host can remove cohosts

CREATE POLICY "Primary host can remove cohosts" ON public.session_cohosts FOR DELETE USING (public.is_session_host(session_id));

-- policy: profiles Profiles viewable by everyone

CREATE POLICY "Profiles viewable by everyone" ON public.profiles FOR SELECT USING (true);

-- policy: ticket_tiers Public can view active ticket tiers

CREATE POLICY "Public can view active ticket tiers" ON public.ticket_tiers FOR SELECT USING (((is_active = true) AND (EXISTS ( SELECT 1
   FROM public.events
  WHERE ((events.id = ticket_tiers.event_id) AND (events.visibility = 'public'::text))))));

-- policy: event_members Roster event visibility boundary

CREATE POLICY "Roster event visibility boundary" ON public.event_members AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (public.can_read_event(event_id));

-- policy: sessions Session event visibility boundary

CREATE POLICY "Session event visibility boundary" ON public.sessions AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (public.can_read_event(event_id));

-- policy: time_slots Time slot event visibility boundary

CREATE POLICY "Time slot event visibility boundary" ON public.time_slots AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (public.can_read_event(event_id));

-- policy: time_slots Time slots viewable by everyone

CREATE POLICY "Time slots viewable by everyone" ON public.time_slots FOR SELECT USING (true);

-- policy: tracks Track event visibility boundary

CREATE POLICY "Track event visibility boundary" ON public.tracks AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (public.can_read_event(event_id));

-- policy: tracks Track leads can manage their tracks

CREATE POLICY "Track leads can manage their tracks" ON public.tracks FOR UPDATE USING (((EXISTS ( SELECT 1
   FROM public.event_members em
  WHERE ((em.event_id = tracks.event_id) AND (em.user_id = auth.uid()) AND (em.role = 'track_lead'::text)))) AND (lead_user_id = auth.uid())));

-- policy: tracks Tracks viewable by everyone

CREATE POLICY "Tracks viewable by everyone" ON public.tracks FOR SELECT USING (true);

-- policy: favorites Users can create favorites

CREATE POLICY "Users can create favorites" ON public.favorites FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = favorites.event_id) AND (event_members.user_id = auth.uid()))))));

-- policy: session_rsvps Users can create own RSVPs

CREATE POLICY "Users can create own RSVPs" ON public.session_rsvps FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = session_rsvps.event_id) AND (event_members.user_id = auth.uid()))))));

-- policy: votes Users can create votes

CREATE POLICY "Users can create votes" ON public.votes FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = votes.event_id) AND (event_members.user_id = auth.uid()))))));

-- policy: session_rsvps Users can delete own RSVPs

CREATE POLICY "Users can delete own RSVPs" ON public.session_rsvps FOR DELETE USING ((user_id = auth.uid()));

-- policy: favorites Users can delete own favorites

CREATE POLICY "Users can delete own favorites" ON public.favorites FOR DELETE USING (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = favorites.event_id) AND (event_members.user_id = auth.uid()))))));

-- policy: session_feedback Users can delete own feedback

CREATE POLICY "Users can delete own feedback" ON public.session_feedback FOR DELETE USING ((user_id = auth.uid()));

-- policy: notification_preferences Users can delete own preferences

CREATE POLICY "Users can delete own preferences" ON public.notification_preferences FOR DELETE USING ((auth.uid() = user_id));

-- policy: votes Users can delete own votes

CREATE POLICY "Users can delete own votes" ON public.votes FOR DELETE USING (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = votes.event_id) AND (event_members.user_id = auth.uid()))))));

-- policy: notification_preferences Users can insert own preferences

CREATE POLICY "Users can insert own preferences" ON public.notification_preferences FOR INSERT WITH CHECK ((auth.uid() = user_id));

-- policy: event_members Users can join public events

CREATE POLICY "Users can join public events" ON public.event_members FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (role = 'attendee'::text) AND (EXISTS ( SELECT 1
   FROM public.events e
  WHERE ((e.id = event_members.event_id) AND (e.visibility = 'public'::text))))));

-- policy: event_members Users can leave events

CREATE POLICY "Users can leave events" ON public.event_members FOR DELETE USING ((user_id = auth.uid()));

-- policy: session_feedback Users can submit own feedback

CREATE POLICY "Users can submit own feedback" ON public.session_feedback FOR INSERT WITH CHECK (((user_id = auth.uid()) AND public.can_read_session_event(session_id)));

-- policy: session_rsvps Users can update own RSVPs

CREATE POLICY "Users can update own RSVPs" ON public.session_rsvps FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));

-- policy: session_feedback Users can update own feedback

CREATE POLICY "Users can update own feedback" ON public.session_feedback FOR UPDATE USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));

-- policy: notifications Users can update own notifications

CREATE POLICY "Users can update own notifications" ON public.notifications FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

-- policy: notification_preferences Users can update own preferences

CREATE POLICY "Users can update own preferences" ON public.notification_preferences FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));

-- policy: profiles Users can update own profile

CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING ((auth.uid() = id));

-- policy: votes Users can update own votes

CREATE POLICY "Users can update own votes" ON public.votes FOR UPDATE USING (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = votes.event_id) AND (event_members.user_id = auth.uid()))))));

-- policy: favorites Users can view own favorites

CREATE POLICY "Users can view own favorites" ON public.favorites FOR SELECT USING ((user_id = auth.uid()));

-- policy: session_feedback Users can view own feedback

CREATE POLICY "Users can view own feedback" ON public.session_feedback FOR SELECT USING ((user_id = auth.uid()));

-- policy: event_members Users can view own membership

CREATE POLICY "Users can view own membership" ON public.event_members FOR SELECT USING ((user_id = auth.uid()));

-- policy: notifications Users can view own notifications

CREATE POLICY "Users can view own notifications" ON public.notifications FOR SELECT USING ((auth.uid() = user_id));

-- policy: notification_preferences Users can view own preferences

CREATE POLICY "Users can view own preferences" ON public.notification_preferences FOR SELECT USING ((auth.uid() = user_id));

-- policy: tickets Users can view own tickets

CREATE POLICY "Users can view own tickets" ON public.tickets FOR SELECT USING ((user_id = auth.uid()));

-- policy: votes Users can view own votes

CREATE POLICY "Users can view own votes" ON public.votes FOR SELECT USING ((user_id = auth.uid()));

-- policy: venues Venue event visibility boundary

CREATE POLICY "Venue event visibility boundary" ON public.venues AS RESTRICTIVE FOR SELECT TO authenticated, anon USING (public.can_read_event(event_id));

-- policy: venues Venues viewable by everyone

CREATE POLICY "Venues viewable by everyone" ON public.venues FOR SELECT USING (true);

-- policy: tickets Volunteers can update tickets for checkin

CREATE POLICY "Volunteers can update tickets for checkin" ON public.tickets FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = tickets.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'volunteer'::text])))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = tickets.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'volunteer'::text]))))));

-- policy: tickets Volunteers can view tickets for checkin

CREATE POLICY "Volunteers can view tickets for checkin" ON public.tickets FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.event_members
  WHERE ((event_members.event_id = tickets.event_id) AND (event_members.user_id = auth.uid()) AND (event_members.role = ANY (ARRAY['owner'::text, 'admin'::text, 'volunteer'::text]))))));

-- row security: at_audit

ALTER TABLE public.at_audit ENABLE ROW LEVEL SECURITY;

-- row security: at_credentials

ALTER TABLE public.at_credentials ENABLE ROW LEVEL SECURITY;

-- row security: at_oauth_client_key

ALTER TABLE public.at_oauth_client_key ENABLE ROW LEVEL SECURITY;

-- row security: at_oauth_session

ALTER TABLE public.at_oauth_session ENABLE ROW LEVEL SECURITY;

-- row security: at_oauth_state

ALTER TABLE public.at_oauth_state ENABLE ROW LEVEL SECURITY;

-- row security: at_records

ALTER TABLE public.at_records ENABLE ROW LEVEL SECURITY;

-- policy: at_records at_records are public

CREATE POLICY "at_records are public" ON public.at_records FOR SELECT USING (true);

-- row security: at_sessions

ALTER TABLE public.at_sessions ENABLE ROW LEVEL SECURITY;

-- row security: at_slot_grids

ALTER TABLE public.at_slot_grids ENABLE ROW LEVEL SECURITY;

-- row security: at_sync_cursor

ALTER TABLE public.at_sync_cursor ENABLE ROW LEVEL SECURITY;

-- row security: cohost_invites

ALTER TABLE public.cohost_invites ENABLE ROW LEVEL SECURITY;

-- row security: event_invitations

ALTER TABLE public.event_invitations ENABLE ROW LEVEL SECURITY;

-- row security: event_members

ALTER TABLE public.event_members ENABLE ROW LEVEL SECURITY;

-- row security: events

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

-- row security: favorites

ALTER TABLE public.favorites ENABLE ROW LEVEL SECURITY;

-- row security: notification_preferences

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

-- row security: notifications

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- row security: profiles

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- row security: session_cohosts

ALTER TABLE public.session_cohosts ENABLE ROW LEVEL SECURITY;

-- row security: session_feedback

ALTER TABLE public.session_feedback ENABLE ROW LEVEL SECURITY;

-- row security: session_resources

ALTER TABLE public.session_resources ENABLE ROW LEVEL SECURITY;

-- row security: session_rsvps

ALTER TABLE public.session_rsvps ENABLE ROW LEVEL SECURITY;

-- row security: sessions

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- row security: ticket_tiers

ALTER TABLE public.ticket_tiers ENABLE ROW LEVEL SECURITY;

-- row security: tickets

ALTER TABLE public.tickets ENABLE ROW LEVEL SECURITY;

-- row security: time_slots

ALTER TABLE public.time_slots ENABLE ROW LEVEL SECURITY;

-- row security: tracks

ALTER TABLE public.tracks ENABLE ROW LEVEL SECURITY;

-- row security: venues

ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;

-- row security: votes

ALTER TABLE public.votes ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 6. Identity trigger
-- -----------------------------------------------------------------------------
-- trigger: on_account_created — every new account gets a profile row
CREATE TRIGGER on_account_created AFTER INSERT ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- 7. Grants
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;

-- Secret-bearing identity tables: `authenticated` may only read non-secret account
-- columns (still filtered by RLS) and nothing in auth_email_tokens.
REVOKE ALL ON TABLE public.accounts FROM authenticated;
GRANT SELECT (id, did, handle, email, kind, email_verified_at, owned_at, created_at) ON TABLE public.accounts TO authenticated;
REVOKE ALL ON TABLE public.auth_email_tokens FROM authenticated;

-- Helpers the source revoked from PUBLIC keep exactly the source ACL
-- (EXECUTE for anon, authenticated, service_role only).
REVOKE ALL ON FUNCTION public.can_manage_session(target_session uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_manage_session(target_session uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_read_event(target_event uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_event(target_event uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_read_session_event(target_session uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_read_session_event(target_session uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_event_proposal_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_event_proposal_rules() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_event_vote_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_event_vote_rules() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enforce_session_update_rules() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enforce_session_update_rules() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.event_role(target_event uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.event_role(target_event uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.fill_cohost_event_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fill_cohost_event_id() TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_session_cohost(target_session uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_session_cohost(target_session uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_session_host(target_session uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_session_host(target_session uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_session_organizer(target_session uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_session_organizer(target_session uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.session_feedback_summary(target_session uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_feedback_summary(target_session uuid) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.session_started_at(target_session uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.session_started_at(target_session uuid) TO anon, authenticated, service_role;

-- create_event_with_program is service-only in the source: never callable by a
-- signed-in role directly.
REVOKE ALL ON FUNCTION public.create_event_with_program(p_event jsonb, p_venues jsonb, p_tracks jsonb, p_time_slots jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_event_with_program(p_event jsonb, p_venues jsonb, p_tracks jsonb, p_time_slots jsonb) TO service_role;

-- Objects created by later migrations (run as the same owner) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Restore session settings changed in section 1.
-- -----------------------------------------------------------------------------
RESET check_function_bodies;
RESET client_min_messages;
RESET row_security;
RESET xmloption;
