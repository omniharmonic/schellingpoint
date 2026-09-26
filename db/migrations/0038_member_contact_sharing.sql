-- 0038: contact sharing per gathering (place/people/knowledge design §3.3), and the interests cap.
--
-- event_members.share_email    the member's own consent to show their email address on their card
--                             in THIS gathering's members-only directory. Off by default: the
--                             `main` behaviour (email always visible to fellow members) is not
--                             restored. Never published in a record, never shown to a non-member.
-- event_members.share_contact  the same consent for the messaging handle (profiles.telegram).
--                             On by default, matching the handle's existing members-only tier.
--
-- Both are the member's own switch, per gathering, like directory_listing and mention_in_posts:
-- an organizer never sets them (the routes only ever write the viewer's own row).
--
-- profiles_interests_count     10 → 15 (design §3.4, owner decision 2026-09-25). Mirrored in
--                             src/app/api/me/profile/validate.ts (PROFILE_LIMITS.interests.count)
--                             and in the UI counters; change them together.
--
-- No new grants: event_members already has RLS enabled with the policies from 0001/0008
-- ("Members can view fellow members" for SELECT, "Users can view own membership", the restrictive
-- "Roster event visibility boundary", and the admin UPDATE policy), and `authenticated` already
-- holds column-less table privileges on it. A boolean column inherits all of that, so migration
-- 0009's "private by default" rule needs nothing further here.

ALTER TABLE public.event_members
  ADD COLUMN IF NOT EXISTS share_email boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS share_contact boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.event_members.share_email IS
  'The member''s own consent to show their email address to fellow members of this gathering (design §3.3). Per gathering, off by default, never set by an organiser, never in a record.';
COMMENT ON COLUMN public.event_members.share_contact IS
  'The member''s own consent to show their messaging handle to fellow members of this gathering (design §3.3). Per gathering, on by default, never set by an organiser, never in a record.';

-- The interests cap, raised from 10 to 15. Revalidated, not left NOT VALID: widening a CHECK can
-- never fail on rows that satisfied the narrower one.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_interests_count;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_interests_count CHECK (interests IS NULL OR cardinality(interests) <= 15);
