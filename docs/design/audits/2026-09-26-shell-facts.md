# Shell facts for the mobile redesign (read-only audit, 2026-09-26)

Gathered against `atproto` at 77734ca; `main` read via `git show`. Full detail was produced by
a read-only agent; this is the summary the design rests on.

## Dashboard, then vs now
- Kept from `main`: welcome, sessions/participants stats, credits, quick actions, your ballot,
  my proposals, recently proposed, my sessions, sessions you're supporting, organizer banner.
- Removed on purpose (spec §3/§5.3): total votes across sessions, top-sessions leaderboard,
  per-card vote totals.
- New on `atproto`: round status with absolute open/close time (not a countdown), join card,
  first-steps checklist, assistant card.
- Available but unused: `rounds/current` `closesAt` (countdown), `admin_announcement`
  notifications (announcements), `sessions?timed=1` (next session), `admin/overview` (placed
  counts).

## Shell
- Eight nav items + Propose + Organizer workspace; desktop sidebar 240/260px; mobile: fixed
  64px header (name, bell, hamburger) with an inline drawer (no backdrop, no focus trap).
- No bottom bar anywhere; `.pb-safe` is defined and unused; only the admin batch bar and the map
  bottom sheet use fixed bottom positioning. `viewportFit: cover` is set.
- Profile editing inside a gathering: avatar menu → Account (SettingsModal), `?settings=1`,
  `/e/[slug]/settings` card, `/account`. No direct tap from the mobile header.

## Session page
- No `PageHeader`; "Back to sessions" is a ghost button in content; "Gathering page" is the
  `WorkspaceHeader` row above (44px mobile). Icon actions (edit/save/share) top-right of the
  header card. "Join the chat group" is its own card after location. Quick actions card is in
  the sidebar (single column below 1024px).

## Schedule pages
- Two 500-line client pages with duplicated grouping, headings and day logic; both already use
  `SegmentedControl` for group-by. `SegmentedControl` supports `fullWidth`.

## Copy
- 25 paragraphs over 150 characters; 8 in `SettingsModal`, the rest in participants, host
  analytics, map editor and knowledge components. Prop-based copy is already short.

## Tokens
- BDO Grotesk (400/600/700/800), primary `163 48% 27%`, favourite amber, radius 0.75rem,
  `--workspace-header-h: 76px`, light theme hard-coded.
