-- =============================================================================
-- 0002_ballot_voting.sql — ballot-key voting and feedback ballots
-- =============================================================================
--
-- docs/ATPROTO_MIGRATION_SPEC.md §5 (quadratic voting under R9) and
-- docs/ATPROTO_APPVIEW_PLAN.md §7.2 "Voting (C owns)".
--
-- The author-linked vote store of the previous pass (`votes`, live counters on
-- `sessions`, a feedback table keyed by user) is replaced by ballot tables whose
-- link to a person exists only while a round/window is open:
--
--   vote_rounds         one per (event, phase) round; `ballot_key` = 32 random
--                       bytes generated IN the database, destroyed at close.
--   credit_ledger       the only author-linked vote data; exists while the round
--                       is open, deleted at close.
--   vote_ballots        (round, hmac(ballot_key, account_id)) — "this person took
--                       part, once". No account column.
--   vote_entries        the content: session, votes, credits, DAY, ballot_token.
--                       No account column, no timestamp.
--   vote_round_results  per-session sums computed once at close.
--
--   feedback_windows    per session; `ballot_key` destroyed at close.
--   feedback_ballots    (session, hmac(ballot_key, account_id)).
--   feedback_entries    the content: rating, would_attend_again, comment, DAY.
--                       While open an entry's id is derived from the ballot key
--                       (so its author can edit it); at close every entry is
--                       re-inserted with a fresh random id in random order.
--
-- All of these are server-only: RLS is enabled with NO policies, and the
-- signed-in roles hold no privileges on them. The app connects as a BYPASSRLS
-- role (scripts/db-migrate.mjs); nothing reaches them through asAccount().
--
-- Nothing is migrated: this is a fresh instance.
-- Drops use IF EXISTS so the file applies whether or not 0003 (notifications)
-- has already removed the milestone trigger.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Remove the author-linked vote store and its live counters
-- -----------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trigger_vote_milestone ON public.sessions;
DROP FUNCTION IF EXISTS public.notify_vote_milestone();

-- Dropping the table drops enforce_event_vote_rules / on_vote_change triggers
-- and every policy on it.
DROP TABLE IF EXISTS public.votes;
DROP FUNCTION IF EXISTS public.enforce_event_vote_rules();
DROP FUNCTION IF EXISTS public.update_session_vote_counts();

-- enforce_session_update_rules() compares the vote counters; redefine it
-- without them before the columns go (plpgsql would fail at run time).
CREATE OR REPLACE FUNCTION public.enforce_session_update_rules() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  caller_role text;
BEGIN
  IF auth.uid() IS NULL OR pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  IF NEW.event_id IS DISTINCT FROM OLD.event_id THEN
    RAISE EXCEPTION 'Sessions cannot move between events' USING ERRCODE = '42501';
  END IF;

  SELECT role INTO caller_role FROM public.event_members
  WHERE event_id = OLD.event_id AND user_id = auth.uid();
  IF caller_role IN ('owner', 'admin', 'moderator') THEN
    RETURN NEW;
  END IF;

  IF NEW.host_id        IS DISTINCT FROM OLD.host_id
    OR NEW.status         IS DISTINCT FROM OLD.status
    OR NEW.venue_id       IS DISTINCT FROM OLD.venue_id
    OR NEW.time_slot_id   IS DISTINCT FROM OLD.time_slot_id
    OR NEW.is_votable     IS DISTINCT FROM OLD.is_votable
    OR NEW.rsvp_count     IS DISTINCT FROM OLD.rsvp_count
    OR NEW.waitlist_count IS DISTINCT FROM OLD.waitlist_count
    OR NEW.session_type   IS DISTINCT FROM OLD.session_type
  THEN
    RAISE EXCEPTION 'Only organizers can change scheduling or status fields' USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

-- idx_sessions_event_votes / idx_sessions_total_votes go with the column.
ALTER TABLE public.sessions
  DROP COLUMN IF EXISTS total_votes,
  DROP COLUMN IF EXISTS total_credits,
  DROP COLUMN IF EXISTS voter_count;

-- The per-account global credit balance. The budget is per event:
-- event_members.vote_credits (override) or the round's credits.
ALTER TABLE public.profiles DROP COLUMN IF EXISTS vote_credits;

