-- Server-only tables are unreachable from signed-in and anonymous roles by privilege, not merely
-- by the absence of an RLS policy (defence in depth: a future policy added by mistake, or RLS
-- disabled during maintenance, must not expose credentials, OAuth sessions, audit rows or ballots).
--
-- These tables are read and written only by the AppView's service connection (APP_DB_USER, which
-- bypasses RLS). None of them is touched inside an `asAccount` transaction.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'app_migrations',
    'approval_request_approvals', 'approval_requests',
    'at_audit', 'at_credentials', 'at_oauth_client_key', 'at_oauth_session', 'at_oauth_state',
    'at_occurrences', 'at_repo_state', 'at_series', 'at_sessions', 'at_slot_grids', 'at_sync_cursor',
    'listings', 'peers', 'role_claims', 'time_preferences',
    'auth_email_tokens', 'ens_challenges',
    'credit_ledger', 'vote_ballots', 'vote_entries', 'vote_round_results', 'vote_rounds',
    'feedback_ballots', 'feedback_entries', 'feedback_windows'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END IF;
  END LOOP;
END $$;

-- Private by default from here on: a table created by a later migration is visible to signed-in
-- accounts only when that migration grants it explicitly alongside its RLS policies.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
