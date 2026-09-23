-- =============================================================================
-- 0029_checkout_references.sql — the immutable quote behind every paid checkout
-- =============================================================================
--
-- Direct charges put the money on the organizer's own merchant account: the Checkout Session
-- is created in *their* API context and the webhook for it is delivered with their account id
-- in the event envelope (`event.account`). A connected merchant can create payments and
-- metadata of their own, so a webhook's metadata proves nothing. Admission is therefore never
-- granted from metadata: before settling, expiring or refunding anything the AppView resolves
-- this row by the Stripe session id and requires that
--
--   reference.connected_account_id = the delivered account       (`event.account`)
--                                  = events.stripe_account_id    (the gathering today)
--
-- and then settles against the price, currency and contribution recorded *here*, not against
-- anything the delivery carried. `events.stripe_account_id` alone is not a reference: it is
-- mutable, and an organizer may reconnect a different account while a checkout is open.
--
-- `model` records which charge model produced the session, so a session opened before the
-- direct-charge migration still settles under the rules it was created with:
--   direct       the organizer's account is the merchant of record; the platform takes
--                `application_fee_amount`; Stripe's processing fees come off that account.
--   destination  legacy: the platform was the merchant and transferred to the organizer.
--                None exist in production; the path is kept so an old row cannot be
--                mis-settled as a direct charge.
--   platform     no connected account at all (the opt-in STRIPE_ALLOW_PLATFORM_CHARGES
--                fallback). The platform is the merchant and there is no application fee.
--
-- Privacy (spec §9). These are money facts, so they are not deleted when they age; the holder
-- is forgotten instead. The retention rule `checkout_references_holder_90d` nulls
-- `holder_account_id` 90 days after the reference reached a terminal state, leaving an
-- unlinkable amount/fee/currency row. Deleting the gathering or the account removes or
-- anonymises the row immediately — this must never become an indefinite identity-linked
-- payment ledger.
--
-- Server-only: 0009's default privileges already revoke everything from anon/authenticated;
-- the REVOKE below is defence in depth and documents the intent. There is no RLS policy
-- because no signed-in role can reach the table at all.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.checkout_references (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The Stripe Checkout Session id. Unique: one reference per session, ever.
  session_id text NOT NULL UNIQUE,
  -- The connected merchant account the session was created in. NULL only for `platform`.
  connected_account_id text,
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  tier_id uuid REFERENCES public.ticket_tiers(id) ON DELETE SET NULL,
  -- The capacity hold this checkout was opened for. The expired-hold sweep deletes pending
  -- tickets, so this goes to NULL while the money facts stay; a late payment is still settled
  -- from tier_id + holder_account_id, against the quote recorded here.
  ticket_id uuid REFERENCES public.tickets(id) ON DELETE SET NULL,
  holder_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  unit_amount integer NOT NULL CHECK (unit_amount >= 0),
  currency text NOT NULL,
  contribution_percent numeric(5,2) NOT NULL CHECK (contribution_percent >= 0 AND contribution_percent <= 100),
  application_fee_amount integer NOT NULL DEFAULT 0 CHECK (application_fee_amount >= 0),
  model text NOT NULL CHECK (model IN ('direct', 'destination', 'platform')),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  expired_at timestamptz,
  -- Set only by a *full* refund: the moment admission was revoked.
  refunded_at timestamptz,
  -- How much of the sale and of the contribution has gone back, in the smallest currency
  -- unit. Partial refunds accumulate here and leave admission alone; only a refund covering
  -- the whole `unit_amount` sets `refunded_at` and cancels the ticket.
  refunded_amount integer NOT NULL DEFAULT 0 CHECK (refunded_amount >= 0),
  application_fee_refunded_amount integer NOT NULL DEFAULT 0 CHECK (application_fee_refunded_amount >= 0),
  -- A connected account and the platform fallback are mutually exclusive.
  CONSTRAINT checkout_reference_account_model CHECK ((model = 'platform') = (connected_account_id IS NULL)),
  -- The fee can never exceed what was charged.
  CONSTRAINT checkout_reference_fee_within_price CHECK (application_fee_amount <= unit_amount),
  -- Nothing can be given back that was never taken.
  CONSTRAINT checkout_reference_refund_within_price CHECK (refunded_amount <= unit_amount),
  CONSTRAINT checkout_reference_fee_refund_within_fee CHECK (application_fee_refunded_amount <= application_fee_amount)
);

CREATE INDEX IF NOT EXISTS checkout_references_event_idx
  ON public.checkout_references (event_id, created_at DESC);
-- The retention sweep: rows still carrying a holder.
CREATE INDEX IF NOT EXISTS checkout_references_holder_idx
  ON public.checkout_references (holder_account_id) WHERE holder_account_id IS NOT NULL;

