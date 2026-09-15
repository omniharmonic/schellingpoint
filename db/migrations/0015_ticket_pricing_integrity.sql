-- A gathering uses one currency. Historical tickets and open payment pages retain
-- their price; organizers create another tier when changing a tier already in use.
CREATE FUNCTION public.enforce_ticket_pricing() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('ticket-pricing:' || NEW.event_id::text, 0));
  IF NEW.currency NOT IN ('usd','eur','gbp','cad','aud','nzd','chf') THEN
    RAISE EXCEPTION 'Choose a supported currency: USD, EUR, GBP, CAD, AUD, NZD or CHF' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM ticket_tiers WHERE event_id = NEW.event_id AND id <> NEW.id AND currency <> NEW.currency) THEN
    RAISE EXCEPTION 'All ticket tiers in an event must use the same currency' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.price_cents <> OLD.price_cents OR NEW.currency <> OLD.currency)
    AND EXISTS (SELECT 1 FROM tickets WHERE tier_id = NEW.id) THEN
    RAISE EXCEPTION 'This tier has tickets or open checkouts. Create a new tier to change its price or currency' USING ERRCODE = '23514';
  END IF;
  IF NEW.quantity_total IS NOT NULL AND NEW.quantity_total < (
    SELECT count(*) FROM tickets WHERE tier_id = NEW.id AND
      (status IN ('confirmed','checked_in') OR (status = 'pending' AND hold_expires_at > now()))
  ) THEN
    RAISE EXCEPTION 'Capacity cannot be lower than confirmed tickets and current checkout holds' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_ticket_pricing() FROM PUBLIC;
CREATE TRIGGER enforce_ticket_pricing BEFORE INSERT OR UPDATE OF price_cents, currency, quantity_total
  ON public.ticket_tiers FOR EACH ROW EXECUTE FUNCTION public.enforce_ticket_pricing();
