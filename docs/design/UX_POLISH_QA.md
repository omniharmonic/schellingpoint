# Frontend polish verification — September 14, 2026

## Implemented

- Shared mineral, spruce, mint, and lilac palette; local BDO Grotesk typography; readable labels, focus states, larger controls, responsive spacing, and reduced motion.
- Public homepage with an interactive explanation of proposing, voting, and gathering; event directory and archived gathering discovery; original geometric brand mark.
- Event landing, attendee shell, organizer shell, grouped admin navigation, proposal-review priorities, schedule progress, mobile scheduling tray, and responsive page headings.
- Creation wizard with persistent next action, visible validation, accessible draft recovery, and a light Commons theme. Onboarding uses the event’s actual credit allocation and voting mechanism.
- Ticket/check-in pages retain event context. Global loading, error, and not-found screens offer recovery.
- Safe local auth return paths (both `redirect` and `returnTo` supported); GoTrue redirect query fixed; shared in-flight magic-link verification avoids React StrictMode’s duplicate effect race.
- Event role state responds to sign-in/out; vote display cache is event/user scoped and refreshes after successful writes.
- Voting, bookmarking, and individual organizer status changes check HTTP failure before reporting success. Failed attendee writes roll back and display an explanation.
- Completed/archived events no longer invite voting/proposing in their primary UI. This is UI guidance, not a replacement for server/RLS lifecycle enforcement.
- Event calendar dates and date filters use UTC calendar semantics, while session timestamps display in the event timezone.

## Verification performed

- `npx tsc --noEmit`: passed.
- `npx playwright test tests/ux-logic.spec.ts`: six checks passed. These execute pure logic, without browser automation: safe auth destinations, quadratic costs, short-hex conversion/theme contrast, calendar-date formatting, and day boundaries across DST.
- `npm run build`: passed, including route generation and type validation.
- `git diff --check`: passed.
- Browser review at desktop and 390px phone widths: homepage, interactive gathering diagram, event landing, login, creation wizard through review, draft recovery, profile onboarding, session discovery/search reset, saving a session, personal schedule, people directory, dashboard, notifications, and ticket-unavailable state.
- Fresh local sign-out → email magic link → original event dashboard verified after the auth fix. The saved session remained in the personal schedule.

## Verification limits

- Test environment: local Supabase and Mailpit only. No production writes, live email sends, payments, or deployments.
- Automatic approval review rejected assigning owner membership to the seeded event for the test user. That role change was not performed. A separate disposable event (`ux-review-gathering`) was prepared through the normal creation wizard; its terms acceptance and submission await user approval. Full organizer create/review/schedule workflow browser testing therefore remains outstanding.
- Legacy E2E suites were not run: they contain stale UI assertions and privileged seeded-user setup. The six focused checks do not replace full role/tenant/payment integration coverage.
- Build reports pre-existing missing `STRIPE_SECRET_KEY` (payments disabled in this environment) and stale Browserslist data. Dependency upgrades were outside this visual pass.
- Existing notification delivery, paid checkout/refunds, invitation acceptance, destructive actions, and asset uploads were not exercised.

## Local review

Preview: `http://127.0.0.1:3001`. `npm run dev` uses `.env.local` and local Supabase. The production build loads `.env.production.local`; do not use those credentials for local test mutations.


## Bolder landing and workspace pass

- Landing page now has an explorable idea field and three scroll chapters. The desktop illustration stays alongside the narrative; mobile and short screens show examples inline. Chapter links support direct navigation, and normal wheel/touch/keyboard scrolling resumes after an interaction. No scroll hijacking or background animation.
- Local example state carries a submitted idea into a nine-credit quadratic-voting exercise and illustrative schedule. Clearly labeled as an example; no API writes or real votes. Budget limit, reset, idea submission, and carry-through checked in the browser.
- Event posters emphasize event identity and calendar date. Dashboards use larger headings and stronger summary panels. Calendar day controls are larger and expose their selected state; session surfaces use track colors with readable text. Organizer schedule controls retain their existing behavior.
- Browser checked: desktop hero/chapter changes, keyboard-label targeting, example submission, three votes consuming nine credits (further voting disabled), program rendering, 390px hero and inline proposal, live schedule day/venue switching, mobile calendar, and real attendee dashboard. Admin visual changes remain subject to the prior role/terms verification limitation.

## Reliability pass — September 14, 2026

Reproduced the open `/create` crash (`ChunkLoadError`, review/basic step requests to `/_next/undefined`) and the error boundary's unsuccessful retry. The wizard now imports its steps normally, chunk errors offer a full reload, and development output uses `.next-dev` so production builds cannot replace the running development chunks. Browser-tested a draft resume, step navigation during a production build, and attendee topic persistence through reload.

Creation now validates malformed payloads, real calendar dates/timezones, integer credit budgets, room references, slot overlaps/date boundaries, supported formats, and deadlines. Review uses the same validation. Draft topics are persisted and reviewed; immediate draft saving eliminates the pending debounce that could restore cleared drafts or lose edits.

`create_event_with_program` creates the event, rooms, tracks, slots, and owner membership in one transaction. Child failures no longer produce false success. Room IDs are assigned before the transaction instead of matching returned row order. A server-only RPC permission check and local failure-path tests verify rollback without creating persistent memberships.

Added organizer Event settings and a draft-to-publish entry point. The API checks the authenticated user's event role and uses existing lifecycle transitions, with an optimistic status condition to reject stale phase edits. Attendee controls now follow phase and deadlines. Database triggers enforce voting phase/deadlines, per-event budgets, quadratic/linear/approval costs, immutable vote identity, valid session/event relationships, proposal windows, approval, allowed formats/durations, and proposal caps. Voting upserts exclude the current session's prior allocation when checking the budget. Local SQL transaction tests verify costs, reductions, overspending rejection, approval votes, closed withdrawals, required approval, and proposal limits; all fixture writes are rolled back.

Organizer space/time saves now use event timezone timestamps, reject overlaps, retain forms on errors, and verify returned rows. Bulk slot generation uses one transactional insert. Fixed the completed-event My Votes infinite spinner: phase gating now applies to mutation rather than reading history. Saved-session removal waits for a confirmed response and exposes failures instead of silently dropping the card. Saved-session buttons have accessible names.

Validation:
- `npx tsc --noEmit`: passed.
- `npm run build`: passed; log `/tmp/schelling-reliability-build.log`.
- `npx playwright test tests/event-api.spec.ts tests/creation-database.spec.ts tests/creation-reliability.spec.ts tests/ux-logic.spec.ts`: 20 passed. These are HTTP/API/database and logic tests, not browser automation.
- `psql ... -v ON_ERROR_STOP=1 -f tests/sql/participation.sql`: passed; transaction rolled back.
- Browser: create crash recovery, resume and step navigation, topic persistence, saved schedule rendering, completed-event vote history, unauthorized organizer settings access.
- No production deployment or production database mutation.

Release requirements and remaining verification:
- Apply migrations `20260914000001_atomic_event_creation.sql` and `20260914000002_enforce_participation.sql` before deploying the application changes. Both were applied only to local Supabase in this session.
- Full organizer creation/publishing/scheduling browser verification remains pending approval to accept the prepared local event's terms checkbox and submit it. The draft is still at `/create`; no test owner role was granted.
- Payments remain disabled in this environment because `STRIPE_SECRET_KEY` is not configured. Payment processing was not exercised.
- Existing private-event server rendering uses the admin client and relies on client-side access handling; a server-side privacy/isolation review remains necessary before a production readiness claim. This pass does not claim a full security audit or production sign-off.
