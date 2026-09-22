-- =============================================================================
-- 0028_assistant_tokens.sql — personal tokens for the remote MCP server
-- =============================================================================
--
-- A member can connect their own AI assistant (Claude Desktop / claude.ai, ChatGPT, Cursor) to
-- `https://<app>/api/mcp`. The assistant authenticates with a bearer token the member mints in
-- Account → Identity. The token is the member acting through a machine: it can read exactly what
-- they can read, and nothing else — every MCP tool resolves the token to this account and then
-- goes through the same membership, session-visibility and transcript-tier checks the browser does.
--
-- Only the sha256 of a token is stored. The token itself (`unc_<32 bytes base64url>`) is shown
-- once, at mint time, and exists nowhere on the server afterwards — exactly like a magic-link
-- token (`auth_email_tokens`, 0004) and for the same reason.
--
-- Server-only (0009's default privileges already revoke; the REVOKE below is defence in depth and
-- documents the intent). The AppView reads and writes this table on its service connection only;
-- it is never touched inside an `asAccount` transaction and has no RLS policy because no
-- signed-in role can reach it at all.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.assistant_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT '{read}',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

ALTER TABLE public.assistant_tokens DROP CONSTRAINT IF EXISTS assistant_tokens_name_check;
ALTER TABLE public.assistant_tokens
  ADD CONSTRAINT assistant_tokens_name_check CHECK (btrim(name) <> '' AND length(name) <= 60);

-- Read path: hash → live token (the unique index on token_hash serves it).
-- Write path: "how many live tokens does this account hold?" (the ≤ 5 cap) and the account's list.
CREATE INDEX IF NOT EXISTS assistant_tokens_account_live_idx
  ON public.assistant_tokens (account_id, created_at DESC) WHERE revoked_at IS NULL;

COMMENT ON TABLE public.assistant_tokens IS
  'Personal bearer tokens for the remote MCP server (/api/mcp). Server-only: never readable by anon or authenticated. Only the sha256 of a token is stored; the token is shown once at mint time.';
COMMENT ON COLUMN public.assistant_tokens.name IS 'The member''s own label for the assistant ("Claude Desktop on my laptop"). Never leaves their account.';
COMMENT ON COLUMN public.assistant_tokens.token_hash IS 'sha256 hex of `unc_<32 bytes base64url>`. The token itself exists only in the member''s assistant configuration.';
COMMENT ON COLUMN public.assistant_tokens.scopes IS 'Reserved for future narrowing. Every token minted today is read-only ({read}); the MCP server writes nothing anywhere.';
COMMENT ON COLUMN public.assistant_tokens.last_used_at IS 'Last request that presented this token, written at most once a minute (so an assistant polling hard does not write on every call).';
COMMENT ON COLUMN public.assistant_tokens.expires_at IS 'Optional expiry. NULL means the token lives until revoked.';
COMMENT ON COLUMN public.assistant_tokens.revoked_at IS 'Set by the member from Account → Identity. A revoked token is refused immediately (401) and kept as a record of what existed.';

REVOKE ALL ON public.assistant_tokens FROM anon, authenticated;
