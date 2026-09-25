-- =============================================================================
-- 0040_stripe_connect_attempts.sql — let a failed merchant creation be retried
-- =============================================================================
--
-- Creating a gathering's merchant account carries a Stripe idempotency key so that two
-- "Connect" clicks cannot orphan two accounts. The key used to be the event id alone
-- (`unconference-merchant-v1-<eventId>`), and Stripe caches the *answer* against a key for
-- 24 hours — including a failure. When the first attempt failed for an environmental reason
-- (Connect not yet enabled on the platform), every later click replayed that stale 400 and the
-- organizer could not connect at all until the next day.
--
-- This counter scopes the key to one attempt: `…-<eventId>-<stripe_connect_attempts>`. It is
-- incremented only when a create call *fails*, so
--
--   * a retry after a failure uses a fresh key and reaches Stripe properly, and
--   * two clicks within one attempt still share a key and therefore still collapse to one
--     account — the property the key existed for.
--
-- It is a counter of failures, not of accounts: a successful create never touches it. Nothing
-- reads it outside `src/lib/payments/connect.ts`, and it is never published anywhere.
--
-- `events` already carries RLS (0002) and the private-by-default rule of 0009 needs no change
-- for an added column.
ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS stripe_connect_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_stripe_connect_attempts_nonneg;
ALTER TABLE public.events ADD CONSTRAINT events_stripe_connect_attempts_nonneg
  CHECK (stripe_connect_attempts >= 0);

COMMENT ON COLUMN public.events.stripe_connect_attempts IS
  'Failed merchant-create attempts. Scopes the Stripe idempotency key so a failure can be retried (0040).';
