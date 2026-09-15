-- 0010: sign-up / sign-in abuse controls for POST /api/auth/email.
--
-- A per-email limit alone let a script mint unlimited PDS accounts by cycling addresses and
-- mail-bomb a victim from many IPs. The request's client IP is recorded ONLY as a keyed hash
-- (hmac-sha256(ATPROTO_SESSION_SECRET, ip), truncated; an IPv6 address is bucketed to its /64 first),
-- never raw, and lives exactly as long as its token row: the retention job deletes every token that
-- has expired and is more than an hour old (sign-in links expire after 15 min, reveal links after
-- 24 h; the hour keeps the rate-limit window whole), and the hash goes with it.
--
-- mints_account marks the request that asked for a brand-new identity, so per-IP mint quotas can be
-- counted without joining accounts to IPs.

ALTER TABLE public.auth_email_tokens
  ADD COLUMN IF NOT EXISTS ip_hash text,
  ADD COLUMN IF NOT EXISTS mints_account boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.auth_email_tokens.ip_hash IS
  'Truncated HMAC-SHA256 of the requesting client IP (IPv6 bucketed to /64). Never the raw address. Rate limiting only.';
COMMENT ON COLUMN public.auth_email_tokens.mints_account IS
  'True when this sign-in request asked for a new custodial identity (per-IP mint quota).';

CREATE INDEX IF NOT EXISTS auth_email_tokens_ip_hash_idx
  ON public.auth_email_tokens USING btree (ip_hash, created_at);

-- The global mint cap counts custodial accounts created in the last hour.
CREATE INDEX IF NOT EXISTS accounts_custodial_created_at_idx
  ON public.accounts USING btree (created_at) WHERE kind = 'custodial';
