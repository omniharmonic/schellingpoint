-- =============================================================================
-- 0030_notification_lifecycle.sql — notifications, reminders and the status job
-- =============================================================================
-- Closes the notification gaps recorded in
-- docs/design/audits/2026-09-22-feature-inventory.md §8 (P2-1 … P2-10) and the
-- lifecycle half of P1-6 / P2-17:
--
--   * three new notification types with a category each:
--       event_published  a gathering became visible to its members
--       proposals_open   the proposal window opened
--       rsvp_promoted    a waitlisted RSVP became confirmed (MT §12.4)
--     …carrying 0029's ticket_refunded / payments_paused forward, and teaching
--     get_notification_category about them (should_send_notification reads that
--     function, so a type missing from it silently falls back to session_updates)
--   * `voting_updates` stops being a switch that controls nothing: voting_opened
--     and voting_closed move into it, which is what its label already promised
--     (a live tally is still never notified — spec §5.3)
--   * events.auto_lifecycle — move through the phases on the dates the organizer
--     set, driven by GET /api/jobs/lifecycle (MT §12.1)
--   * notification_marks — server-only idempotence keys for anything the minute
--     loop emits (reminders, "starting soon", organizer alerts). Notifications are
--     emitted from application code, never from a trigger (spec §9), so "send this
--     once" needs a row somewhere; this is that row, and it holds no personal data
--     beyond an account id inside a mark the job itself wrote.
--   * cohost_invites gains a decline path (4.4 in the inventory) and a record of
--     whether the link was emailed — the address itself is never stored.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Notification types
-- -----------------------------------------------------------------------------
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS valid_notification_type;
ALTER TABLE public.notifications ADD CONSTRAINT valid_notification_type CHECK (type IN (
  'session_submitted', 'session_approved', 'session_rejected', 'session_scheduled',
  'session_rescheduled', 'session_cancelled', 'vote_milestone',
  'cohost_invited', 'cohost_accepted', 'cohost_declined',
  'voting_opened', 'voting_closed', 'schedule_published', 'event_reminder', 'admin_announcement',
  'new_proposal', 'proposal_needs_review',
  'proposal_changed', 'approval_requested', 'event_invitation', 'ticket_confirmed',
  -- 0029 (payments) added these two; carried forward so this CHECK stays the whole set.
  'ticket_refunded', 'payments_paused',
  'event_published', 'proposals_open', 'rsvp_promoted'
));

-- Mirrors NOTIFICATION_CATEGORY in src/lib/notifications/categories.ts
-- (tests/notifications.spec.ts asserts they agree).
CREATE OR REPLACE FUNCTION public.get_notification_category(notification_type character varying)
RETURNS character varying
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE notification_type
    WHEN 'session_submitted'    THEN 'session_updates'
    WHEN 'session_approved'     THEN 'session_updates'
    WHEN 'session_rejected'     THEN 'session_updates'
    WHEN 'session_scheduled'    THEN 'session_updates'
    WHEN 'session_rescheduled'  THEN 'session_updates'
    WHEN 'session_cancelled'    THEN 'session_updates'
    WHEN 'rsvp_promoted'        THEN 'session_updates'
    WHEN 'vote_milestone'       THEN 'voting_updates'
    -- The two phase notices a voter actually acts on live in the voting category,
    -- so the switch labelled "Voting updates" controls something real.
    WHEN 'voting_opened'        THEN 'voting_updates'
    WHEN 'voting_closed'        THEN 'voting_updates'
    WHEN 'cohost_invited'       THEN 'collaboration'
    WHEN 'cohost_accepted'      THEN 'collaboration'
    WHEN 'cohost_declined'      THEN 'collaboration'
    WHEN 'schedule_published'   THEN 'event_announcements'
    WHEN 'event_reminder'       THEN 'event_announcements'
    WHEN 'admin_announcement'   THEN 'event_announcements'
    WHEN 'event_invitation'     THEN 'event_announcements'
    WHEN 'ticket_confirmed'     THEN 'event_announcements'
    WHEN 'ticket_refunded'      THEN 'event_announcements'
    WHEN 'event_published'      THEN 'event_announcements'
    WHEN 'proposals_open'       THEN 'event_announcements'
    WHEN 'new_proposal'         THEN 'admin_alerts'
    WHEN 'proposal_needs_review' THEN 'admin_alerts'
    WHEN 'proposal_changed'     THEN 'admin_alerts'
    WHEN 'approval_requested'   THEN 'admin_alerts'
    WHEN 'payments_paused'      THEN 'admin_alerts'
    ELSE 'session_updates'
  END
