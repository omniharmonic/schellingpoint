-- 0041: `venues.updated_at`, so a stuck address lookup can recover (design §1.1).
--
-- 0036 gave rooms a `geocode_status`. `pending` is written in the same transaction as the save and
-- cleared by the `after()` lookup — but nothing clears it if that callback never runs (a restart
-- between the commit and the lookup, a process killed mid-flight). The room would then say
-- "Locating…" forever.
--
-- There is no `pending since` to compare against: `geocoded_at` is when the POINT last moved (the
-- drift check reads it, so it must not be repurposed), and `created_at` is when the room was added.
-- A plain `updated_at`, maintained by a trigger, gives every read a truthful "this row was last
-- written at": `selectVenues` reports a `pending` row older than two minutes as `failed`, which is
-- what the editor needs to say "Couldn't locate — place by hand". The stored value is left alone;
-- pressing "Place" (or saving the address again) starts a fresh lookup.

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

COMMENT ON COLUMN public.venues.updated_at IS 'Last write to this row, maintained by a trigger. A geocode_status of pending older than two minutes is reported as failed.';

-- Refresh the stamp on every write, UNLESS the write names it: a repair or a test that needs a row
-- to look older than it is should be able to say so, and nothing in the app ever writes the column.
CREATE OR REPLACE FUNCTION public.update_venues_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN
    NEW.updated_at = now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS venues_set_updated_at ON public.venues;
CREATE TRIGGER venues_set_updated_at
  BEFORE UPDATE ON public.venues
  FOR EACH ROW EXECUTE FUNCTION public.update_venues_updated_at();

-- Rows already waiting when this lands get the benefit of the doubt: their clock starts now.
UPDATE public.venues SET updated_at = now() WHERE geocode_status = 'pending';
