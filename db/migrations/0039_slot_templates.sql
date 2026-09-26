-- =============================================================================
-- 0039_slot_templates.sql — saved shapes for the slot grid
-- =============================================================================
--
-- Design (2026-09-25 place/people/knowledge §4): the bulk block editor is per-room and per-day,
-- so a gathering's shape ("three rooms, 9–5, hour slots, the garden shut on Sunday") is worth
-- keeping. "Save as template" stores the whole configuration here; "Apply template" fills the
-- editor; cloning a gathering carries the list across (src/lib/events/clone.ts).
--
-- One jsonb array on the gathering, not a table: it is a handful of small organizer-authored
-- shapes read and written only by the editor, always as a whole list, and never referenced by
-- anything else. Shape, sizes and per-field ranges are validated in the route
-- (`checkTemplates` in src/lib/scheduling/slot-blocks.ts); the constraints below are the
-- database's own floor on how much can land here and in what form.
--
--   [{ name: 'Weekday shape',
--      days: [{ rooms: [{ room: 'Main Hall'|null, start: '09:00', end: '17:00',
--                         slotMinutes: 60, breakMinutes: 15, closed: false }] }] }]
--
-- Rooms are stored by position with their *name* (never a venue id): a template applies to
-- another gathering's rooms, where the ids differ but the shape is the same. App-side only,
-- exactly like `events.map` — nothing here is ever published to a record, and no name in it is
-- a person's (a room name is the gathering's own copy).
-- =============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS slot_templates jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A CHECK cannot hold a subquery, so the per-entry floor lives in an IMMUTABLE function the
-- constraint calls: an array, at most ten entries, each an object with a non-empty name of at
-- most 60 characters and between one and 31 days. Field-level ranges (slot and break lengths,
-- HH:MM times, room names) are the route's to enforce — `checkTemplates` in
-- src/lib/scheduling/slot-blocks.ts — and it normalizes away anything it does not understand.
CREATE OR REPLACE FUNCTION public.slot_templates_ok(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT jsonb_typeof(v) = 'array'
     AND jsonb_array_length(v) <= 10
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(v) AS t(entry)
       WHERE jsonb_typeof(t.entry) <> 'object'
          OR jsonb_typeof(t.entry -> 'name') <> 'string'
          OR btrim(t.entry ->> 'name') = ''
          OR length(t.entry ->> 'name') > 60
          OR jsonb_typeof(t.entry -> 'days') <> 'array'
          OR jsonb_array_length(t.entry -> 'days') = 0
          OR jsonb_array_length(t.entry -> 'days') > 31
     )
$$;

COMMENT ON FUNCTION public.slot_templates_ok(jsonb) IS
  'Shape floor for events.slot_templates (migration 0039). The route validates the fields; this keeps anything that is not a named list of days out of the column.';

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_slot_templates_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_slot_templates_check CHECK (public.slot_templates_ok(slot_templates));

-- A ceiling on the whole column: ten shapes of 31 days x 60 rooms is generous; a megabyte of
-- jsonb on a hot row is not, and nothing else should ever be written here.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_slot_templates_size_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_slot_templates_size_check CHECK (length(slot_templates::text) <= 262144);

COMMENT ON COLUMN public.events.slot_templates IS
  'Saved bulk-block configurations (design 2026-09-25 §4): [{name, days: [{rooms: [{room, start, end, slotMinutes, breakMinutes, closed}]}]}]. Rooms by position and name, never by venue id, so a template survives a clone. App-side only; never published.';
