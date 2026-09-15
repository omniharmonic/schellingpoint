-- 0008 — people, profiles, directory (work package G)
--
-- Spec §2, §7, §8, §10:
--   * The profile is app-side and self-written. Only its holder writes it (PATCH /api/me/profile).
--   * `ens` is self-written and verified app-side: the AppView resolves the name and checks that
--     the resolved address signed a single-use challenge. Verification is stored as
--     `ens_verified_at`; the name is shown to fellow members only when verified AND the holder
--     opted in (`show_ens`). Never a record.
--   * `telegram` is members-only, always.
--   * `profiles.is_admin` is deleted: roles are derived per gathering, never global. The two
--     baseline RLS policies that granted table-wide power through it go with it.
--   * The roster (`event_members`) is never public. Directory listing is opt-out per gathering
--     (`directory_listing`); a public role claim ("publicly list me as a host") is opt-in per
--     gathering (`public_role`) — the subject gate of the three role-claim gates (§4.1, §10).

-- ---------------------------------------------------------------------------
-- 1. is_admin grants nothing
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Admins can manage cohost invites" ON public.cohost_invites;
DROP POLICY IF EXISTS "Admins can manage tracks" ON public.tracks;
ALTER TABLE public.profiles DROP COLUMN IF EXISTS is_admin;

-- ---------------------------------------------------------------------------
-- 2. Profile: ENS verification, opt-in display, length limits
-- ---------------------------------------------------------------------------
ALTER TABLE public.profiles
  ADD COLUMN ens_verified_at timestamptz,
  ADD COLUMN show_ens boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.ens IS
  'Self-written ENS name. Shown to fellow members only when ens_verified_at is set and show_ens is true. Never a record.';
COMMENT ON COLUMN public.profiles.ens_verified_at IS
  'When the name''s resolved address signed a challenge (POST /api/me/ens/verify). Cleared whenever ens changes.';
COMMENT ON COLUMN public.profiles.telegram IS 'Self-written. Members-only, always.';

-- A verification belongs to the name it verified: changing or clearing `ens` clears it.
CREATE FUNCTION public.clear_ens_verification() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path TO 'public'
  AS $$
BEGIN
  IF NEW.ens IS DISTINCT FROM OLD.ens AND NEW.ens_verified_at IS NOT DISTINCT FROM OLD.ens_verified_at THEN
    NEW.ens_verified_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_clear_ens_verification
  BEFORE UPDATE OF ens ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.clear_ens_verification();

-- Limits mirror src/app/api/me/profile/validate.ts. NOT VALID: enforced for every new write
-- without failing on imported legacy rows (which the API normalizes on their next save).
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_display_name_length CHECK (display_name IS NULL OR char_length(display_name) <= 80) NOT VALID,
  ADD CONSTRAINT profiles_bio_length CHECK (bio IS NULL OR char_length(bio) <= 1000) NOT VALID,
  ADD CONSTRAINT profiles_affiliation_length CHECK (affiliation IS NULL OR char_length(affiliation) <= 120) NOT VALID,
  ADD CONSTRAINT profiles_building_length CHECK (building IS NULL OR char_length(building) <= 500) NOT VALID,
  ADD CONSTRAINT profiles_telegram_format CHECK (telegram IS NULL OR telegram ~ '^[A-Za-z0-9_]{5,32}$') NOT VALID,
  ADD CONSTRAINT profiles_ens_length CHECK (ens IS NULL OR char_length(ens) <= 255) NOT VALID,
  ADD CONSTRAINT profiles_avatar_url_length CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 2048) NOT VALID,
  ADD CONSTRAINT profiles_interests_count CHECK (interests IS NULL OR cardinality(interests) <= 10) NOT VALID,
  ADD CONSTRAINT profiles_ens_verified_needs_ens CHECK (ens_verified_at IS NULL OR ens IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. ENS challenges — one outstanding challenge per account, server-only
-- ---------------------------------------------------------------------------
CREATE TABLE public.ens_challenges (
  account_id uuid PRIMARY KEY REFERENCES public.accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) <= 255),
  nonce text NOT NULL CHECK (nonce ~ '^[0-9a-f]{32}$'),
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ens_challenges IS
  'Single-use ENS verification challenges (POST /api/me/ens/challenge → /verify). Deleted on use or replacement.';

CREATE INDEX ens_challenges_expires_at_idx ON public.ens_challenges USING btree (expires_at);

ALTER TABLE public.ens_challenges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ens_challenges FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Membership: directory opt-out, role-claim opt-in
-- ---------------------------------------------------------------------------
ALTER TABLE public.event_members
  ADD COLUMN directory_listing boolean NOT NULL DEFAULT true,
  ADD COLUMN public_role boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.event_members.directory_listing IS
  'Listed in this gathering''s members-only directory. Opt-out, per gathering.';
COMMENT ON COLUMN public.event_members.public_role IS
  'Subject opt-in for a public coop.lexicon.membership role claim in this gathering (one of three gates; spec §4.1, §10).';

-- ---------------------------------------------------------------------------
-- 5. RLS defense in depth: the roster and profiles are members-only
-- ---------------------------------------------------------------------------
-- The browser never reaches Postgres, but asAccount() transactions still run under RLS.
-- The baseline let anyone read the roster of a public event and every profile row
-- (email, telegram, ens). Replace both with "yourself, or someone you share a gathering with".

CREATE FUNCTION public.shares_event_with(target_account uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public'
  AS $$
  SELECT target_account = auth.uid() OR EXISTS (
    SELECT 1
    FROM public.event_members mine
    JOIN public.event_members theirs ON theirs.event_id = mine.event_id
    WHERE mine.user_id = auth.uid() AND theirs.user_id = target_account
  );
$$;

REVOKE ALL ON FUNCTION public.shares_event_with(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shares_event_with(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Anyone can view public event members" ON public.event_members;
CREATE POLICY "Members can view fellow members" ON public.event_members
  FOR SELECT TO authenticated
  USING (public.event_role(event_id) IS NOT NULL);

DROP POLICY IF EXISTS "Profiles viewable by everyone" ON public.profiles;
CREATE POLICY "Profiles visible to self and fellow members" ON public.profiles
  FOR SELECT TO authenticated
  USING (public.shares_event_with(id));