-- Feedback linkable to its author.
DROP TABLE IF EXISTS public.session_feedback;
DROP FUNCTION IF EXISTS public.enforce_session_feedback_window();
DROP FUNCTION IF EXISTS public.session_feedback_summary(uuid);

-- Composite key so ballot content can reference (session, event) and can never
-- point at a session of another event.
ALTER TABLE public.sessions ADD CONSTRAINT sessions_id_event_id_key UNIQUE (id, event_id);

-- -----------------------------------------------------------------------------
-- 2. Vote rounds
-- -----------------------------------------------------------------------------

CREATE TABLE public.vote_rounds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    event_id uuid NOT NULL,
    phase text DEFAULT 'pre-event'::text NOT NULL,
    mechanism text NOT NULL,
    credits integer NOT NULL,
    opens_at timestamp with time zone NOT NULL,
    closes_at timestamp with time zone NOT NULL,
    -- Generated here and never selected by application code: tokens are
    -- computed in SQL at close, in the same statement that reads it.
    ballot_key bytea DEFAULT extensions.gen_random_bytes(32),
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT vote_rounds_pkey PRIMARY KEY (id),
    CONSTRAINT vote_rounds_id_event_id_key UNIQUE (id, event_id),
    CONSTRAINT vote_rounds_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.events(id) ON DELETE CASCADE,
    CONSTRAINT vote_rounds_phase_check CHECK (phase = ANY (ARRAY['pre-event'::text, 'attendance'::text])),
    CONSTRAINT vote_rounds_mechanism_check CHECK (mechanism = ANY (ARRAY['quadratic'::text, 'linear'::text, 'approval'::text])),
    CONSTRAINT vote_rounds_credits_check CHECK (credits > 0),
    CONSTRAINT vote_rounds_window_check CHECK (closes_at > opens_at),
    -- The key exists exactly while the round is not finalized; NULL is terminal.
    CONSTRAINT vote_rounds_key_lifecycle_check CHECK ((finalized_at IS NULL) = (ballot_key IS NOT NULL)),
    CONSTRAINT vote_rounds_key_length_check CHECK (ballot_key IS NULL OR octet_length(ballot_key) = 32)
);

COMMENT ON TABLE public.vote_rounds IS 'One voting round per (event, phase). ballot_key is the only thing that ever links an account to a ballot; it is set NULL at close, irreversibly (spec §5.3).';

-- One open (not finalized) round per event per phase.
CREATE UNIQUE INDEX vote_rounds_one_open_per_phase ON public.vote_rounds USING btree (event_id, phase) WHERE (finalized_at IS NULL);
CREATE INDEX idx_vote_rounds_event_opens ON public.vote_rounds USING btree (event_id, opens_at DESC);

-- A key can be destroyed but never restored or replaced.
CREATE FUNCTION public.guard_vote_round_key() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.ballot_key IS NULL AND NEW.ballot_key IS NOT NULL THEN
    RAISE EXCEPTION 'A closed round cannot be reopened' USING ERRCODE = '23514';
  END IF;
  IF OLD.ballot_key IS NOT NULL AND NEW.ballot_key IS NOT NULL AND NEW.ballot_key <> OLD.ballot_key THEN
    RAISE EXCEPTION 'A round''s ballot key cannot be replaced' USING ERRCODE = '23514';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
    RAISE EXCEPTION 'A finalized round cannot change' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_vote_round_key BEFORE UPDATE ON public.vote_rounds FOR EACH ROW EXECUTE FUNCTION public.guard_vote_round_key();

-- -----------------------------------------------------------------------------
-- 3. Credit ledger — author-linked, open rounds only
-- -----------------------------------------------------------------------------

CREATE TABLE public.credit_ledger (
    round_id uuid NOT NULL,
    event_id uuid NOT NULL,
    account_id uuid NOT NULL,
    allocated jsonb DEFAULT '{}'::jsonb NOT NULL,   -- { "<session_id>": votes }
    spent integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_ledger_pkey PRIMARY KEY (round_id, account_id),
    CONSTRAINT credit_ledger_round_fkey FOREIGN KEY (round_id, event_id) REFERENCES public.vote_rounds(id, event_id) ON DELETE CASCADE,
    CONSTRAINT credit_ledger_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE,
    CONSTRAINT credit_ledger_allocated_check CHECK (jsonb_typeof(allocated) = 'object'),
    CONSTRAINT credit_ledger_spent_check CHECK (spent >= 0)
);

