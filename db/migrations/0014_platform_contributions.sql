-- Organizer-selected contribution; public event reads may show this rate. Payment
-- amounts remain on the existing private ticket rows and never enter ATProto.
ALTER TABLE public.events ADD COLUMN platform_fee_percent numeric(5,2) NOT NULL DEFAULT 1
  CHECK (platform_fee_percent >= 1 AND platform_fee_percent <= 100);
ALTER TABLE public.tickets
  ADD COLUMN platform_fee_cents integer CHECK (platform_fee_cents >= 0),
  ADD COLUMN paid_currency text,
  ADD COLUMN quoted_price_cents integer CHECK (quoted_price_cents >= 0);
-- Preserve historical accounting under the previous fee contract.
UPDATE public.tickets t SET platform_fee_cents = CASE
  WHEN e.stripe_account_id IS NOT NULL AND t.amount_paid_cents > 0
    THEN round(t.amount_paid_cents * 0.05)::int + 50 ELSE 0 END,
  paid_currency = tt.currency
FROM public.events e, public.ticket_tiers tt
WHERE t.event_id = e.id AND t.tier_id = tt.id AND t.amount_paid_cents IS NOT NULL;
