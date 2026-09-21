-- Custodial profile record, opt-in (release design §5.5, decision §12.3), and the hourly network
-- profile refresh (§5.2).
--
--   publish_profile      a custodial person chose to publish `app.bsky.actor.profile` (rkey `self`)
--                        to their OWN repo on our PDS, written with their own credential — never by
--                        a gathering actor. Off by default: it makes display name and bio world-
--                        readable and copyable. OAuth accounts manage their own profile elsewhere.
--   profile_record_uri   the record we last wrote, and
--   profile_record_cid   its cid (CAS on the next rewrite; cleared when the person opts out and the
--                        record is deleted).
--   profile_refresh_at   last attempt of the hourly refresh job (`/api/jobs/profile-refresh`) for an
--                        OAuth account, so one account is re-read at most once an hour whatever the
--                        scheduler does; `profile_synced_at` (0019) still records the last SUCCESS.
--
-- `profiles` keeps its RLS (0008); 0009's private-by-default rule needs no change for new columns.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS publish_profile boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS profile_record_uri text,
  ADD COLUMN IF NOT EXISTS profile_record_cid text,
  ADD COLUMN IF NOT EXISTS profile_refresh_at timestamptz;

COMMENT ON COLUMN public.profiles.publish_profile IS
  'Custodial accounts only: the person opted in to an app.bsky.actor.profile record in their own repo (off by default).';
COMMENT ON COLUMN public.profiles.profile_record_uri IS
  'AT-URI of the profile record last written for this person (null: none written or deleted).';
COMMENT ON COLUMN public.profiles.profile_record_cid IS
  'CID of that record, asserted as swapRecord on the next rewrite/delete.';
COMMENT ON COLUMN public.profiles.profile_refresh_at IS
  'Last attempt of the hourly network-profile refresh (OAuth accounts); success is profile_synced_at.';