COMMENT ON TABLE public.credit_ledger IS 'A participant''s mutable allocation while a round is open. Deleted in the close transaction (spec §5.3 step 4).';

CREATE INDEX idx_credit_ledger_event ON public.credit_ledger USING btree (event_id);

-- Defense in depth: no allocation may be written into a finalized round.
CREATE FUNCTION public.enforce_credit_ledger_round_open() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.vote_rounds r WHERE r.id = NEW.round_id AND r.finalized_at IS NULL) THEN
    RAISE EXCEPTION 'This voting round is closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_credit_ledger_round_open BEFORE INSERT OR UPDATE ON public.credit_ledger FOR EACH ROW EXECUTE FUNCTION public.enforce_credit_ledger_round_open();

-- -----------------------------------------------------------------------------
-- 4. Ballots, entries, results — written only at close
-- -----------------------------------------------------------------------------

CREATE TABLE public.vote_ballots (
    round_id uuid NOT NULL,
    event_id uuid NOT NULL,
    token bytea NOT NULL,                             -- hmac-sha256(ballot_key, account_id)
    cast_at timestamp with time zone NOT NULL,        -- the round's close time for every ballot
    CONSTRAINT vote_ballots_pkey PRIMARY KEY (round_id, token),
    CONSTRAINT vote_ballots_round_fkey FOREIGN KEY (round_id, event_id) REFERENCES public.vote_rounds(id, event_id) ON DELETE CASCADE,
    CONSTRAINT vote_ballots_token_check CHECK (octet_length(token) = 32)
);

COMMENT ON TABLE public.vote_ballots IS 'Proves "this participant took part in this round, once" and nothing else. No account column.';

CREATE INDEX idx_vote_ballots_event ON public.vote_ballots USING btree (event_id);

CREATE TABLE public.vote_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    round_id uuid NOT NULL,
    event_id uuid NOT NULL,
    session_id uuid NOT NULL,
    votes integer NOT NULL,
    credits integer NOT NULL,
    day date NOT NULL,
    ballot_token bytea NOT NULL,
    CONSTRAINT vote_entries_pkey PRIMARY KEY (id),
    CONSTRAINT vote_entries_round_fkey FOREIGN KEY (round_id, event_id) REFERENCES public.vote_rounds(id, event_id) ON DELETE CASCADE,
    CONSTRAINT vote_entries_session_fkey FOREIGN KEY (session_id, event_id) REFERENCES public.sessions(id, event_id) ON DELETE CASCADE,
    CONSTRAINT vote_entries_ballot_fkey FOREIGN KEY (round_id, ballot_token) REFERENCES public.vote_ballots(round_id, token) ON DELETE CASCADE,
    CONSTRAINT vote_entries_votes_check CHECK (votes > 0),
    CONSTRAINT vote_entries_credits_check CHECK (credits > 0),
    CONSTRAINT vote_entries_one_per_ballot_session UNIQUE (round_id, session_id, ballot_token)
);

COMMENT ON TABLE public.vote_entries IS 'Vote content. NO account column, a DAY not a timestamp; ballot_token links one participant''s entries to each other (auto-scheduler overlap, spec §5.4) and to no person.';

CREATE INDEX idx_vote_entries_event ON public.vote_entries USING btree (event_id);
CREATE INDEX idx_vote_entries_round_session ON public.vote_entries USING btree (round_id, session_id);

CREATE TABLE public.vote_round_results (
    round_id uuid NOT NULL,
    event_id uuid NOT NULL,
    session_id uuid NOT NULL,
    voters integer NOT NULL,
    votes integer NOT NULL,
    credits integer NOT NULL,
    CONSTRAINT vote_round_results_pkey PRIMARY KEY (round_id, session_id),
    CONSTRAINT vote_round_results_round_fkey FOREIGN KEY (round_id, event_id) REFERENCES public.vote_rounds(id, event_id) ON DELETE CASCADE,
    CONSTRAINT vote_round_results_session_fkey FOREIGN KEY (session_id, event_id) REFERENCES public.sessions(id, event_id) ON DELETE CASCADE,
    CONSTRAINT vote_round_results_counts_check CHECK (voters >= 0 AND votes >= 0 AND credits >= 0)
);

COMMENT ON TABLE public.vote_round_results IS 'Per-session sums computed once in the close transaction. Organizer-only raw; public only through the k-suppressed tally.';

