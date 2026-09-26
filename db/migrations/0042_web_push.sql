-- Device subscriptions are credentials: service-only, deleted at sign-out/account deletion.
CREATE TABLE public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES public.at_sessions(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.push_deliveries (
  notification_id uuid NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES public.push_subscriptions(id) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (notification_id, subscription_id)
);
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_subscriptions, public.push_deliveries FROM anon, authenticated;
CREATE INDEX push_subscriptions_user ON public.push_subscriptions(user_id);
CREATE INDEX push_deliveries_pending ON public.push_deliveries(claimed_at) WHERE completed_at IS NULL;