-- Immutability. Everything that binds the quote to a session is write-once; only the
-- lifecycle timestamps move forward, and `holder_account_id` may only be cleared (by the
-- retention sweep or by the account going away). `ticket_id` may only be cleared, by the
-- expired-hold sweep, and set again only when a delayed payment rebuilds the swept seat. A
-- settlement that tried to rewrite the price it verifies against would
-- defeat the point of the table, so the database refuses it rather than trusting the caller.
CREATE OR REPLACE FUNCTION public.enforce_checkout_reference_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.connected_account_id IS DISTINCT FROM OLD.connected_account_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.tier_id IS DISTINCT FROM OLD.tier_id
     OR NEW.unit_amount IS DISTINCT FROM OLD.unit_amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.contribution_percent IS DISTINCT FROM OLD.contribution_percent
     OR NEW.application_fee_amount IS DISTINCT FROM OLD.application_fee_amount
     OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A checkout reference is immutable once written' USING ERRCODE = '42501';
  END IF;
  IF NEW.holder_account_id IS NOT NULL AND NEW.holder_account_id IS DISTINCT FROM OLD.holder_account_id THEN
    RAISE EXCEPTION 'A checkout reference cannot be reassigned to another holder' USING ERRCODE = '42501';
  END IF;
  -- `ticket_id` may be cleared (the expired-hold sweep) and may be filled in again once, when
  -- a delayed payment rebuilds the seat the sweep removed. What it may never do is move from
  -- one live ticket to another: that would let a settlement point a recorded sale at somebody
  -- else's admission.
  IF NEW.ticket_id IS NOT NULL AND OLD.ticket_id IS NOT NULL
     AND NEW.ticket_id IS DISTINCT FROM OLD.ticket_id THEN
    RAISE EXCEPTION 'A checkout reference cannot be reassigned to another ticket' USING ERRCODE = '42501';
  END IF;
  -- Refunded totals only ever grow: money that went back cannot be un-sent.
  IF NEW.refunded_amount < OLD.refunded_amount
     OR NEW.application_fee_refunded_amount < OLD.application_fee_refunded_amount THEN
    RAISE EXCEPTION 'A refunded amount cannot be reduced' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_checkout_reference_immutable() FROM PUBLIC;

DROP TRIGGER IF EXISTS enforce_checkout_reference_immutable ON public.checkout_references;
CREATE TRIGGER enforce_checkout_reference_immutable BEFORE UPDATE ON public.checkout_references
  FOR EACH ROW EXECUTE FUNCTION public.enforce_checkout_reference_immutable();

COMMENT ON TABLE public.checkout_references IS
  'Immutable, server-only quote for one Stripe Checkout Session: session, connected account, gathering, tier, holder, price, currency, contribution and charge model. Settlement, expiry and refund must resolve this row by session id and match both the delivered account and the gathering''s connected account before granting or revoking admission. Never readable by anon or authenticated.';
COMMENT ON COLUMN public.checkout_references.connected_account_id IS
  'The Stripe account the session was created in. Must equal the webhook envelope''s account id and the gathering''s current stripe_account_id before anything is settled. NULL only for the platform-charge fallback.';
COMMENT ON COLUMN public.checkout_references.model IS
  'direct = organizer is merchant of record, platform takes application_fee_amount, Stripe processing fees come off the organizer''s account. destination = legacy platform-scoped charge with transfer_data. platform = no connected account.';
COMMENT ON COLUMN public.checkout_references.application_fee_amount IS
  'The platform contribution collected at settlement, in the smallest currency unit. A refund does NOT return it: Stripe only reverses an application fee when the refund explicitly asks for it, and the app never asks. refunded_at records the refund; this amount stays as the fee that was collected.';
COMMENT ON COLUMN public.checkout_references.holder_account_id IS
  'Cleared 90 days after the reference reaches a terminal state (retention rule checkout_references_holder_90d), and immediately if the account is deleted. The money facts remain; the person does not.';
COMMENT ON COLUMN public.checkout_references.ticket_id IS
  'The capacity hold this checkout was opened for. Cleared by the expired-hold sweep; settlement then rebuilds the ticket from tier_id and holder_account_id against this row''s quote.';

REVOKE ALL ON public.checkout_references FROM anon, authenticated;

-- =============================================================================
-- Delivery ledger: idempotency by Stripe event id
-- =============================================================================
--
-- Stripe guarantees at-least-once delivery and no ordering. Every handler here was already
-- written to converge, but converging is not the same as *not running twice*: a refund issued
-- from a redelivered event, or a notification sent again, is a real effect. So each delivery
-- is claimed by its own event id before it is processed and released afterwards, and a claim
-- that is already `processed_at` is dropped on the floor.
--
-- The ledger holds no money and no person: an opaque Stripe event id, its type, the connected
-- account it arrived on, and two timestamps. It is swept after 30 days
-- (retention rule `stripe_events_30d`) — long past Stripe's own retry window.
--
-- Server-only, like everything else in this file.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stripe_events (
  id text PRIMARY KEY,
  type text NOT NULL,
  account text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  -- A paid delivery this application refused to act on: the machine-readable reason, the
  -- Stripe session it named, and the gathering it belongs to when that could be established.
  -- A refusal means a buyer's card was charged and no admission was granted, so it is a fact
  -- somebody has to see — not a line in a log file. The revenue page reads these.
  rejection text,
  session_id text,
  event_id uuid REFERENCES public.events(id) ON DELETE SET NULL
);

