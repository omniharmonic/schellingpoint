-- =============================================================================
-- 0033_moderation.sql — reports and the organizer moderation queue (spec §9)
-- =============================================================================
--
-- MT §12.5 asks for a report/flag flow; spec §9 names the table `sp_moderation_queue` and
-- says: "cases, reasons, every port call … reasons and subjects are never public; only the
-- enum-only projection is … case files organiser-only behind a two-person rule".
--
-- What that means here:
--   * `moderation_reports` is server-only (0009's default privileges already revoke; the
--     REVOKE below is defence in depth). No RLS policy exists because no signed-in role can
--     reach the table at all — every read and write goes through the AppView's service
--     connection after `requireEventRole`.
--   * A report names its subject by *account id*, never by DID or handle. The projection the
--     organizer queue returns carries the subject's display name only, and the reporter is
--     never shown to the subject.
--   * `details` is the reporter's free text. It is never published, never emailed to the
--     subject, and never leaves the organizer queue.
--   * Every report is scoped by `event_id`: a gathering's moderation is its own business, and
--     another gathering's organizers are the public (spec §8).
--
-- Moderation acts app-side only. Hiding a session sets `sessions.hidden_by_moderation`; the
-- author's record in their own repo is never touched, edited or deleted — organizers curate,
-- they do not write into someone else's repo (spec §4.2). When the hidden session already has a
-- PUBLISHED calendar event, hiding it here does not withdraw that record: the app requests the
-- existing destructive-cancel approval instead, and records on the report what happened.
--
-- NOT IMPLEMENTED YET, recorded here so nobody reads this table as more than it is. Spec §9 puts
-- case files "organiser-only behind a two-person rule". What exists today is the organiser-only
-- half: reading and resolving a case needs owner/admin/moderator, and removing an *organizer*
-- needs an owner (the roster's own rule, enforced in `resolveReport`). There is no second-
-- organizer confirmation on a resolution: one moderator can hide a session or remove a member
-- alone. Adding it means a pending-decision flow of the shape `approval_requests` already has
-- for publishing — but those approvals are public records in each approver's repo, which is
-- exactly what a case file must not be, so it needs a private analogue rather than a reuse.
-- Until then the mitigation is the audit trail: `action`, `note`, `resolved_by` and
-- `resolved_at` say who decided what, and the decision is reversible (`unhideSession`).
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.moderation_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  -- NULL once the reporter is forgotten (retention) or their account is deleted: the case file
  -- survives the person, as an unlinkable record of what was decided.
  reporter_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  subject_kind text NOT NULL,
  subject_session_id uuid REFERENCES public.sessions(id) ON DELETE CASCADE,
  subject_account_id uuid REFERENCES public.accounts(id) ON DELETE CASCADE,
  -- For a comment/feedback item: the app-side id of the thing reported (a resource row, a
  -- feedback entry). Opaque text so no foreign key forces a shape on future item kinds.
  subject_ref text,
  reason text NOT NULL,
  details text,
  status text NOT NULL DEFAULT 'open',
  -- What the organizer did, in the organizer's words. Shown to the reporter in the outcome
  -- notification only as the resolution enum; the note stays in the queue.
  note text,
  action text,
  resolved_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_subject_kind_check;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_subject_kind_check CHECK (subject_kind IN ('session', 'profile', 'comment'));

ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_reason_check;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_reason_check CHECK (reason IN (
    'harassment', 'hate', 'spam', 'sexual_content', 'violence', 'impersonation',
    'code_of_conduct', 'off_topic', 'other'
  ));

ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_status_check;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_status_check CHECK (status IN ('open', 'dismissed', 'actioned'));

ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_action_check;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_action_check CHECK (action IS NULL OR action IN ('dismiss', 'hide_session', 'remove_member', 'note'));

-- A report always points at exactly the subject its kind names.
ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_subject_check;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_subject_check CHECK (
    (subject_kind = 'session'  AND subject_session_id IS NOT NULL) OR
    (subject_kind = 'profile'  AND subject_account_id IS NOT NULL) OR
    (subject_kind = 'comment'  AND subject_ref IS NOT NULL)
  );

ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_details_check;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_details_check CHECK (details IS NULL OR length(details) <= 2000);

ALTER TABLE public.moderation_reports DROP CONSTRAINT IF EXISTS moderation_reports_note_check;
ALTER TABLE public.moderation_reports
  ADD CONSTRAINT moderation_reports_note_check CHECK (note IS NULL OR length(note) <= 2000);

-- The same person cannot file the same report twice: a second click is the same case.
CREATE UNIQUE INDEX IF NOT EXISTS moderation_reports_once_idx
  ON public.moderation_reports (event_id, reporter_account_id, subject_kind,
                                coalesce(subject_session_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                coalesce(subject_account_id, '00000000-0000-0000-0000-000000000000'::uuid),
                                coalesce(subject_ref, ''))
  WHERE reporter_account_id IS NOT NULL AND status = 'open';

-- The queue: open cases first, newest first, per gathering.
CREATE INDEX IF NOT EXISTS moderation_reports_queue_idx
  ON public.moderation_reports (event_id, status, created_at DESC);

-- The rate limit: "how many reports has this account filed in the last hour / day?"
CREATE INDEX IF NOT EXISTS moderation_reports_reporter_idx
  ON public.moderation_reports (reporter_account_id, created_at DESC)
  WHERE reporter_account_id IS NOT NULL;

COMMENT ON TABLE public.moderation_reports IS
  'Reports filed by members about a session, a person or a comment (spec §9 sp_moderation_queue). Server-only: never readable by anon or authenticated. Reasons and reporter identities never leave the organizer queue.';
COMMENT ON COLUMN public.moderation_reports.reporter_account_id IS
  'Who filed it. NULL once forgotten. Never shown to the subject of the report.';
COMMENT ON COLUMN public.moderation_reports.subject_account_id IS
  'The reported person as an account id — never a DID and never a handle, so a case file cannot be joined to the network by anyone who gets a copy of this table.';
COMMENT ON COLUMN public.moderation_reports.details IS 'The reporter''s own words. Organizer-only, never published, never emailed to the subject.';
COMMENT ON COLUMN public.moderation_reports.action IS 'What the organizer did when resolving: dismiss, hide_session, remove_member or note.';

REVOKE ALL ON public.moderation_reports FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Session-level moderation and "the author left"
-- ---------------------------------------------------------------------------
--
-- `hidden_by_moderation` removes a session from the lists this app serves. It changes nothing
-- in the author's repo: the proposal record is theirs and stays exactly where it is, which is
-- also why hiding is reversible and leaves an audit trail in `moderation_reports`.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS hidden_by_moderation boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hidden_at timestamptz,
  ADD COLUMN IF NOT EXISTS hidden_by uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  -- Spec §8 "Leaving and ending": a proposal stays on the calendar when its proposer leaves,
  -- because it is the proposer's own record. Organizers need to see that the author is gone.
  ADD COLUMN IF NOT EXISTS author_left_at timestamptz;

COMMENT ON COLUMN public.sessions.hidden_by_moderation IS
  'App-side moderation: the session is not listed. The author''s proposal record is untouched — organizers curate app-side and never write into someone else''s repo.';
COMMENT ON COLUMN public.sessions.author_left_at IS
  'When the proposer left this gathering. The session stays (their record, their calendar entry); organizers see that nobody is answering for it.';

CREATE INDEX IF NOT EXISTS sessions_hidden_idx ON public.sessions (event_id) WHERE hidden_by_moderation;
CREATE INDEX IF NOT EXISTS sessions_author_left_idx ON public.sessions (event_id) WHERE author_left_at IS NOT NULL;
