-- 0007 — events core (work package A)
--
-- 1. "Defaults open; gates opt-in" (spec §3): proposals are public on write unless an
--    organizer turns review on. The baseline kept the old `true` default.
-- 2. Policy thresholds (spec §8, freeschool.draft.policy#thresholds) chosen in the
--    creation wizard's Voting step and in Event settings. They live on the event row
--    so the gathering's policy record can be rebuilt from app state at any time:
--      destructiveActionStewards  1..5  organizers who must approve moving/cancelling a
--                                       published session (default 2)
--      feedbackK                  2..10 k-suppression threshold for tallies/feedback (3)
--      publishRoles               bool  let role claims reach the network (off)
--    Bounds mirror lexicons/vendor/freeschool/policy.json.

ALTER TABLE public.events ALTER COLUMN require_proposal_approval SET DEFAULT false;

ALTER TABLE public.events
  ADD COLUMN policy_thresholds jsonb NOT NULL
    DEFAULT '{"destructiveActionStewards": 2, "feedbackK": 3, "publishRoles": false}'::jsonb;

CREATE FUNCTION public.valid_policy_thresholds(t jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  AS $$
    SELECT jsonb_typeof(t) = 'object'
      AND jsonb_typeof(t->'destructiveActionStewards') = 'number'
      AND (t->>'destructiveActionStewards') ~ '^[0-9]+$'
      AND (t->>'destructiveActionStewards')::int BETWEEN 1 AND 5
      AND jsonb_typeof(t->'feedbackK') = 'number'
      AND (t->>'feedbackK') ~ '^[0-9]+$'
      AND (t->>'feedbackK')::int BETWEEN 2 AND 10
      AND jsonb_typeof(t->'publishRoles') = 'boolean'
      AND (SELECT count(*) FROM jsonb_object_keys(t)) = 3
  $$;

ALTER TABLE public.events
  ADD CONSTRAINT events_policy_thresholds_check CHECK (public.valid_policy_thresholds(policy_thresholds));

COMMENT ON COLUMN public.events.policy_thresholds IS
  'freeschool.draft.policy thresholds: {destructiveActionStewards 1-5, feedbackK 2-10, publishRoles bool}. Written by /api/events/create and /api/events/[eventId]/settings.';