$$;

-- -----------------------------------------------------------------------------
-- 1b. A sixth email outcome: folded into a digest
-- -----------------------------------------------------------------------------
-- Mail over a recipient's hourly limit used to be dropped as `rate_limited` after a
-- day. It is now collected into one digest email after an hour (inventory P2-8);
-- `rate_limited` stays allowed for rows written before this migration.
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_email_outcome_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_email_outcome_check CHECK (
  email_outcome IS NULL OR email_outcome IN (
    'sent',          -- the mail provider accepted it
    'dev_logged',    -- mail not configured (development): logged, not delivered
    'opted_out',     -- the recipient's preference for this category is off
    'no_email',      -- the account has no verified email (e.g. Bluesky door)
    'rate_limited',  -- historical: stayed over the per-recipient limit for 24 hours
    'digested',      -- delivered inside a digest email with the rest of the backlog
    'failed'         -- the provider refused it on every attempt
  )
);

-- -----------------------------------------------------------------------------
-- 2. Automatic phase transitions (MT §12.1)
-- -----------------------------------------------------------------------------
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS auto_lifecycle boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.events.auto_lifecycle IS
  'Opt-in: GET /api/jobs/lifecycle advances the phase on the configured timestamps '
  '(proposals_open_at, voting_opens_at, voting_closes_at, start_date, end_date + 1 day) '
  'through the same code path as an organizer clicking the button, so notifications and '
  'feed posts fire identically. Off by default.';

-- -----------------------------------------------------------------------------
-- 3. notification_marks: "this one has been sent"
-- -----------------------------------------------------------------------------
-- Server-only (ALTER DEFAULT PRIVILEGES in 0009 revokes anon/authenticated on new
-- tables, and this migration grants nothing): only the AppView's service connection
-- reads or writes it. One row per thing the minute loop has already emitted.
CREATE TABLE public.notification_marks (
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  kind text NOT NULL,
  mark text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, kind, mark),
  CONSTRAINT notification_marks_kind_check CHECK (char_length(kind) BETWEEN 1 AND 40),
  CONSTRAINT notification_marks_mark_check CHECK (char_length(mark) BETWEEN 1 AND 120)
);

COMMENT ON TABLE public.notification_marks IS
  'Idempotence keys for notifications emitted by the scheduler (reminders, starting-soon, '
  'organizer alerts). Rows go with the gathering; the job prunes marks older than 90 days.';

CREATE INDEX idx_notification_marks_created_at ON public.notification_marks USING btree (created_at);

-- -----------------------------------------------------------------------------
-- 4. Co-host invites: decline, and delivery by email
-- -----------------------------------------------------------------------------
ALTER TABLE public.cohost_invites DROP CONSTRAINT IF EXISTS cohost_invites_status_check;
ALTER TABLE public.cohost_invites ADD CONSTRAINT cohost_invites_status_check
  CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'revoked'));

ALTER TABLE public.cohost_invites
  ADD COLUMN IF NOT EXISTS declined_at timestamptz,
  ADD COLUMN IF NOT EXISTS declined_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS emailed_at timestamptz;

COMMENT ON COLUMN public.cohost_invites.emailed_at IS
  'When the link was emailed to the address the inviter typed. The address itself is never '
  'stored: an invite names nobody until someone accepts it (spec §4.2).';
COMMENT ON COLUMN public.cohost_invites.declined_by IS
  'Who declined, when a signed-in person declined explicitly; NULL for an anonymous decline.';
