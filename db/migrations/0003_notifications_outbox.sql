-- =============================================================================
-- 0003_notifications_outbox.sql — work package E
-- =============================================================================
-- Notifications become application events (spec §6, plan §6 item 24):
--   * the notification triggers are dropped; code emits `notify()` inside the
--     transaction of the action (src/lib/notifications)
--   * notifications is the outbox: `dispatchPending()` claims unsent rows,
--     applies preferences and a per-recipient rate limit, sends, and records
--     the outcome
--   * ticket confirmation (membership + `ticket_confirmed`) moves from the
--     trigger into src/lib/tickets
--   * retention (spec §9) needs nullable inviter columns
--
-- Every DROP uses IF EXISTS so this file applies whether or not package C's
-- 0002 (which drops trigger_vote_milestone) has run first.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Notification and membership triggers → application code
-- -----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_new_proposal ON public.sessions;
DROP FUNCTION IF EXISTS public.notify_new_proposal();

DROP TRIGGER IF EXISTS trigger_session_status_change ON public.sessions;
DROP FUNCTION IF EXISTS public.notify_session_status_change();

DROP TRIGGER IF EXISTS trigger_cohost_response ON public.cohost_invites;
DROP FUNCTION IF EXISTS public.notify_cohost_response();

DROP TRIGGER IF EXISTS trigger_add_ticket_holder_as_member ON public.tickets;
DROP FUNCTION IF EXISTS public.add_ticket_holder_as_member();

-- -----------------------------------------------------------------------------
-- 2. notifications: types, outbox columns, indexes
-- -----------------------------------------------------------------------------
-- `vote_milestone` stays allowed until package C removes its trigger; nothing
-- emits it any more (a milestone leaks a live tally, spec §5.3).
ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS valid_notification_type;
ALTER TABLE public.notifications ADD CONSTRAINT valid_notification_type CHECK (type IN (
  'session_submitted', 'session_approved', 'session_rejected', 'session_scheduled',
  'session_rescheduled', 'session_cancelled', 'vote_milestone',
  'cohost_invited', 'cohost_accepted', 'cohost_declined',
  'voting_opened', 'voting_closed', 'schedule_published', 'event_reminder', 'admin_announcement',
  'new_proposal', 'proposal_needs_review',
  'proposal_changed', 'approval_requested', 'event_invitation', 'ticket_confirmed'
));

-- Outbox bookkeeping. `email_sent_at` is "handled" (sent or deliberately skipped);
-- `email_outcome` says which. `email_claimed_at` fences concurrent dispatchers.
ALTER TABLE public.notifications
  ADD COLUMN email_outcome text,
  ADD COLUMN email_attempts smallint NOT NULL DEFAULT 0,
  ADD COLUMN email_claimed_at timestamptz;

ALTER TABLE public.notifications ADD CONSTRAINT notifications_email_outcome_check CHECK (
  email_outcome IS NULL OR email_outcome IN (
    'sent',          -- the mail provider accepted it
    'dev_logged',    -- mail not configured (development): logged, not delivered
    'opted_out',     -- the recipient's preference for this category is off
    'no_email',      -- the account has no verified email (e.g. Bluesky door)
    'rate_limited',  -- stayed over the per-recipient limit for 24 hours
    'failed'         -- the provider refused it on every attempt
  )
);

COMMENT ON COLUMN public.notifications.email_outcome IS
  'How the email channel resolved this row; NULL while pending. Set together with email_sent_at.';

-- Dispatcher: pending rows, oldest first, grouped per recipient for the rate limit.
DROP INDEX IF EXISTS public.idx_notifications_pending_email;
CREATE INDEX idx_notifications_pending_email
  ON public.notifications USING btree (created_at, user_id)
  WHERE email_sent_at IS NULL;

-- Rate limit: emails actually handed to the transport in the last hour.
CREATE INDEX idx_notifications_recent_email
  ON public.notifications USING btree (user_id, email_sent_at)
  WHERE email_outcome IN ('sent', 'dev_logged');

-- Feed: keyset pagination on (created_at desc, id desc), with and without an event filter.
DROP INDEX IF EXISTS public.idx_notifications_user_all;
CREATE INDEX idx_notifications_feed
  ON public.notifications USING btree (user_id, created_at DESC, id DESC);
CREATE INDEX idx_notifications_feed_event
  ON public.notifications USING btree (user_id, event_id, created_at DESC, id DESC);

-- Retention (90 days).
CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at);

-- -----------------------------------------------------------------------------
-- 3. Categories and preferences
-- -----------------------------------------------------------------------------
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
    WHEN 'vote_milestone'       THEN 'voting_updates'
    WHEN 'cohost_invited'       THEN 'collaboration'
    WHEN 'cohost_accepted'      THEN 'collaboration'
    WHEN 'cohost_declined'      THEN 'collaboration'
    WHEN 'voting_opened'        THEN 'event_announcements'
    WHEN 'voting_closed'        THEN 'event_announcements'
    WHEN 'schedule_published'   THEN 'event_announcements'
    WHEN 'event_reminder'       THEN 'event_announcements'
    WHEN 'admin_announcement'   THEN 'event_announcements'
    WHEN 'event_invitation'     THEN 'event_announcements'
    WHEN 'ticket_confirmed'     THEN 'event_announcements'
    WHEN 'new_proposal'         THEN 'admin_alerts'
    WHEN 'proposal_needs_review' THEN 'admin_alerts'
    WHEN 'proposal_changed'     THEN 'admin_alerts'
    WHEN 'approval_requested'   THEN 'admin_alerts'
    ELSE 'session_updates'
  END
$$;

