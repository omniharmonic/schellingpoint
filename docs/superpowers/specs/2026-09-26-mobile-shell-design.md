# Mobile-first gathering shell — design (2026-09-26)

Owner feedback after using the Test Event on an iPhone: directions failed (fixed, 77734ca), the
dashboard feels thinner than the web2 one, profile editing is hard to reach inside a gathering,
"Join the chat group" sits in the content instead of the action stack, "Back to sessions" and
"Gathering page" waste two rows, the hamburger drawer feels off, and explainer copy is too long.
Ask: a floating bottom utility bar, schedule and my schedule as tabs, fewer overwhelming options,
simpler copy, on both mobile and desktop.

Facts: `docs/design/audits/2026-09-26-shell-facts.md` (dashboard then/now, nav, session page,
schedule pages, copy inventory, tokens). Privacy rules are unchanged: no vote counts outside a
closed, k-suppressed tally; no leaderboard.

## 1. Design plan

**Identity stays.** BDO Grotesk, deep green primary (`163 48% 27%`), amber favourite, radius
0.75rem, light theme. This is a structural redesign; the palette and type are already the
product's own and are not the problem. No new fonts, no new colours.

**The one bold element: the Now line.** At the top of Home, one full-width line in the display
weight that says where the gathering is right now and what the person can do about it:
"Voting closes in 3 h 12 min — 4 credits left" / "Happening now: Three sessions, two you saved" /
"Schedule is out. 6 sessions saved." It is the only piece of motion on the page (a ticking
countdown, `prefers-reduced-motion` freezes it to minute precision). Everything else on Home is
quiet cards.

**Layout concept, mobile (< 768px):**

```
┌────────────────────────────────┐
│ ◉ Test Event            🔔  ◯ │  header: name, bell, avatar (avatar → Account)
├────────────────────────────────┤
│ ← Sessions          Gathering →│  one-line context row (replaces two rows)
│                                │
│  page content                  │
│                                │
│ ╭──────────────────────────╮   │
│ │ Home  Sessions  Schedule │   │  floating bar, safe-area aware, 4 tabs + More
│ │  Map   ⋯More             │   │
│ ╰──────────────────────────╯   │
└────────────────────────────────┘
```

Left-aligned content; the bar is centred, inset 12px from the edges, pill radius, elevated on
`--surface-1`, never full-bleed. Active tab is the primary green with its label; inactive tabs
are `muted-foreground` with labels always shown (icons alone fail for "My votes"/"People").

**Layout concept, desktop (≥ 768px):** the sidebar stays, reordered into the same primary set
first (Home, Sessions, Schedule, Map) then a thin divider, then People, My votes, Ask; then the
Propose button; Organizer workspace last. The floating bar is mobile only.

**Principles.** Four destinations, everything else one tap deeper. One action per row. Copy
says what happens, in one sentence; detail moves to `/help`.

Self-review against defaults: a bottom tab bar is a convention, and the brief asks for it; the
choice made here is what is *not* in it (no centred action button, no badge counts except the
bell). The Now line replaces the stat-tile hero, which is the default treatment and the one the
current Home uses. Sentence case everywhere, no eyebrows, no middle-dot meta strings on mobile.

## 2. Shell (`DashboardLayout`)

1. **Mobile header**: initial chip + name (link to gathering page), `NotificationBell`, avatar
   button that opens the Account modal (`SettingsModal`, Profile tab) — profile editing inside
   the gathering in one tap. The hamburger is removed.
2. **Floating bar** `MobileTabBar`: Home, Sessions, Schedule, Map, More. `More` opens a sheet
   (`ui/dialog` bottom variant): People, My votes, Ask (when available), Propose a session (when
   open), Organizer workspace (organizers), Notification preferences, Account, Sign out. The
   sheet closes on route change and Escape; focus is trapped; backdrop click closes.
3. **Context row** `WorkspaceHeader` on mobile: one line, back link left ("← Sessions" on a
   session page, otherwise the page title), "Gathering page →" right. Height 44px. Desktop keeps
   the current bar.
4. **Safe areas**: bar bottom = `env(safe-area-inset-bottom) + 12px`; page content gets
   `padding-bottom: calc(env(safe-area-inset-bottom) + 88px)` on mobile so nothing hides under
   the bar; map page bottom sheet sits above the bar.
