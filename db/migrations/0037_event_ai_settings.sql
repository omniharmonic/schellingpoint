-- =============================================================================
-- 0037_event_ai_settings.sql — the gathering's own answer-model key
-- =============================================================================
--
-- Design (2026-09-25 place/people/knowledge §2.1): "Ask the gathering", session summaries and
-- themes need a chat model. Until now that meant a deployment-wide `ANTHROPIC_API_KEY`, so a
-- fresh install had no answers at all. An owner or admin can now paste their own key for their
-- own gathering: Anthropic, or any OpenAI-compatible server at an https `base_url`
-- (OpenAI, OpenRouter, Together, a self-hosted model). Resolution order for every answer:
-- this table → the deployment key → none.
--
-- The key is sealed with AES-256-GCM under the deployment's `APP_SECRETS_KEY`
-- (`src/lib/secrets/aead.ts`), with the gathering's id as associated data: a row moved to
-- another gathering, or a byte changed anywhere in the sealed blob, fails to open rather than
-- decrypting to something. Only `key_last4` is ever shown back — the key itself is never
-- returned by any route, never logged, and never leaves the server except in the request to the
-- provider the organizer named.
--
-- Server-only, like every other credential table (0009's default privileges already revoke;
-- the REVOKE below is defence in depth and documents the intent). Read and written only on the
-- AppView's service connection, never inside an `asAccount` transaction, and with no RLS policy
-- because no signed-in role can reach it at all.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.event_ai_settings (
  event_id uuid PRIMARY KEY REFERENCES public.events(id) ON DELETE CASCADE,
  provider text NOT NULL,
  base_url text,
  key_ciphertext bytea NOT NULL,
  key_last4 text NOT NULL,
  model text,
  set_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.event_ai_settings DROP CONSTRAINT IF EXISTS event_ai_settings_provider_check;
ALTER TABLE public.event_ai_settings
  ADD CONSTRAINT event_ai_settings_provider_check CHECK (provider IN ('anthropic', 'openai-compatible'));

-- A base URL belongs to the compatible adapter only, and only over https: Anthropic's endpoint is
-- ours to know, and an http base URL would send the organizer's key in clear.
ALTER TABLE public.event_ai_settings DROP CONSTRAINT IF EXISTS event_ai_settings_base_url_check;
ALTER TABLE public.event_ai_settings
  ADD CONSTRAINT event_ai_settings_base_url_check CHECK (
    (provider = 'anthropic' AND base_url IS NULL)
    OR (provider = 'openai-compatible' AND base_url IS NOT NULL AND length(base_url) <= 300
        AND (base_url LIKE 'https://%' OR base_url LIKE 'http://127.0.0.1:%' OR base_url LIKE 'http://localhost:%'))
  );

ALTER TABLE public.event_ai_settings DROP CONSTRAINT IF EXISTS event_ai_settings_last4_check;
ALTER TABLE public.event_ai_settings
  ADD CONSTRAINT event_ai_settings_last4_check CHECK (length(key_last4) BETWEEN 1 AND 4);

ALTER TABLE public.event_ai_settings DROP CONSTRAINT IF EXISTS event_ai_settings_model_check;
ALTER TABLE public.event_ai_settings
  ADD CONSTRAINT event_ai_settings_model_check CHECK (model IS NULL OR (btrim(model) <> '' AND length(model) <= 100));

COMMENT ON TABLE public.event_ai_settings IS
  'Per-gathering answer-model credential (design 2026-09-25 §2.1). Server-only: never readable by anon or authenticated. The key is sealed with AES-256-GCM under APP_SECRETS_KEY, associated data = event_id; only key_last4 is ever shown back.';
COMMENT ON COLUMN public.event_ai_settings.provider IS 'anthropic (Messages API) or openai-compatible (POST <base_url>/v1/chat/completions).';
COMMENT ON COLUMN public.event_ai_settings.base_url IS 'openai-compatible only: https origin (plus optional path prefix) of the provider. http is accepted only for a loopback test server outside production (AI_TEST_BASE_ORIGIN).';
COMMENT ON COLUMN public.event_ai_settings.key_ciphertext IS 'AES-256-GCM: version byte || 12-byte nonce || ciphertext || 16-byte tag. Opens only under APP_SECRETS_KEY with this event_id as associated data.';
COMMENT ON COLUMN public.event_ai_settings.key_last4 IS 'Last four characters of the key, so an organizer can tell which key is installed. Nothing else about the key is stored in the clear.';
COMMENT ON COLUMN public.event_ai_settings.model IS 'Anthropic: one of the models the app offers. Compatible: free text, as the provider names it.';
COMMENT ON COLUMN public.event_ai_settings.set_by IS 'The owner or admin who installed this key. Kept for the audit trail; nulled if the account is deleted.';

REVOKE ALL ON public.event_ai_settings FROM anon, authenticated;
