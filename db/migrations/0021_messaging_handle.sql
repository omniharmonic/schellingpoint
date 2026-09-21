-- The profile's messaging handle is generic now (Telegram, Signal, Matrix, a URL…); the UI labels
-- it "Messaging handle". The column keeps its name. Relax the Telegram-only format to any single
-- line up to 120 characters. Still members-only, still self-written (0008_people.sql).
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_telegram_format;
ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_telegram_format
  CHECK (telegram IS NULL OR (char_length(telegram) BETWEEN 1 AND 120 AND telegram !~ '[[:cntrl:]]')) NOT VALID;
COMMENT ON COLUMN public.profiles.telegram IS 'Self-written messaging handle or link (any platform; UI label "Messaging handle"). Members-only, always.';