-- Idempotent for a re-run of this migration against a database that already has the table.
ALTER TABLE public.stripe_events
  ADD COLUMN IF NOT EXISTS rejection text,
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS event_id uuid REFERENCES public.events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS stripe_events_received_idx ON public.stripe_events (received_at);
-- The organizer-facing list of unsettled payments.
CREATE INDEX IF NOT EXISTS stripe_events_rejection_idx
  ON public.stripe_events (event_id, received_at DESC) WHERE rejection IS NOT NULL;

COMMENT ON TABLE public.stripe_events IS
  'One row per Stripe webhook delivery, claimed by event id before processing so redeliveries and out-of-order deliveries cannot repeat an effect. Server-only; swept after 30 days.';
COMMENT ON COLUMN public.stripe_events.rejection IS
  'Set when a paid delivery could not be matched to a checkout this application opened (NO_REFERENCE, EVENT_ACCOUNT_CHANGED, AMOUNT_MISMATCH). The money was taken and no ticket was issued, so the organizer is shown it on the revenue page; where the payment is provably ours it is also refunded automatically.';
COMMENT ON COLUMN public.stripe_events.processed_at IS
  'Set when the handler finished. A delivery that arrives again with this already set is ignored; one that arrives while it is null is retried (the previous attempt crashed).';

REVOKE ALL ON public.stripe_events FROM anon, authenticated;

-- =============================================================================
-- Merchant capability cache, and pausing paid sales when a merchant loses it
-- =============================================================================
--
-- `account.updated` (and its v2 equivalent) is how Stripe tells a platform that a connected
-- merchant's capabilities changed — verification lapsed, a document expired, payouts were
-- disabled. Until now this application only learned that by asking at checkout time, which
-- means a gathering could keep advertising paid tickets for a merchant that can no longer be
-- charged. These columns hold what Stripe last told us, and `paid_sales_paused_at` records
-- that the loss was noticed: the readiness gate refuses paid sales while it is set, and the
-- owners and admins are notified once.
--
-- Free tickets are unaffected: `ticketing_enabled` is never flipped by Stripe. Admission
-- already granted is never revoked by a capability change.
-- =============================================================================

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean,
  ADD COLUMN IF NOT EXISTS stripe_payouts_enabled boolean,
  ADD COLUMN IF NOT EXISTS stripe_status_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_sales_paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS paid_sales_paused_reason text;

COMMENT ON COLUMN public.events.stripe_charges_enabled IS
  'What Stripe last reported for this gathering''s merchant account (account.updated, or a readiness read). NULL means never checked. Advisory: a live readiness read always wins.';
COMMENT ON COLUMN public.events.paid_sales_paused_at IS
  'Set when Stripe reported that the merchant account can no longer take charges or receive payouts. Paid checkout is refused while it is set; free tickets and existing admission are untouched. Cleared when the capability comes back.';

-- A gathering's merchant account is looked up by id when `account.updated` arrives.
CREATE INDEX IF NOT EXISTS events_stripe_account_idx
  ON public.events (stripe_account_id) WHERE stripe_account_id IS NOT NULL;

-- =============================================================================
-- Two notifications the payment paths need
-- =============================================================================
--   ticket_refunded  the holder, when a refund revoked their admission (transactional).
--   payments_paused  owners and admins, when Stripe suspended the merchant account.
-- =============================================================================

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS valid_notification_type;
ALTER TABLE public.notifications ADD CONSTRAINT valid_notification_type CHECK (type IN (
  'session_submitted', 'session_approved', 'session_rejected', 'session_scheduled',
  'session_rescheduled', 'session_cancelled', 'vote_milestone',
  'cohost_invited', 'cohost_accepted', 'cohost_declined',
  'voting_opened', 'voting_closed', 'schedule_published', 'event_reminder', 'admin_announcement',
  'new_proposal', 'proposal_needs_review',
  'proposal_changed', 'approval_requested', 'event_invitation', 'ticket_confirmed',
  'ticket_refunded', 'payments_paused'
));

CREATE OR REPLACE FUNCTION public.notification_category(p_type text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_type
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
    WHEN 'ticket_refunded'      THEN 'event_announcements'
    WHEN 'new_proposal'         THEN 'admin_alerts'
    WHEN 'proposal_needs_review' THEN 'admin_alerts'
    WHEN 'proposal_changed'     THEN 'admin_alerts'
    WHEN 'approval_requested'   THEN 'admin_alerts'
    WHEN 'payments_paused'      THEN 'admin_alerts'
    ELSE 'session_updates'
  END
$$;
