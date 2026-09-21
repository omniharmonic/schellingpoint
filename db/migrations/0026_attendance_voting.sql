-- =============================================================================
-- 0026_attendance_voting.sql — attendance voting (design §11, PRD §2.3)
-- =============================================================================
--
-- A second ballot-key round per gathering, `vote_rounds.phase = 'attendance'`,
-- opened when the gathering goes live and closed (key destroyed) by the same
-- close job as a pre-event round. Fresh credits: the round has its own
-- credit_ledger rows, so nothing carries over from the pre-event round.
--
-- The round tables need no change: 0002 already discriminates rounds by
-- `phase in ('pre-event', 'attendance')` and keeps at most one open round per
-- (event, phase) — `vote_rounds_one_open_per_phase`. Every privacy property is
-- inherited unchanged: entries carry a ballot_token and no account column,
-- the ledger is deleted at close, `ballot_key` is set NULL at close and can
-- never be restored (guard_vote_round_key).
--
-- What is new is per-gathering opt-in and the fresh budget:
--   events.attendance_voting_enabled   off by default (design §12 decision 6)
--   events.attendance_credits          credits per member in the attendance
--                                      round (PRD: 100, fresh)
-- =============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS attendance_voting_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS attendance_credits integer NOT NULL DEFAULT 100;

ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_attendance_credits_check,
  ADD CONSTRAINT events_attendance_credits_check CHECK (attendance_credits > 0 AND attendance_credits <= 2147483647);

COMMENT ON COLUMN public.events.attendance_voting_enabled IS
  'Opt-in (design §11): when true, going live opens a vote_rounds row with phase = ''attendance'' that the close job seals at the gathering''s end + 1 hour. Never published.';
COMMENT ON COLUMN public.events.attendance_credits IS
  'Fresh credits per member in the attendance round (PRD §2.3: 100). Independent of vote_credits_per_user; nothing carries over from the pre-event round.';

COMMENT ON COLUMN public.vote_rounds.phase IS
  '''pre-event'' (opened on entering voting_open) or ''attendance'' (opened on going live when events.attendance_voting_enabled). One open round per (event, phase). Both phases share every table and the same close: ledger deleted, ballot_key NULL.';

-- The public `events` read policies (0001/0007) are column-agnostic; these two
-- columns are organizer settings and are exposed only through the settings
-- route and the organizer analytics route, never in a public record.