-- should_send_notification(user, event, type, channel) is kept as is: event-specific
-- preference, then the global one, then defaults (email and in-app on, push off).

-- Global preferences (event_id NULL) were not unique: NULLs never conflict in the
-- (user_id, event_id, category) constraint. Keep the newest row, then enforce it.
DELETE FROM public.notification_preferences p
USING public.notification_preferences newer
WHERE p.event_id IS NULL AND newer.event_id IS NULL
  AND p.user_id = newer.user_id AND p.category = newer.category
  AND (p.updated_at, p.id) < (newer.updated_at, newer.id);
CREATE UNIQUE INDEX notification_preferences_global_key
  ON public.notification_preferences USING btree (user_id, category)
  WHERE event_id IS NULL;

-- -----------------------------------------------------------------------------
-- 4. emit_notifications(): the insert behind notify()
-- -----------------------------------------------------------------------------
-- notify() runs inside the action's transaction, which for participation writes is
-- an asAccount() transaction (role `authenticated`, RLS on). notifications has no
-- INSERT policy — a person must not be able to write into someone else's feed — so
-- the insert goes through this definer function. `authenticated` is reachable only
-- from server code (there is no browser database access, plan §1).
CREATE FUNCTION public.emit_notifications(
  p_event_id uuid,
  p_user_ids uuid[],
  p_type text,
  p_title text,
  p_body text,
  p_action_url text,
  p_data jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer;
BEGIN
  INSERT INTO public.notifications (user_id, event_id, type, title, body, action_url, data)
  SELECT DISTINCT recipient, p_event_id, p_type, p_title, p_body, p_action_url, coalesce(p_data, '{}'::jsonb)
  FROM unnest(p_user_ids) AS recipient
  WHERE recipient IS NOT NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.emit_notifications(uuid, uuid[], text, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.emit_notifications(uuid, uuid[], text, text, text, text, jsonb) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 5. Tickets: entitlements bound to the account, no stored bearer tokens
-- -----------------------------------------------------------------------------
-- QR tokens are short-lived JWTs minted on request (spec §5.5); a stored 90-day
-- token was a long-lived bearer credential sitting in the database.
DROP INDEX IF EXISTS public.idx_tickets_qr;
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_qr_code_key;
ALTER TABLE public.tickets DROP COLUMN IF EXISTS qr_code;
ALTER TABLE public.tickets DROP COLUMN IF EXISTS qr_generated_at;

-- One live ticket per holder per tier; retries reuse the pending row.
CREATE UNIQUE INDEX tickets_one_live_per_holder_tier
  ON public.tickets USING btree (tier_id, user_id)
  WHERE status IN ('pending', 'confirmed', 'checked_in');

CREATE INDEX idx_tickets_event_user ON public.tickets USING btree (event_id, user_id);

-- A deleted volunteer account must not block deletion or keep a name on a check-in.
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_checked_in_by_fkey;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_checked_in_by_fkey
  FOREIGN KEY (checked_in_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 6. Retention (spec §9): inviters are nulled 30 days after acceptance
-- -----------------------------------------------------------------------------
ALTER TABLE public.event_invitations ALTER COLUMN created_by DROP NOT NULL;
ALTER TABLE public.event_invitations DROP CONSTRAINT IF EXISTS event_invitations_created_by_fkey;
ALTER TABLE public.event_invitations ADD CONSTRAINT event_invitations_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES public.accounts(id) ON DELETE SET NULL;

ALTER TABLE public.cohost_invites ALTER COLUMN created_by DROP NOT NULL;

COMMENT ON COLUMN public.event_invitations.created_by IS
  'Inviter; NULL once the invitation has been accepted for 30 days (retention job), so the invite tree cannot be reconstructed.';
COMMENT ON COLUMN public.cohost_invites.created_by IS
  'Inviter; NULL once the invitation has been accepted for 30 days (retention job).';

-- -----------------------------------------------------------------------------
-- 7. Capacity holds for paid checkout
-- -----------------------------------------------------------------------------
-- A paid checkout reserves its seat with a `pending` ticket whose `hold_expires_at`
-- equals the Stripe Checkout session's `expires_at`. Capacity is confirmed tickets
-- plus unexpired holds, counted under a row lock on the tier (src/lib/tickets).
-- Expired holds count for nothing and are deleted by the retention job.
--
-- `refund_needed`: money arrived for a checkout that no longer has a seat (the hold
-- expired and the tier filled, or the holder paid twice). It occupies no capacity,
-- is shown on the organizer revenue page, and becomes `cancelled` on refund.
ALTER TABLE public.tickets
  ADD COLUMN hold_expires_at timestamptz,
  ADD COLUMN checkout_session_id text;

ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_status_check
  CHECK (status IN ('pending', 'confirmed', 'cancelled', 'checked_in', 'refund_needed'));

-- A pending row is always a hold with an expiry.
UPDATE public.tickets SET hold_expires_at = created_at + interval '30 minutes'
WHERE status = 'pending' AND hold_expires_at IS NULL;
ALTER TABLE public.tickets ADD CONSTRAINT tickets_pending_has_hold
  CHECK (status <> 'pending' OR hold_expires_at IS NOT NULL);

-- Capacity counts per tier; the webhook finds a hold by its checkout session.
CREATE INDEX idx_tickets_tier_capacity ON public.tickets USING btree (tier_id, status, hold_expires_at);
CREATE INDEX idx_tickets_checkout_session ON public.tickets USING btree (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

COMMENT ON COLUMN public.tickets.hold_expires_at IS
  'For pending tickets: when the capacity hold lapses (equals the Stripe Checkout session expiry).';
