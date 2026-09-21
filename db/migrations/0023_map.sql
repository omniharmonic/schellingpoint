-- 0023: map (spec §8.1).
--
-- Venues get WGS84 coordinates. A PUBLIC venue's coordinates are published inside the venue
-- record's `locations` as `community.lexicon.location.geo`; a private residence's coordinates are
-- attendee-only (same tier as its street address) and never reach a record.
--
-- Self-hosted sessions get an exact point (`location_lat/lng`, attendee-only, the tier of
-- `custom_location`) and a coarse point (`public_geo`, rounded to 2 decimals ≈ 1 km) that is the
-- ONLY geo a non-member or a public record ever sees.
--
-- `events.map` is the organizer's chosen view ({ center: [lng, lat], zoom, bounds }): app-side only.
-- `geocode_cache` memoises Nominatim answers for 30 days (server-only, migration 0009 pattern);
-- `geocode_requests` counts geocoder calls per account for the per-account rate limit.

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS latitude numeric(9,6),
  ADD COLUMN IF NOT EXISTS longitude numeric(9,6),
  ADD COLUMN IF NOT EXISTS geocoded_from text,
  ADD COLUMN IF NOT EXISTS geocoded_at timestamptz;

ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_latitude_range;
ALTER TABLE public.venues ADD CONSTRAINT venues_latitude_range CHECK (latitude IS NULL OR (latitude >= -90 AND latitude <= 90));
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_longitude_range;
ALTER TABLE public.venues ADD CONSTRAINT venues_longitude_range CHECK (longitude IS NULL OR (longitude >= -180 AND longitude <= 180));
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_geocoded_from_length;
ALTER TABLE public.venues ADD CONSTRAINT venues_geocoded_from_length CHECK (geocoded_from IS NULL OR char_length(geocoded_from) <= 400);

COMMENT ON COLUMN public.venues.latitude IS 'WGS84 latitude. Published in the venue record only when is_private_residence is false.';
COMMENT ON COLUMN public.venues.longitude IS 'WGS84 longitude. Published in the venue record only when is_private_residence is false.';
COMMENT ON COLUMN public.venues.geocoded_from IS 'The address text the coordinates were geocoded from (null when placed by hand).';

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS map jsonb;

COMMENT ON COLUMN public.events.map IS 'Organizer-chosen map view { center: [lng, lat], zoom, bounds: [[sw], [ne]] }. App-side only; never published.';

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS location_lat numeric(9,6),
  ADD COLUMN IF NOT EXISTS location_lng numeric(9,6),
  ADD COLUMN IF NOT EXISTS public_geo jsonb;

ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_location_lat_range;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_location_lat_range CHECK (location_lat IS NULL OR (location_lat >= -90 AND location_lat <= 90));
ALTER TABLE public.sessions DROP CONSTRAINT IF EXISTS sessions_location_lng_range;
ALTER TABLE public.sessions ADD CONSTRAINT sessions_location_lng_range CHECK (location_lng IS NULL OR (location_lng >= -180 AND location_lng <= 180));

COMMENT ON COLUMN public.sessions.location_lat IS 'Exact latitude of a self-hosted session. Attendee-only (the tier of custom_location); never published.';
COMMENT ON COLUMN public.sessions.location_lng IS 'Exact longitude of a self-hosted session. Attendee-only (the tier of custom_location); never published.';
COMMENT ON COLUMN public.sessions.public_geo IS 'Coarse point {lat, lng} rounded to 2 decimals (≈1 km), derived server-side from location_lat/lng. The only geo non-members and records see.';

-- Server-only (0009 default privileges already revoke anon/authenticated; the explicit revoke is
-- defence in depth if the defaults are ever changed).
CREATE TABLE IF NOT EXISTS public.geocode_cache (
  query_hash text PRIMARY KEY,
  result jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.geocode_cache FROM anon, authenticated;
COMMENT ON TABLE public.geocode_cache IS 'Nominatim answers keyed by a hash of the normalized query. Server-only; entries expire after 30 days.';

CREATE TABLE IF NOT EXISTS public.geocode_requests (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geocode_requests_account_idx ON public.geocode_requests USING btree (account_id, requested_at);
REVOKE ALL ON public.geocode_requests FROM anon, authenticated;
COMMENT ON TABLE public.geocode_requests IS 'Per-account geocoder call log for rate limiting (30/hour). Server-only; rows older than an hour are pruned on write.';
