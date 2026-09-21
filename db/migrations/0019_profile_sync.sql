-- Identity hydration (release design §5): which profile fields still mirror the person's network
-- profile, and when it was last read.
--
--   synced_fields      subset of {display_name, avatar_url, bio} that came from the network
--                      (app.bsky.actor.profile on the PDS, else the AppView) and have not been
--                      edited in this app since. A sign-in refresh overwrites only these (and blank
--                      fields); PATCH /api/me/profile removes a field it changes; "Re-sync from my
--                      Bluesky profile" re-imports everything and rebuilds the set.
--   profile_synced_at  last successful network read (null: never imported).
--
-- `profiles` already carries RLS (0008) and the private-by-default rule of 0009 needs no change
-- for added columns. The browser never reads these directly; the AppView selects what it shows.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS synced_fields text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS profile_synced_at timestamptz;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_synced_fields_known;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_synced_fields_known
  CHECK (synced_fields <@ ARRAY['display_name', 'avatar_url', 'bio']::text[]);

-- `profiles.atproto_handle` was a write-only shadow of `accounts.handle` (maintained by the OAuth
-- bridge, custody and the identity-event handler, read by nothing). It is no longer written; the
-- column stays until a later migration drops it so an older build can still boot against this schema.
COMMENT ON COLUMN public.profiles.atproto_handle IS
  'DEPRECATED (0019): no longer written. The handle lives on accounts.handle.';