5. `CreditGauge` moves into the Now line on Home and into the More sheet header; it leaves the
   drawer.

## 3. Home (dashboard)

Order on both breakpoints:

1. **Now line** (above). States: voting upcoming (opens in …), voting open (closes in … + credits
   left + "Vote" link), between rounds (schedule not out / schedule out + saved count), attendance
   round open (happening now + saved live sessions), over (thanks + "Feedback" link when open).
2. **Next for you**: the next saved session (time, room, directions link) or, with nothing saved,
   the next session in the program. Hidden before the schedule is published.
3. **Your ballot** (existing card, kept): supported, cast, remaining with the progress bar; the
   sealed-ballot sentence shortened to one line.
4. **Your proposals** (existing).
5. **From the organizers**: the last three `admin_announcement` notifications for this
   gathering, from the notifications feed, with "All notifications".
6. **Recently proposed** (existing), **Sessions you're supporting** (existing), **AI assistant
   card** (existing, collapsed to one line with "Connect" on mobile).
7. Organizer banner (existing) gains "N of M sessions placed" from `admin/overview` when the
   schedule is unpublished.

No vote totals, no leaderboard: those were removed on purpose and stay removed. The header stat
tiles are dropped; sessions and participants counts move into the Now line's second line.

## 4. Schedule with tabs

`/e/[slug]/schedule` gets a full-width `SegmentedControl` at the top: **Program** / **My
schedule**. `?view=mine` selects the second; `/e/[slug]/my-schedule` redirects to it (links and
the tab bar point at `/schedule?view=mine`). One `ScheduleView` component replaces the two page
bodies: shared day chips, group-by (By time / By venue) as a small secondary control, track
chips, search only on Program, Happening-now strip only on My schedule, the dashed
"Not yet scheduled" tail only on My schedule. One `GroupHeading`, one card with a `size` prop.
Export button keeps its `favoritesOnly` behaviour per tab.

## 5. Session page

1. Mobile top row: "← Sessions" left, Save + Share icons right, in the context row; the
   in-content "Back to sessions" button is removed.
2. Header card keeps meta, title, hosts. Edit moves into Quick actions.
3. **Quick actions** is one stack on both breakpoints, in this order: RSVP (primary, when
   scheduled), Save to my schedule, Get directions (when locatable), **Join the chat group** (or
   "RSVP to get the chat link", which focuses RSVP), Add to calendar, Share, Share on Bluesky,
   Edit session, Report, Withdraw. On mobile the stack renders directly under the header card;
   on desktop it stays in the sidebar. The separate chat card is removed.
4. Location card keeps the map and address; its own "Get directions" button goes (it is in the
   stack), the address stays tappable (same href).
5. The host popover's mobile sheet respects the bottom bar.

## 6. Copy pass

Every paragraph in the inventory's top 25 becomes at most two sentences that say what happens
now; anything about *why* or *how it is stored* moves to `/help/privacy` (new page: what is
public, what members see, what is never stored) or `/help/assistants`, linked as "Learn more".
Rules: active voice, sentence case, name the thing the person controls, no "we", no mechanism
words (record, repository, HMAC, fingerprint) outside `/help`. `SettingsModal` gets a one-line
description per section with the detail collapsed behind "Details".

## 7. Waves

1. **Wave S (shell)**: §2 + §5.1 + safe areas + copy for the shell. Playwright at 390×844 and
   1280×800: tab bar present only on mobile, More sheet a11y, avatar → Account modal, context row.
2. **Wave H (home + schedule)**: §3 + §4. Tests for each Now-line state (fixtures with rounds at
   different phases), the redirect, the tab state in the URL, both views sharing one component.
3. **Wave A (session actions + copy)**: §5 + §6 + `/help/privacy`. Tests: action order, chat
   button placement in both breakpoints, copy lengths under the limit for the 25 inventory sites.

Each wave: full gate, second-agent review, commit; one release at the end, backup first.

## 8. Decisions taken (change them if wrong)

- Four tabs + More, no centred action button. Propose lives in More and on Home.
- My schedule becomes a tab of Schedule; its URL redirects.
- Stat tiles replaced by the Now line; no vote totals return.
- Dark mode remains unreachable (out of scope).