CREATE INDEX idx_vote_round_results_event ON public.vote_round_results USING btree (event_id);

-- -----------------------------------------------------------------------------
-- 5. Feedback ballots (modelled on Free School apps/appview/src/lib/feedback.ts)
-- -----------------------------------------------------------------------------

CREATE TABLE public.feedback_windows (
    session_id uuid NOT NULL,
    event_id uuid NOT NULL,
    opens_at timestamp with time zone NOT NULL,
    closes_at timestamp with time zone NOT NULL,
    ballot_key bytea DEFAULT extensions.gen_random_bytes(32),
    finalized_at timestamp with time zone,
    -- The numeric aggregate computed once at close (k-suppressed there).
    summary jsonb,
    CONSTRAINT feedback_windows_pkey PRIMARY KEY (session_id),
    CONSTRAINT feedback_windows_session_fkey FOREIGN KEY (session_id, event_id) REFERENCES public.sessions(id, event_id) ON DELETE CASCADE,
    CONSTRAINT feedback_windows_window_check CHECK (closes_at > opens_at),
    CONSTRAINT feedback_windows_key_lifecycle_check CHECK ((finalized_at IS NULL) = (ballot_key IS NOT NULL)),
    CONSTRAINT feedback_windows_key_length_check CHECK (ballot_key IS NULL OR octet_length(ballot_key) = 32)
);

COMMENT ON TABLE public.feedback_windows IS 'Per-session feedback window. ballot_key is destroyed at close, after which no feedback row can be tied to its author.';

CREATE INDEX idx_feedback_windows_event ON public.feedback_windows USING btree (event_id);

CREATE TRIGGER guard_feedback_window_key BEFORE UPDATE ON public.feedback_windows FOR EACH ROW EXECUTE FUNCTION public.guard_vote_round_key();

CREATE TABLE public.feedback_ballots (
    session_id uuid NOT NULL,
    event_id uuid NOT NULL,
    token bytea NOT NULL,                             -- hmac-sha256(ballot_key, account_id)
    CONSTRAINT feedback_ballots_pkey PRIMARY KEY (session_id, token),
    CONSTRAINT feedback_ballots_window_fkey FOREIGN KEY (session_id) REFERENCES public.feedback_windows(session_id) ON DELETE CASCADE,
    CONSTRAINT feedback_ballots_session_fkey FOREIGN KEY (session_id, event_id) REFERENCES public.sessions(id, event_id) ON DELETE CASCADE,
    CONSTRAINT feedback_ballots_token_check CHECK (octet_length(token) = 32)
);

CREATE INDEX idx_feedback_ballots_event ON public.feedback_ballots USING btree (event_id, session_id);

CREATE TABLE public.feedback_entries (
    id uuid NOT NULL,
    session_id uuid NOT NULL,
    event_id uuid NOT NULL,
    rating smallint NOT NULL,
    would_attend_again boolean,
    comment text,
    day date NOT NULL,
    CONSTRAINT feedback_entries_pkey PRIMARY KEY (id),
    CONSTRAINT feedback_entries_window_fkey FOREIGN KEY (session_id) REFERENCES public.feedback_windows(session_id) ON DELETE CASCADE,
    CONSTRAINT feedback_entries_session_fkey FOREIGN KEY (session_id, event_id) REFERENCES public.sessions(id, event_id) ON DELETE CASCADE,
    CONSTRAINT feedback_entries_rating_check CHECK (rating >= 1 AND rating <= 5),
    CONSTRAINT feedback_entries_comment_check CHECK (comment IS NULL OR char_length(comment) <= 2000)
);

COMMENT ON TABLE public.feedback_entries IS 'Feedback content. NO author column, NO ballot column, a DAY not a timestamp.';

CREATE INDEX idx_feedback_entries_event ON public.feedback_entries USING btree (event_id, session_id);

-- -----------------------------------------------------------------------------
-- 6. Server-only: RLS on, no policies, no privileges for signed-in roles
-- -----------------------------------------------------------------------------

ALTER TABLE public.vote_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vote_ballots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vote_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vote_round_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_ballots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_entries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.vote_rounds, public.credit_ledger, public.vote_ballots, public.vote_entries,
  public.vote_round_results, public.feedback_windows, public.feedback_ballots, public.feedback_entries
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.guard_vote_round_key() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_credit_ledger_round_open() FROM PUBLIC, anon, authenticated;
