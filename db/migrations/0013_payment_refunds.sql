-- Webhooks may arrive in either order. Keep a private payment tombstone even
-- when Checkout completion has not yet attached the intent to a ticket.
CREATE TABLE public.refunded_payments (
  payment_intent_id text PRIMARY KEY,
  refunded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.refunded_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.refunded_payments FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.refunded_payments TO service_role;

CREATE OR REPLACE FUNCTION public.has_ticket_entitlement(gathering_id uuid, account_id uuid, action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM events e WHERE e.id = gathering_id
      AND (auth.uid() IS NULL OR auth.uid() = account_id) AND (
      NOT e.ticketing_enabled
      OR EXISTS (SELECT 1 FROM event_members m WHERE m.event_id = e.id
        AND m.user_id = account_id AND m.role IN ('owner', 'admin', 'moderator'))
      OR EXISTS (SELECT 1 FROM tickets t JOIN ticket_tiers tt ON tt.id = t.tier_id AND tt.event_id = e.id
        WHERE t.event_id = e.id AND t.user_id = account_id AND t.status IN ('confirmed', 'checked_in')
        AND (action <> 'propose' OR tt.allows_proposals))
    )
  );
$$;
