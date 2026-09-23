-- =============================================================================
-- 0034_subject_rights_conduct_calendar.sql
--   · per-gathering code of conduct and its acceptance (MT §12.19)
--   · check-in as a gate on attendance voting (MT §12.14)
--   · subscribable per-member calendar feeds (MT §12.8)
--   · the one schema change account deletion needs: money facts keep no holder (spec §9)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Per-event code of conduct / terms, accepted on joining
-- ---------------------------------------------------------------------------
--
-- The document itself is a URL, not markdown in our database: a gathering's conduct policy is
-- usually a page it already publishes, and a link is one fewer copy of someone else's text for
-- us to hold, version and get wrong. `require_conduct_acceptance` makes ticking acceptance a
-- condition of joining; `event_members.conduct_accepted_at` is the record that they did.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS code_of_conduct_url text,
  ADD COLUMN IF NOT EXISTS require_conduct_acceptance boolean NOT NULL DEFAULT false,
  -- MT §12.14: optionally, only people who have been checked in may vote in the attendance
  -- round. Off by default; a gathering with no check-in desk must not lock its own room out.
  ADD COLUMN IF NOT EXISTS checkin_gates_voting boolean NOT NULL DEFAULT false;

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_code_of_conduct_url_check;
ALTER TABLE public.events
  ADD CONSTRAINT events_code_of_conduct_url_check CHECK (
    code_of_conduct_url IS NULL OR (length(code_of_conduct_url) <= 500 AND code_of_conduct_url ~* '^https?://')
  );

COMMENT ON COLUMN public.events.code_of_conduct_url IS
  'Link to this gathering''s own code of conduct or terms. Shown wherever someone is about to join.';
COMMENT ON COLUMN public.events.require_conduct_acceptance IS
  'When true, joining requires ticking acceptance and stamps event_members.conduct_accepted_at.';
COMMENT ON COLUMN public.events.checkin_gates_voting IS
  'MT §12.14: when true, only people checked in at the door may vote in the attendance round.';

ALTER TABLE public.event_members
  ADD COLUMN IF NOT EXISTS conduct_accepted_at timestamptz;

COMMENT ON COLUMN public.event_members.conduct_accepted_at IS
  'When this member accepted the gathering''s code of conduct. Per-gathering, like the membership it sits on; never published.';

-- ---------------------------------------------------------------------------
-- Subscribable calendar feeds
-- ---------------------------------------------------------------------------
--
-- A calendar client cannot hold a session cookie, so a subscription URL carries its own
-- credential. Same rules as `assistant_tokens` (0028) and magic links: only the sha256 is
-- stored, the token is shown once, and it reads exactly what its owner can read — here, the
-- sessions that owner has saved. Server-only.
CREATE TABLE IF NOT EXISTS public.calendar_feed_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS calendar_feed_tokens_account_idx
  ON public.calendar_feed_tokens (account_id, created_at DESC) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.calendar_feed_tokens IS
  'Per-member subscription credentials for the personal .ics feed. Server-only; only the sha256 of the token is stored. Revocable from Account → Notifications.';
COMMENT ON COLUMN public.calendar_feed_tokens.last_used_at IS
  'Last fetch by a calendar client, written at most once an hour (clients poll on their own schedule).';

REVOKE ALL ON public.calendar_feed_tokens FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Account deletion: the person goes, the money fact stays
-- ---------------------------------------------------------------------------
--
-- Spec §9 keeps ticket amounts for the revenue totals while reducing payment identifiers, and
-- `checkout_references.holder_account_id` is already ON DELETE SET NULL for exactly that
-- reason. `tickets.user_id` was ON DELETE CASCADE, which would take the amount with the
-- person and silently change a gathering's books when someone exercises their right to be
-- forgotten. A ticket with no holder admits nobody — every entitlement check joins on
-- `user_id`, and NULL matches no one — so detaching is safe as well as correct.
ALTER TABLE public.tickets ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.tickets DROP CONSTRAINT IF EXISTS tickets_user_id_fkey;
ALTER TABLE public.tickets
  ADD CONSTRAINT tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tickets.user_id IS
  'The holder. NULL once the holder deleted their account: the amount, fee and currency stay for the gathering''s totals, the person does not. A holderless ticket admits nobody.';
