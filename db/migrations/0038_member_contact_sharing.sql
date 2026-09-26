-- 0038: contact sharing per gathering (place/people/knowledge design §3.3), and the interests cap.
--
-- event_members.share_email    the member's own consent to show their email address on their card
--                             in THIS gathering's members-only directory. Off by default: the
--                             `main` behaviour (email always visible to fellow members) is not
--                             restored. Never published in a record, never shown to a non-member.
-- event_members.share_contact  the same consent for the messaging handle (profiles.telegram).
--                             On by default, matching the handle's existing members-only tier.
--
-- Both are the member's own switch, per gathering, like directory_listing and mention_in_posts.
--
-- No new grants are needed: `event_members` already has RLS enabled with the policies from
-- 0001/0008 and `authenticated` already holds table privileges on it, so a boolean column
-- inherits all of that and migration 0009's "private by default" rule is satisfied.
--
-- What those policies do NOT do is stop an organizer from writing these columns. "Event admins
-- can update members" (0001) is column-agnostic: it exists so owners and admins can change a
-- member's `role`, and it would just as happily flip someone else's `share_email`. A person's own
-- consent is not an organizer's to set, so the trigger below draws that line at the database
-- boundary, the way enforce_session_update_rules() does for proposal content.
--
-- profiles_interests_count     10 → 15 (design §3.4, owner decision 2026-09-25). Mirrored in
--                             src/app/api/me/profile/validate.ts (PROFILE_LIMITS.interests.count)
--                             and in the UI counters; change them together.

ALTER TABLE public.event_members
  ADD COLUMN IF NOT EXISTS share_email boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS share_contact boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.event_members.share_email IS
  'The member''s own consent to show their email address to fellow members of this gathering (design §3.3). Per gathering, off by default, never set by an organiser, never in a record.';
COMMENT ON COLUMN public.event_members.share_contact IS
  'The member''s own consent to show their messaging handle to fellow members of this gathering (design §3.3). Per gathering, on by default, never set by an organiser, never in a record.';

-- ---------------------------------------------------------------------------
-- Consent columns are the member's own
-- ---------------------------------------------------------------------------
-- The four columns that record what a member chose about themselves. An UPDATE that changes any
-- of them is refused unless the acting account IS that member.
--
-- auth.uid() is NULL for the service connection (`sql` in src/lib/db), which is how the AppView's
-- own routes write these columns; those routes already filter by the signed-in account's
-- `user_id`, and this trigger is the second lock rather than the first. It bites on every
-- authenticated path — `asAccount(...)`, psql as `authenticated`, anything reaching the table
-- through RLS — which is where an organizer's column-agnostic UPDATE policy lives.
CREATE OR REPLACE FUNCTION public.enforce_member_consent_columns() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() = OLD.user_id THEN
    RETURN NEW;
  END IF;

  IF NEW.share_email       IS DISTINCT FROM OLD.share_email
    OR NEW.share_contact     IS DISTINCT FROM OLD.share_contact
    OR NEW.directory_listing IS DISTINCT FROM OLD.directory_listing
    OR NEW.mention_in_posts  IS DISTINCT FROM OLD.mention_in_posts
  THEN
    RAISE EXCEPTION 'Only the member can change what they share' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_member_consent_columns() IS
  'Refuses an UPDATE that changes another member''s share_email, share_contact, directory_listing or mention_in_posts (design §3.3). The 0001 admin UPDATE policy is column-agnostic; these four columns are consent, not administration.';

DROP TRIGGER IF EXISTS enforce_member_consent_columns ON public.event_members;
CREATE TRIGGER enforce_member_consent_columns
  BEFORE UPDATE ON public.event_members
  FOR EACH ROW EXECUTE FUNCTION public.enforce_member_consent_columns();

-- ---------------------------------------------------------------------------
-- The interests cap, raised from 10 to 15
-- ---------------------------------------------------------------------------
-- 0008 added the old constraint NOT VALID, so existing rows were never checked against 10 and
-- some may exceed it. The replacement is added VALID: widening the bound cannot reject a row that
-- satisfied the narrower one, but it can reject a row that predates 0008 and has more than 15
-- interests. Nothing writes interests except PATCH /api/me/profile, which has always capped them,
-- so there is no such row; the ALTER would fail loudly rather than silently if there were.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_interests_count;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_interests_count CHECK (interests IS NULL OR cardinality(interests) <= 15);
