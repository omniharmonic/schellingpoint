-- =============================================================================
-- 0035_account_deletion_foreign_keys.sql — what must survive a deleted account
-- =============================================================================
--
-- Deleting an account (spec §9, MT §12.6) walks every foreign key into `accounts` and
-- `profiles`. Three of them were wrong for that walk, in two different ways.
--
-- 1. `events.created_by` and `tracks.lead_user_id` are ON DELETE NO ACTION into `profiles`.
--    That does not protect anything: it simply makes the delete fail with a foreign-key error
--    for anyone who has ever created a gathering or led a track — which is precisely the set of
--    people the ownership check lets through, because handing a gathering over or archiving it
--    clears the ownership block but not the authorship row. A gathering must not be deleted
--    because its founder left, and it must not pin them here either: the honest outcome is that
--    it forgets who created it.
--
-- 2. `at_credentials.created_by` had no foreign key at all, so an account row could vanish and
--    leave a dangling id behind. It is the organizer who *connected* a credential, not the
--    credential's subject — the subject is the `did` primary key — so forgetting the organizer
--    must never take the gathering's publishing credential with it.
--
-- Nothing here changes who may read what. It changes what happens to rows that outlive a person.
-- =============================================================================

-- A gathering outlives its founder, with no author.
ALTER TABLE public.events DROP CONSTRAINT IF EXISTS events_created_by_fkey;
ALTER TABLE public.events
  ADD CONSTRAINT events_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.events.created_by IS
  'Who created the gathering. NULL once that person deletes their account: the gathering is not theirs to take with them, and it does not keep them here either.';

-- A track outlives its lead, with no lead.
ALTER TABLE public.tracks DROP CONSTRAINT IF EXISTS tracks_lead_user_id_fkey;
ALTER TABLE public.tracks
  ADD CONSTRAINT tracks_lead_user_id_fkey FOREIGN KEY (lead_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tracks.lead_user_id IS
  'The track lead, when one is appointed. NULL once that account is deleted; the organizers appoint another.';

-- Forgetting the organizer who connected a credential never removes the credential. The subject
-- of a credential is its `did` primary key; `created_by` is only provenance.
ALTER TABLE public.at_credentials DROP CONSTRAINT IF EXISTS at_credentials_created_by_fkey;
ALTER TABLE public.at_credentials
  ADD CONSTRAINT at_credentials_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.at_credentials.created_by IS
  'The organizer who connected this credential — provenance only. NULL once that account is deleted; the credential belongs to the DID in the primary key and stays.';
