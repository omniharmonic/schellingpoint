-- 0036: map v2 (design §1 "Map v2 — addresses first, shapes when needed").
--
-- Three app-side columns. None of them is ever published:
--
--   venues.geocode_status   pending | ok | failed | manual — what the organizer is told while the
--                           address is looked up in the background ("Locating…", "Located",
--                           "Couldn't locate — place by hand"). `manual` marks a hand-dropped pin,
--                           which the background geocode must never overwrite.
--   venues.outline          a GeoJSON Polygon (WGS84) drawn over the room, ≤ 64 vertices, closed
--                           ring, bbox within 50 km of the pin. App-side only, like `events.map`:
--                           it is a building footprint, so a private residence may not have one
--                           (the venues route answers 409) and it never reaches a record.
--   events.custom_map       an indoor / hand-drawn map: { image: '/uploads/…', corners | null,
--                           opacity, basemap }. The image is an app-hosted upload (content-addressed
--                           and unguessable, but not access-controlled — the same tier as the
--                           gathering's logo). App-side only; never published.
--
-- Existing pins get a status that matches how they were placed: a pin with no `geocoded_from` was
-- dropped by hand (`manual`), a pin with one came from a lookup (`ok`).

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS geocode_status text,
  ADD COLUMN IF NOT EXISTS outline jsonb;

ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_geocode_status_values;
ALTER TABLE public.venues ADD CONSTRAINT venues_geocode_status_values
  CHECK (geocode_status IS NULL OR geocode_status IN ('pending', 'ok', 'failed', 'manual'));

-- A polygon and nothing else: the shape is validated in full by src/lib/geo/outline.ts, but the
-- database refuses anything that is not a GeoJSON Polygon object outright.
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_outline_polygon;
ALTER TABLE public.venues ADD CONSTRAINT venues_outline_polygon
  CHECK (
    outline IS NULL
    OR (jsonb_typeof(outline) = 'object'
        AND outline ->> 'type' = 'Polygon'
        AND jsonb_typeof(outline -> 'coordinates') = 'array')
  );

-- A private residence's footprint is its exact location: it may not be drawn at all.
ALTER TABLE public.venues DROP CONSTRAINT IF EXISTS venues_outline_not_private;
ALTER TABLE public.venues ADD CONSTRAINT venues_outline_not_private
  CHECK (outline IS NULL OR is_private_residence IS NOT TRUE);

COMMENT ON COLUMN public.venues.geocode_status IS 'pending|ok|failed|manual: the state of the background address lookup. "manual" is a hand-dropped pin and is never overwritten by a lookup.';
COMMENT ON COLUMN public.venues.outline IS 'GeoJSON Polygon outline of the room (WGS84, <= 64 vertices, closed ring). App-side only; never published. Never set for a private residence.';

UPDATE public.venues
   SET geocode_status = CASE WHEN geocoded_from IS NULL THEN 'manual' ELSE 'ok' END
 WHERE geocode_status IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL;

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS custom_map jsonb;

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_custom_map_shape;
ALTER TABLE public.events ADD CONSTRAINT events_custom_map_shape
  CHECK (
    custom_map IS NULL
    OR (jsonb_typeof(custom_map) = 'object'
        AND custom_map ->> 'image' LIKE '/uploads/%'
        AND jsonb_typeof(custom_map -> 'opacity') = 'number')
  );

COMMENT ON COLUMN public.events.custom_map IS 'Indoor / hand-drawn map { image: /uploads/..., corners: [[lng,lat] x4] | null, opacity, basemap }. App-side only; never published.';
