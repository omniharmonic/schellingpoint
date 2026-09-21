-- "What I'm looking for" (release design §6): a short free-text line beside interests that helps
-- people find each other. Self-written through PATCH /api/me/profile; shown only to fellow members
-- of a gathering (the directory projection in people.ts); never a record on the network.
--
-- `profiles` already carries RLS (0008) and the private-by-default rule of 0009 needs no change
-- for an added column. The 200-character limit mirrors PROFILE_LIMITS.lookingFor in
-- src/app/api/me/profile/validate.ts; change both together.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS looking_for text;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_looking_for_length;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_looking_for_length
  CHECK (looking_for IS NULL OR char_length(looking_for) <= 200) NOT VALID;

COMMENT ON COLUMN public.profiles.looking_for IS
  'Self-written "What I''m looking for". Members-only, always; never published.';
