Static UX/code audit complete. Repo root: `/Users/benjaminlife/iCloud Drive (Archive)/Documents/cursor projects/schellingpoint-mvp` — all paths below are absolute; line numbers are from the current `atproto` branch working tree.

---

# 0. Cross-cutting defects (fix these first — they explain most of the per-page noise)

**`src/app/globals.css`**
- **:264** `.workspace-content h1 { font-size: clamp(2.15rem, 3.6vw, 3.6rem); font-weight:700 }` sits **outside any `@layer`**, so it beats every Tailwind utility. Every `<h1 className="text-2xl font-display font-bold">` inside `DashboardLayout`/`AdminLayout` (dashboard, sessions, my-votes, my-schedule, participants, propose, admin overview, analytics, members, tracks, revenue, tickets, atproto) is silently rendered at 34–58px. This is the single biggest source of "mismatched vertical rhythm" and "cramped headers". *Fix: move the rule into `@layer components` (or delete it and put the size on a `.page-title` class the pages opt into).*
- **:133 vs :264** two conflicting `.workspace-content h1` rules (one `text-3xl md:text-4xl`, one clamp). *Fix: keep one.*
- **:266** `.workspace-content .stats-card [class*="text-3xl"] { @apply text-4xl }` — an attribute-substring hack that silently resizes any descendant. *Fix: add an explicit `.stat-value` class.*
- **:129–141** `.page-heading`, `.organizer-welcome`, `.dashboard-welcome` are combined in ways that fight (`page-heading` is `flex-row justify-between`, `organizer-welcome p` adds `mt-4`) — see admin overview below.

**Status-badge vocabulary is defined four times with different colours** — the same gathering shows a different-coloured badge on the homepage vs. its own page:
- `src/app/page.tsx:14–23` — `proposals_open: success`, `scheduling: secondary`
- `src/app/MyEventsSection.tsx:10–19` — identical copy
- `src/app/events/page.tsx:18–27` — identical copy
- `src/app/e/[slug]/page.tsx:38–47` — **different**: `proposals_open: default`, `scheduling: amber`
- All four use `variant="destructive"` (red = error colour) for `live: 'Live Now'`.
*Fix: export one `EVENT_STATUS_BADGE` map from `src/lib/events` and import it in all four; give `live` a `success`/`amber` variant instead of `destructive`.*

**Session status wording has three vocabularies for the same DB value:**
- Attendee list: `src/app/e/[slug]/sessions/page.tsx:38–41` → `pending` = "Pending review", `rejected` = "Not selected"
- Attendee detail: `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx:257` → raw `{session.status}` ("pending", "approved")
- Organizer: `src/components/admin/SessionTable.tsx:221–231` raw `{session.status}`; `src/components/admin/AdminStats.tsx:43` "Pending review"; `src/app/e/[slug]/admin/page.tsx:429` raw tab names `all/pending/approved/scheduled/rejected`.
*Fix: one `SESSION_STATUS_LABEL` map in `src/lib/…` and never render `session.status` directly.*

**Colour tokens ignored.** `badge.tsx:9–16` already ships `success`, `amber`, `destructive`, `muted` variants and `--signal-amber` exists, yet raw Tailwind palette is hardcoded in ~20 files: `green-500/600/100`, `emerald-300/50`, `red-500/600`, `yellow-500`, `amber-300/500/600/700`, `orange-500/600`, `blue-500`, `indigo-500`, `cyan-500`. Worst offenders listed per-surface below. *Fix: replace with `success`/`amber`/`destructive`/`primary` tokens; add an Alert `success` variant.*

**Sentence case vs Title Case is split roughly by author, not by surface.** Sentence case: tracks, analytics, communications, schedule builder, event page, login. Title Case: members, revenue, tickets, check-in, propose, session detail Quick Actions, MyEventsSection, co-host invite. *Fix: pick sentence case (the majority and the house voice) and sweep.*

**Four different confirm-destructive patterns:** native `confirm()` (`SessionFeedback.tsx:163`, `SessionResources.tsx:128`), inline row (`admin/tracks/page.tsx:278–283` "✓ / ✕", `admin/members/page.tsx:503–504` "Keep / Revoke", `admin/schedule/page.tsx:690–692` "Keep / Clear day", `admin/SessionCard.tsx:255–256` "Keep / Delete"), custom modal (`SessionDetailClient.tsx:591`, `BatchActions.tsx:200`), `role="alertdialog"` bar (`admin/page.tsx:401`). Affirmative/negative labels differ per instance ("Keep" vs "Cancel"). *Fix: one `<ConfirmInline>`/`<ConfirmDialog>` with fixed "Cancel" + verb.*

**Four different "filter pill" idioms** at four different heights:
- `px-3 py-1.5 rounded-md` raw buttons — `sessions/page.tsx:272–411`, `admin/SessionFilters.tsx:169–229`
- same but `text-xs min-h-[32px]` — `my-schedule/page.tsx:288,301`
- full `<Button size="sm">` (h-10) — `participants/page.tsx:98–111`, `SessionResources.tsx:156`
- `rounded-full px-4 py-2.5 min-h-[44px]` — `auth/OnboardingModal.tsx:381,398`
Within one file the heights even differ: `sessions/page.tsx:351,363` add `min-h-[36px]` to track pills but not to format/status/sort pills. *Fix: one `<FilterChip>` component.*

**Login redirect param is inconsistent** — `?redirect=` in `SiteHeader.tsx:13`, `DashboardLayout.tsx:246,346`, `EventAccessGate.tsx:36`, `e/[slug]/page.tsx:136`, `tickets/page.tsx:76,97`, `checkin/page.tsx:95,134`; `?returnTo=` in 14 other call sites. `LoginClient.tsx:28` accepts both, so nothing breaks — but it's a trap. *Fix: standardise on `returnTo` and delete the fallback.*

**Sticky offsets disagree:** `schedule/page.tsx:127,208,278` use `top-[104px]`, `my-schedule/page.tsx:336,415` use `top-[120px]`, `sessions/page.tsx:236` and `admin/page.tsx:288` use `top-20` (80px). The workspace header is 76px. *Fix: one `--workspace-header-h` var.*

**Ellipsis characters:** `…` in most new copy, `...` in `SessionFeedback.tsx:156`, `SessionResources.tsx:190`, `checkin/page.tsx:192`, `OnboardingModal.tsx:53`, `invite/[token]/InviteClient.tsx:66`, `SessionFilters.tsx:110`. *Fix: sweep to `…`.*

**British/American split:** "organiser" in `src/app/e/[slug]/admin/atproto/page.tsx:225` and `src/components/TimePreferences.tsx:233`; "organizer" everywhere else. *Fix: American.*

---

# 1. Public / landing

### `src/app/page.tsx`
- **:55** `<Badge variant={badge.variant} className="border bg-white text-[#203b30]">` — the override kills the variant entirely, so *every* poster badge looks identical regardless of status. *Fix: drop the colour override, or drop the variant prop and admit it's a neutral chip.*
- **:64** `{event.attendee_count} attendees` — the word "attendee" appears nowhere else in the attendee UI (which says "participants" / "people"). *Fix: "people".*
- **:98 vs :120** heading "Find your next gathering" directly above a button "Create an event" — gathering/event used interchangeably in one viewport. *Fix: pick "gathering" for user-facing copy.*
- **:102** "View All" (Title Case) is the only Title Case label on the page. *Fix: "View all".*
- **:135** `<Link className="bold-cta !bg-[#e8ef86] !text-[#203b30]">` — a hand-rolled CTA with `!important`s instead of `<Button size="lg">`. *Fix: use Button with a `brand` variant.*
- **:132–137** Create-CTA label "Create your gathering" is the **fifth** wording for this one action (see below). 
- **:204** `<MyEventsSection />` is rendered *after* the big create CTA, i.e. a signed-in organizer must scroll the entire marketing page to find their own gatherings. *Fix: render it directly under `<GatheringHero/>` when `viewer` exists.*

### "Create an event" — five labels for one action
`SiteHeader.tsx:24` "Create event" · `SiteHeader.tsx:29` "Create event" · `page.tsx:120` "Create an event" · `page.tsx:135` "Create your gathering" · `MyEventsSection.tsx:61` "Create New Event" · `MyEventsSection.tsx:140` "Create Your First Event". *Fix: "Create a gathering" everywhere.*

### `src/app/MyEventsSection.tsx`
- **:57** h2 "My Events" Title Case; **:119** "View Event"; **:61/:140** as above. *Fix: sentence case.*
- **:91–94** `text-amber-700 dark:text-amber-400` + "Network identity not yet created" — jargon with **no link to fix it**; the fix lives at `/e/[slug]/admin/atproto`. *Fix: make the line a link to the Network page and reword to "Not published to the network yet".*
- **:117–126** primary action is `variant="outline"` "View Event" (flex-1) next to an **unlabelled gear icon** ghost button; on `/e/[slug]/page.tsx:141` the same admin entry is a text button "Manage event". *Fix: label both "Manage".*
- **:22–36** `formatDateRange` is copy-pasted from `page.tsx:26–44` but **missing the cross-year branch**, so a Dec→Jan gathering prints the wrong year here only. *Fix: import one helper.*

### `src/app/events/page.tsx`
- **:18–27** third copy of the status map; **:30–41** third copy of `formatDateRange` (also missing the cross-year branch).

### `src/app/login/LoginClient.tsx`
- **:150–156** the "Back" link always goes to `/`, even when the user arrived from a gathering via `?returnTo=/e/foo/...`. First-time user who bounces loses the gathering. *Fix: `href={safeReturnPath(searchParams.get('returnTo'))}` and label "Back to {name}" when known.*
- **:111 "Check your inbox"** screen has no route back to the gathering and no resend button — only "Use a different email" (**:137**). *Fix: add "Send it again" and a back link.*
- **:196 "Send sign-in link"** (sentence case, good) vs **:243 "Continue with this account"** — the second button gives no hint it will leave for an OAuth screen. *Fix: "Continue on your PDS →".*
- **:38–45** three error strings, all fine, but `error=link` (**:44**) tells the user to "Request a new one below" while the email field is pre-blanked. Minor.

### `src/components/EventAccessGate.tsx`
- **:59** "Sign in" / **:60** "Explore gatherings" — good, but there is **no "I have an invite link" affordance** on the `private` branch (**:48–51**), which is exactly the case where the user has one. *Fix: add a short "Paste your invite link" hint or a link to `/events`.*

### `src/app/invite/[token]/InviteClient.tsx` (co-host invite) vs `src/app/invite/e/[token]/page.tsx` (gathering invite)
Two invite flows with opposite conventions:
- **`InviteClient.tsx:69`** "Accept Co-Host Invitation", **:79** "Sign In to Accept", **:66** "Accepting..." — Title Case + ASCII ellipsis.
- **`invite/e/[token]/page.tsx:104`** "Accept invitation", **:109** "Sign in to accept", **:104** "Joining…" — sentence case + `…`.
*Fix: align on the `invite/e` wording.*
- **`InviteClient.tsx:153`** the card has **no SiteHeader, no logo, no "what is unconference"** — a first-timer landing on a co-host link has no context and no way out. *Fix: wrap in `SiteHeader` + add "What is this?" line.*
- **`invite/e/[token]/page.tsx:51–53`** auto-redirects to the gathering 2s after accept *and* shows a "Go to the gathering" button — clicking it races the timer. *Fix: drop the timer, keep the button.*
- **`invite/e/[token]/page.tsx:59`** `text-green-500` hardcoded.
- **`invite/e/[token]/page.tsx:47`** dead end "Go home" on a bad token — no "ask the organizer for a new link". *Fix: add that sentence (already present at **:99** for the exhausted case; reuse it).*

### `src/components/auth/OnboardingModal.tsx`
- **:237 "Profile Photo"**, **:271 "Display Name"**, **:299 "Short Bio"**, **:252 "Upload Photo"** Title Case, but **:317 "What are you building?"** sentence case — inside the same modal.
- **:272** required marked `<span className="text-destructive">*</span>`; `admin/communications/page.tsx:198` marks it `Title *`; `SessionFeedback.tsx:176` uses "(optional)". Three conventions. *Fix: "(optional)" on optional fields, nothing on required ones.*
- **:332–342** "Telegram" field — see §5.
- **:381 / :398** interest chips are a 4th pill style.
- **:328** `you're` with a straight apostrophe in JSX (also `my-schedule/page.tsx:212`, `OnboardingModal.tsx:367`) vs `’` elsewhere.

---

# 2. Gathering pages (attendee)

### `src/app/e/[slug]/page.tsx`
- **:126–142** three CTAs in one row with three variants: primary "Explore sessions", outline (whose label is one of *four* different strings at **:137**: "Get tickets" / "Your gathering" / "Sign in to reconnect" / "Sign in to join"), and ghost "Manage event". The ghost admin button is visually weakest but is the organizer's main entry. *Fix: collapse to two buttons; move "Manage event" to a secondary line.*
- **:136** when `ticketingEnabled` and the viewer is signed out, "Get tickets" links to `/tickets`, which immediately bounces to `/login` (`tickets/page.tsx:76`) — a hidden auth wall. *Fix: send signed-out users straight to `/login?returnTo=/e/{slug}/tickets`.*
- **:141** "Manage event" ≠ sidebar "Admin" (`DashboardLayout.tsx:207`) ≠ admin sidebar badge "Organizer workspace" (`admin/layout.tsx:75`) ≠ WorkspaceHeader "Overview & sessions". Four names for one place. *Fix: "Organizer workspace" everywhere.*
- **:151–166** the stats strip always renders, so a brand-new gathering shows "0 Sessions / 0 Participants / 0 Tracks". *Fix: hide the strip when all three are 0.*
- **:176** "View all →" is a bare text link with a literal arrow; the dashboard uses `<Button variant="ghost">View all <ArrowRight/></Button>`. *Fix: same component both places.*
- **:243–259 "Quick Actions"** labels ("Propose", "My Votes", "Saved", "People") differ from the sidebar labels ("Propose a session", "My Votes", "My Schedule", "People") for the identical destinations. *Fix: reuse `getNavItems` labels.*
- **:41–44** "Proposals Open" / "Voting Open" / "Live Now" Title Case badges vs sentence case everywhere else.

### `src/components/DashboardLayout.tsx`
- **:188 "Propose a session"** (desktop, primary Button) vs **:306 "Propose Session"** (mobile, plain text link, no button styling) — same action, different label *and* different affordance. *Fix: same Button + label in both.*
- **:303 / :311** `className="… text-sm … text-xs …"` — conflicting font sizes on the mobile nav links. *Fix: remove `text-sm`.*
- **:249 / :350 "Sign In"** vs `SiteHeader.tsx:28` "Sign in" vs `checkin/page.tsx:35` "Log In" vs `tickets/[ticketId]/page.tsx:115` "Log In". *Fix: "Sign in".*
- **:245–250 / :345–351** signed-out CTA is a hand-rolled `<Link>` with button classes (`bg-secondary` desktop, `bg-primary` mobile — different colours). *Fix: `<Button asChild>` both.*
- **:41–42** nav label "My Schedule" but `shortLabel: 'Saved'`; the gathering page calls it "Saved" and the page itself is titled "My Schedule". *Fix: pick one.*
- **:362** the WorkspaceHeader label is derived by a five-branch inline ternary chain that silently falls through to "Your gathering" for any unmapped route (e.g. `/tickets`, `/checkin` if ever moved in). *Fix: a route→label map.*

### `src/components/WorkspaceHeader.tsx`
- **:14** "Event page ↗" — the product otherwise says "gathering"; also `ArrowUpRight` implies an external link but it's internal. *Fix: "Gathering page" + `ArrowRight`.*
- **:10** `hidden md:flex` — on mobile there is **no breadcrumb at all**, so a mobile user inside `/sessions/[id]` sees only the gathering name. *Fix: render a compact breadcrumb on mobile.*

### `src/app/e/[slug]/dashboard/DashboardClient.tsx`
- **:295, :299, :303, :324** `yellow-500/600`; **:433** `text-red-500`; **:469, :473, :474** `orange-500` — none are tokens. *Fix: `Badge variant="amber"`, `signal-amber`.*
- **:244 `variant="outline" size="sm"`** for "View details" vs **:306, :352, :399, :436 `variant="ghost" size="sm"`** for the identical "View all" action, in the same column. *Fix: one variant.*
- **:324–326** hardcodes the literal string `pending` with `className="capitalize"`, while **:416–418** renders `{session.status}` raw. *Fix: shared label map.*
- **:126 `gap-3`** for the stat grid vs **:179 `gap-4`** for the action grid vs **:116 `space-y-6`** — three rhythms stacked. *Fix: one gap scale.*
- **:178** the three action cards render only when `user && isMember`. A **signed-in non-member** sees four stat cards and "Recently proposed" with **no join CTA anywhere** — a dead end. *Fix: render a "Join this gathering" card in the `!isMember` branch.*
- **No empty state at all:** with zero sessions/proposals/votes every `&&` block collapses and the page is four zeros plus a welcome banner. *Fix: add a "Nothing here yet — here's what to do first" card.*
- **:206 "My Schedule"**, **:300 "My pending proposals"**, **:434 "Sessions you're supporting"** — Title/sentence case mixed in adjacent cards.
- **:484** "Review" button label; the admin page's own CTA for the same job is "Review proposals" (`admin/page.tsx:356`). *Fix: match.*

### `src/app/e/[slug]/sessions/page.tsx`
- **:213 "My sessions"** (badge) vs **:281 "My Sessions"** (filter button) — same filter, same page, two capitalizations. **:292 "My Favorites Only"**, **:305 "All Days"** also Title Case.
- **:211** `<Badge className="px-2.5 py-1 text-sm">` overrides the badge's own `text-xs` — a one-off size. *Fix: drop the override.*
- **:39** `bg-yellow-500/15 text-yellow-700 … border-yellow-500/40` reimplements `Badge variant="amber"`.
- **:447–455** (mine empty state) uses `flex gap-3`; **:463–468** (all empty state) uses `className="mt-4 mr-3"` margins. Two layouts for the same component. *Fix: both use the flex row.*
- **:452 / :466 "Propose a Session"** — Title Case; sidebar says "Propose a session"; mobile nav says "Propose Session"; propose page CardTitle says "Propose a Session"; tickets success says "Propose Session". Five variants of one label.
- **:417** the results grid renders *above* the empty state, so on a filter change the stale grid and the spinner co-exist; harmless but the empty state can flash below a full grid. *Fix: render one or the other.*
- **:463** "Clear filters" is `variant="outline"`; `admin/SessionFilters.tsx:152` "Clear all filters" is a bare `<button className="text-primary">`. *Fix: same control.*

### `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx`
- **:214–217** `<Button onClick={router.back()}>Back to Sessions</Button>` — the label lies whenever the user arrived from the dashboard, a notification, or a shared link. *Fix: `<Link href={/e/{slug}/sessions}>` with that label, or label it "Back".*
- **:257** raw `<Badge>{session.status}</Badge>` — shows "pending"/"approved" lowercase, un-capitalized (unlike every other status badge, which adds `capitalize`).
- **:253/:256/:260** separator is `-` (hyphen); the dashboard uses `•` (`DashboardClient.tsx:374`), my-votes uses `·` (`my-votes/page.tsx:159`), members uses `·`. *Fix: `·` everywhere.*
- **:228 + :250 + :269** three 44px icon buttons are absolutely positioned at `top-4 right-4` and the title/metadata compensate with `pr-28` (112px) — **the buttons are 132px wide plus gaps**, so on narrow screens the title runs under them. *Fix: put the actions in a flex row above the title instead of absolute + `pr-28`.*
- **:447–458** "Join Telegram Group" with hardcoded brand colour `bg-[#0088cc] hover:bg-[#006699]` — the only brand-coloured button in the app, and it ignores dark mode. *Fix: `<Button variant="outline">` + generic label (see §5).*
- **:460–464** "This session has a Telegram group for confirmed attendees." — states a gate with **no way through it**; the RSVP button is 80 lines away in the right column. *Fix: add "RSVP to get the link" pointing at the RSVP control.*
- **:553–557 "Add Telegram Group"** opens the *same* `EditSessionModal` as **:508 "Edit Session"** directly above it — two buttons, same variant, same action. *Fix: delete the second; the edit modal already has the field.*
- **:559–567 "Withdraw Proposal"** is `variant="outline"` with destructive text, while the confirmation at **:612** is `variant="destructive"`. *Fix: make the trigger `variant="outline"` + destructive text *or* destructive — consistently with `admin/SessionCard.tsx:296–302`, which uses the same outline+red trick.*
- **:468 "About This Session"**, **:481 "Session Format"**, **:505 "Quick Actions"**, **:499 "Your votes"**, **:360 "Self-Hosted Location"** — Title Case except one. All Quick Action labels Title Case ("Edit Session", "Share Session", "Add to My Schedule").
- **:480–491** the "Session Format" card repeats the format chip already shown at **:252** — pure filler between two useful cards. *Fix: delete; move the one-line description into the chip's tooltip.*
- **:379 / :410 "Get Directions"** is an `<a>` faking a button (`px-3 py-1.5 rounded-md`) — different height (30px) and radius from every real button (h-10/h-11, `rounded-lg/xl`). *Fix: `<Button asChild variant="outline" size="sm">`.*
- **:621–625** the "Link copied to clipboard!" toast has **no `role="status"`/`aria-live`**, so it's invisible to screen readers; and it is the *only* success feedback on the page — favouriting (**:122**), RSVP, and edit-save produce none. *Fix: add `role="status"` and reuse the toast for the other three.*
- **:238** `text-red-500` for the favourite heart (also `SessionCard.tsx:107`, `my-schedule/page.tsx:385,459,520`, `schedule/page.tsx:159,238,311`). *Fix: one `--favorite` token.*
- **:220** `border-amber-500/40 bg-amber-500/5` — 4th amber treatment.
- **:362** badge "Self-Hosted" + heading "Self-Hosted Location"; `my-schedule/page.tsx:167` says "Self-hosted"; `schedule/page.tsx:212,229` says "Self-Hosted"; `AddToCalendar.tsx:56` says "Self-hosted". *Fix: "Self-hosted".*

### `src/app/e/[slug]/schedule/page.tsx`
- **:127/:208/:278** sticky `top-[104px]` (vs my-schedule's `top-[120px]`).
- **:210, :219, :228** self-hosted sessions get `orange-500/600` hardcoded — a colour used nowhere else in the design system. *Fix: `Badge variant="amber"` + `card-hover`.*
- **:285** `{venueSessions.length} sessions` — no singular ("1 sessions"). Same at `my-schedule/page.tsx:420`.
- **:129 `text-lg`** for the time header but **:210 `text-sm`** for the self-hosted header — the same level of heading at two sizes on one page.
- **:358–370** the "no sessions" card appears *inside* the day container, so when the whole gathering has no schedule the user sees day tabs + an empty card with no "browse proposals instead" CTA. *Fix: add a link to `/sessions`.*

### `src/app/e/[slug]/my-schedule/page.tsx`
- **:210** h1 `text-2xl font-bold` (no `font-display`, unlike sessions/dashboard) — and overridden anyway by globals.css:264.
- **:226 "Browse Sessions"** Title Case vs `my-votes/page.tsx:128` "Browse sessions". Same button, same empty-state pattern.
- **:253–277** sort toggle is a custom segmented control (`bg-muted/50 rounded-lg p-1`); `admin/page.tsx:435–438` builds the same idiom out of `Button secondary/ghost` with `rounded-r-none`. Two segmented controls. *Fix: one `<SegmentedControl>`.*
- **:257 `min-h-[36px]`** on the sort pills vs **:288 `min-h-[32px]`** on the track pills — 4px apart, in the same toolbar.
- **:398–406 / :471–479** "No sessions saved for this day." with **no action** — no "browse sessions", no "clear track filter". *Fix: add the clear-filter button.*
- **:486** "Not Yet Scheduled" Title Case section heading.
- **:242 `className="calendar-day … h-auto"`** — the `.calendar-day` component class sets `min-h-16 px-5 border-2`; combining it with `h-auto flex-col` produces day tabs noticeably taller than the ones at `admin/schedule/page.tsx:660` that use the same class without `h-auto`.

### `src/app/e/[slug]/my-votes/page.tsx`
- **:73** h1 `text-2xl font-bold` (third h1 recipe).
- **:105** label says "Credits remaining" but the value renders `{remaining}/{budget}` while the sibling "Credits used" renders a bare number, and `DashboardClient.tsx:271` renders the same "Credits remaining" as a bare number. *Fix: bare number here too.*
- **:225–227** "Public tally data" link is an `<a href>` to a **raw JSON API endpoint** presented as a normal link — a first-time user clicking it gets a JSON dump. *Fix: label it "Download tally (JSON)" and add `download`.*
- **:240** "No sessions were open for voting." dead end — no link to `/sessions`.

### `src/app/e/[slug]/participants/page.tsx`
- **:184–191 `not_member` state: "Members only" / "Join this gathering to see and connect…" with no Join button** — it tells the user exactly what to do and gives no way to do it. The `JoinGatheringButton` exists at `contexts/EventContext.tsx:309`. *Fix: render `<JoinGatheringButton/>` in that branch.*
- **:196** the error/empty state uses `<h1 className="text-lg">` while the real page h1 at **:218** is `text-2xl` — two h1s of different rank for the same route.
- **:240** `text-green-600` for the success message (the `success` token exists).
- **:98–111** interest filters are full `Button size="sm"` (h-10) with a "Clear all" ghost button inline at **:93** — a 40px-tall pill row next to a 40px text button, versus the 30px pills on the sessions page.
- **:241** "Filter by interests:" trailing colon (nowhere else does this).
- **:275** "Try adjusting your search or filters" — no full stop, while the sibling string at **:274** has one.
- **:367** privacy copy names "Telegram" (see §5).

### `src/app/e/[slug]/notifications/page.tsx`
- **:17–38** 11 hardcoded palette colours for the type dots — and this map **disagrees with the bell's map** (`NotificationBell.tsx:21–37` is missing `voting_opened`, `voting_closed`, `schedule_published`, `event_reminder`, `proposal_needs_review`, so those show grey in the popover and coloured on the page). *Fix: move the map to `src/lib/notifications/categories.ts` and import in both.*
- **:128–133** a "Back" button to `/dashboard` — the **only** back button inside `DashboardLayout`, and wrong whenever the user came from the bell on another page. *Fix: delete it (the sidebar is the back affordance).*
- **:139** "All caught up!" — the only exclamation mark in the workspace voice.
- **No link to notification preferences** from this page, even though `/e/[slug]/settings/notifications` exists and is only reachable from the bell popover footer (`NotificationBell.tsx:217`). *Fix: add a "Preferences" button next to "Mark all as read".*
- **:145 "Mark all as read"** vs `NotificationBell.tsx:164` **"Mark all read"**. *Fix: match.*
- **:156** the error state is plain grey text with **no retry**. *Fix: add "Try again".*

### `src/app/e/[slug]/settings/notifications/page.tsx`
- **:117** h1 "Notification Settings" vs `DashboardLayout.tsx:362` breadcrumb "Notification preferences" vs `NotificationBell.tsx:219` link label "Settings". Three names. *Fix: "Notification preferences".*
- **:110–115** "Back" → `/dashboard`, but the only entry point is the bell popover on an arbitrary page. *Fix: `router.back()` or remove.*

### `src/app/e/[slug]/propose/page.tsx`
- **:327 h1 "Bring an idea to the room."** immediately above **:335 CardTitle "Propose a Session"** — two competing titles, second in Title Case.
- **:272 "Session Proposed!"** success screen offers **:289 "View Sessions"** (the whole list) and **:314 "Propose Another"** — there is **no link to the proposal that was just created**, even though **:285** tells the user to "Share an invite link from the session page". Classic dead end. *Fix: primary button → `/e/{slug}/sessions/{newId}`.*
- **:753 "Submit Proposal"**, **:314 "Propose Another"**, **:289 "View Sessions"** Title Case.

### `src/app/e/[slug]/tickets/**`
- `tickets/page.tsx:59 "Get Your Ticket"`, **:76 "No Tickets Available"**, **:111 "Coming Soon"**, **:115 "Sales Ended"**, **:119 "Sold Out"** — Title Case block.
- `tickets/page.tsx:98` `<Badge className="bg-green-600">` overrides the variant (the `success` variant exists); **:125/:131** `text-green-600`.
- `tickets/page.tsx:145 "Tickets aren't available here"` and **:176 "No Tickets Available"** — both dead ends with **no link back to the gathering** (the layout's back link is at the top, easy to miss). *Fix: add a "Back to {name}" button in the card.*
- `tickets/success/page.tsx:108` button labelled **"View Schedule"** links to **`/sessions`**, not `/schedule`. Straight mislabel. *Fix: point at `/schedule` or rename to "Browse sessions".*
- `tickets/success/page.tsx:30 "You're In!"` vs `invite/e/[token]/page.tsx:60 "You're in!"`.
- `tickets/success/page.tsx:49` `Status: {ticket.status === 'confirmed' ? 'Confirmed' : ticket.status}` — leaks raw `pending`/`checked_in`.
- `tickets/success/page.tsx:63 "What's Next?"` — the three numbered steps duplicate the two buttons below them; step 1 ("Keep your ticket handy") is the only one without a corresponding button, and the "View Your Ticket" link is demoted to `variant="link"` at **:121–126**. *Fix: make step 1's link the primary action.*
- `tickets/success/page.tsx:26–27` `bg-green-100 dark:bg-green-900/30`, `text-green-600`.
- `tickets/[ticketId]/page.tsx:115` "Log In".

### `src/app/e/[slug]/checkin/page.tsx` — **worst navigation dead end in the app**
- The admin sidebar lists **Check-in** (`admin/layout.tsx:28`) pointing at `/e/{slug}/checkin`, but that route is wrapped in `EventUtilityLayout` (`checkin/layout.tsx`), i.e. the **public SiteHeader with a "Back to {event}" link to the public page**. An organizer clicking "Check-in" is ejected from the organizer workspace with no route back into it. *Fix: either move check-in under `/admin/checkin` or give `EventUtilityLayout` an optional "Back to organizer workspace" target.*
- **:196–198** `QRScanner onError={(err) => console.error(...)}` — if the camera is blocked or unavailable **the user sees nothing at all**, and there is no manual code entry (the hint at **:271** just says "ask the attendee to show their ticket"). Dead end at the door. *Fix: surface the error and add a manual ticket-code field.*
- **:125 "Please Log In"** / **:129 "Log In"**; **:150 "Access Denied"** — harsh and unlike the friendly `admin/layout.tsx:56` "Organizers only" with escape buttons; **:151–153** offers no link out at all.
- **:171 "Check-In Scanner"**, **:182/:189/:196 "Total"/"Checked In"/"Remaining"**, **:247 "Scan QR Code"**, **:235 "Scan Next"** Title Case.
- **:181, :187, :192, :204, :206, :208** `green-50/500/600`, `amber-50/500/600`, `red-50/500/600` hardcoded; this is the only screen using `red-600` for errors instead of `destructive`.
- **:192 "Processing..."**.

---

# 3. Admin

### `src/app/e/[slug]/admin/layout.tsx`
- **:60** `?returnTo=` here vs `?redirect=` on the attendee side — see §0.
- **:31 + :32** "Event settings" and "Spaces & times" use the **same `Settings` icon**. *Fix: `MapPin`/`CalendarRange` for the second.*
- **:74** the sidebar logo links to **`/`** (site root), while the attendee sidebar logo links to `/e/{slug}` (`DashboardLayout.tsx:141`). An organizer clicking the logo lands on the marketing page. *Fix: link to `/e/{slug}`.*
- **The organizer sidebar has no NotificationBell, no avatar, no sign-out** — all three exist in `DashboardLayout.tsx:238–241`. An organizer working in the admin shell can't see notifications or sign out without leaving. *Fix: reuse the same footer block.*
- **:83** `<WorkspaceHeader/>` is `hidden md:flex`, so the mobile admin shell has **no breadcrumb**; combined with **:80** (only the gathering name + hamburger) a mobile organizer can't tell which admin page they're on.
- **:77 "Attendee view"** ↔ `DashboardLayout.tsx:207` **"Admin"**: the round-trip pair is named asymmetrically. *Fix: "Attendee view" ↔ "Organizer workspace".*
- **:40** the fallback breadcrumb is "Organizer workspace" while the sidebar badge (**:75**) is also "Organizer workspace" — the breadcrumb then reads "{name} / Organizer workspace" with no page name for unmapped routes (e.g. `/admin/sessions/new`).

### `src/app/e/[slug]/admin/page.tsx`
- **:267** h1 is the slogan **"Make space for good ideas."** with no page name, while the sidebar item and breadcrumb say "Overview & sessions". A first-time organizer cannot tell where they are. *Fix: h1 "Overview & sessions", slogan as the subtitle.*
- **:265** `className="page-heading organizer-welcome"` combines a flex-row heading with `organizer-welcome`'s `border-b-2 pb-8` + `p { mt-4 }`, so the "Add a session" button (**:271**) sits top-aligned against a paragraph pushed down 16px.
- **:465** `` `No ${activeTab === 'all' ? '' : activeTab} sessions yet.` `` → renders **"No  sessions yet."** with a double space on the "all" tab. *Fix: branch the whole string.*
- **:466** the empty state offers "Show all sessions" even when there are literally zero sessions — a button that does nothing. *Fix: show "Add a session" / "Invite people" instead when `sessions.length === 0`.*
- **:429** tabs render raw statuses (`all/pending/approved/scheduled/rejected`) via `capitalize`. *Fix: label map ("All", "Awaiting review", "Approved", "Scheduled", "Not selected").*
- **:318, :320, :383, :387, :390, :456, :457** amber palette hardcoded (the 3rd, 4th and 5th amber recipes in the codebase).
- **:330 "Open schedule builder"** is a bare `text-primary` link; **:376** the same label is an `inline-flex` link; **:356 "Review proposals"** is a Button. Three treatments of "go do the next thing".
- **:288** notice is `sticky top-20` but the admin shell has no sticky header — the notice floats 80px from the viewport top over content.
- **:356** clicking "Review proposals" scrolls to `#session-review` but doesn't move focus. *Fix: `.focus()` the tablist.*
- **:436–437** the table/card segmented toggle (`Button secondary/ghost` + `rounded-r-none`) is the second segmented-control implementation (see my-schedule).

### `src/app/e/[slug]/admin/schedule/page.tsx`
- **:519** `<h1 className="font-semibold">Schedule builder</h1>` — **no size class at all**, so it takes the globals.css:264 clamp and renders at up to 58px above a toolbar. *Fix: give it the shared page-title class.*
- **:672–674** Undo / Redo / Clear-day are icon-only ghost buttons with `title` only; "Clear day" is destructive and unlabelled. On mobile this row is 5 icons + a badge + Publish. *Fix: put destructive "Clear day" behind an overflow menu.*
- **:690–692** confirm pair is "Keep / Clear day"; elsewhere "Cancel / Delete", "Keep / Revoke", "Keep / Delete".
- **:617, :633, :909, :963** `green-500/700`; **:531, :543, :544, :677, :696, :729, :746, :759–766, :799, :803, :819, :837, :921, :933, :1018** amber — this single file contains ~18 hardcoded amber declarations in at least four different recipes (`bg-amber-500/10 text-amber-700 dark:text-amber-400`, `border-amber-500/40`, `bg-amber-100 dark:bg-amber-950/30`, `text-amber-600`).
- **:696** "Scroll horizontally to see every room." is styled as a warning banner (amber) for what is a neutral hint. *Fix: muted.*

### `src/app/e/[slug]/admin/tracks/page.tsx`
- **:167** `className="max-w-4xl"` — the only admin page that constrains its own width (others are full `workspace-content` width, atproto is `max-w-5xl`). Three content widths across the admin shell. *Fix: one.*
- **:277** `{track.session_count} sessions` — "1 sessions".
- **:198** required marker `Name *` in red (3rd convention).
- **:188** status message is a bare `<p role="status" className="border-primary/30">`; `communications/page.tsx:139` uses `<Alert>`; `admin/page.tsx:288` uses a sticky div; `atproto/page.tsx:245` uses an emerald `<p>`. Four notice patterns.
- **:253** "No tracks yet." with no CTA (the "Add track" button is hidden while the form is open). *Fix: put "Add your first track" in the empty state.*
- **:205–215** colour swatches are 32×32 buttons — below the 44px target used elsewhere (`min-h-11` in `.workspace-nav-link`).

### `src/app/e/[slug]/admin/members/page.tsx`
- **Whole page is Title Case**: **:265** "Members", **:272** "Invite People", **:283** "Invite People", **:291** "Shareable Link", **:300** "Email Invites", **:313** "Email Addresses", **:449** "Pending Invitations", **:529** "All Members". Tracks/Analytics/Communications next door are sentence case.
- **:266** `{members.length} members in {event.name}` — "1 members".
- **:270/:280** the state is called `showInviteModal` but renders an **inline Card** that pushes the page down, with no focus trap, no Escape handler, and no scroll-into-view. *Fix: either a real dialog or rename and scroll to it.*
- **:503–504 "Keep / Revoke"** vs **:611–625 "Cancel / Remove"** — two confirm vocabularies on one page.
- **:618** `text-green-600`.
- **:477–479** `<Badge title="Uses / max uses">{use_count}/{max_uses ?? '∞'} used</Badge>` — "3/∞ used" is cryptic; the meaning is only in a `title`. *Fix: "3 of 10 used" / "3 used, no limit".*
- No empty state for "no pending invitations" (**:443** just hides the section), so a first-time organizer never learns invite links exist until they create one.

### `src/app/e/[slug]/admin/communications/page.tsx`
- **:126** h1 "Messages" — the page sends *announcements* and *host emails*; "Messages" implies an inbox/DMs. Sidebar also says "Messages" (`admin/layout.tsx:27`). *Fix: "Announcements & emails".*
- **:198 "Title *"** and **:202 "Message *"** — bare asterisks (4th required-marker convention).
- **:172 `className="w-full sm:w-auto"`** vs **:216 `className="w-full"`** — two widths for the two primary buttons on one page.
- **:139–140, :192–193** `bg-green-500/10 border-green-500/30`, `text-green-500` because `<Alert>` has no success variant. *Fix: add `variant="success"` to `ui/alert.tsx`.*
- **:177 "Unable to load."** — no retry, no explanation. *Fix: "Couldn't load email status. Try again" + button.*
- **:233 "No announcements sent yet"** — missing full stop (the other empty states have one) and no CTA pointing at the compose form beside it.
- **:168 `{stats.skipped.length} not ready`** — "not ready" is unexplained until you expand the `<details>`.

### `src/app/e/[slug]/admin/analytics/page.tsx`
- **:135–138** status bars use `bg-green-500 / bg-blue-500 / bg-amber-500 / bg-red-500` for Scheduled/Approved/Pending/Rejected — a **fifth** status colour language (the badge map, the notification map, the sessions-list map and the admin card map all differ). *Fix: one status→colour token map.*
- **:179** room utilisation is **red below 50%** — an empty room at the start of planning is rendered as an error. *Fix: neutral/muted for low, amber for over-full.*
- **:46** "Your role does not include analytics." — no link out, no explanation of who can grant it. *Fix: "Ask an owner or admin to change your role." + back link.*
- **No empty state:** a fresh gathering shows six cards of zeros and four empty bars. *Fix: one "Nothing to measure yet" card.*
- **:119–121 "Show all {n}" / "Show fewer"** is a bare `<button className="text-primary">` — the only non-Button expander in admin.

### `src/app/e/[slug]/admin/revenue/page.tsx`
- **:134–137** `<Button variant="outline" disabled>` "Export Report" — a permanently dead control with **no tooltip or "coming soon"**. *Fix: remove it or add `title="Coming soon"`.*
- **:162, :188, :203, :216, :229, :244, :262, :307** all card titles Title Case ("Gross Revenue", "Net to Organizer", "Check-Ins", "Avg. Ticket Price", "Sales by Tier", "Sales Over Time").
- **:172–178** `text-green-600` / `text-red-600` for the delta.
- **:297 "No ticket tiers configured yet"** — no link to `/admin/tickets` where you'd create one. *Fix: add the link.*

### `src/app/e/[slug]/admin/atproto/page.tsx`
- **:219** `<div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">` — this page adds its own padding **inside** `.workspace-content`'s `p-5 md:p-8 lg:p-10`, so it is inset ~64px more than every other admin page and capped at a different width.
- **:221** h1 `text-2xl font-semibold` (no `font-display`) — the third h1 recipe in admin.
- **:225** "organiser" (British).
- **:230, :253** `border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40`; **:245** `border-emerald-300 bg-emerald-50` — emerald appears **only** here, a 5th success colour.
- **:274** `<Badge>{status.health.state}</Badge>` and **:569** `<Badge>{a.decision}</Badge>` — raw machine values ("ok", "degraded", "allow", "deny") shown to organizers. *Fix: label maps.*
- **:321–325 "Disconnect / Keep"** — yet another confirm pair.
- **:433** good: `cid-drift` is translated to "Edited". Do the same for `health.state`.
- Sidebar calls this **"Network"** (`admin/layout.tsx:36`), the page h1 says **"On the network"**, the gathering page says **"View on the network"** (`e/[slug]/page.tsx:121`), `MyEventsSection.tsx:93` says **"Network identity"**. *Fix: one noun.*

### `src/components/admin/*`
- `AdminStats.tsx:118–120, :167` amber recipe #6.
- `SessionCard.tsx:100` the **format** badge's variant is chosen by the session's **status** (`isScheduled ? 'default' : isApproved ? 'secondary' : 'outline'`) — colour says one thing, text says another. *Fix: fixed `secondary` for format; a separate status badge.*
- `SessionCard.tsx:263 "Reject" (outline) + :271 "Approve" (primary)` vs `BatchActions.tsx:92–111` the same two actions as **ghost buttons with green/red icons** vs `BatchActions.tsx:228 "Reject All" (destructive)`. Three visual treatments of approve/reject. *Fix: outline+destructive-text for reject, primary for approve, everywhere.*
- `SessionCard.tsx:93, :116, :155, :158, :164` `green-500/600`; **:121** amber; **:193** `blue-500` (time-preference chips — blue appears nowhere else).
- `SessionCard.tsx:285 "Move or cancel in schedule builder"` — a 5-word button label inside a `flex-1` row; it wraps. *Fix: "Open schedule builder".*
- `SessionTable.tsx:221–231` raw `{session.status}`; **:152, :262, :276** green; **:201, :281** amber.
- `SessionFilters.tsx:166, :188, :215` `<label>` elements wrapping *groups of buttons* with no `htmlFor` — invalid, and screen readers announce nothing. *Fix: `<fieldset><legend>`.*
- `SessionFilters.tsx:110` placeholder "Search by title, host, or tags..." (ASCII ellipsis) vs `sessions/page.tsx:250` "Search ideas, hosts, or topics" (no ellipsis).
- `SessionFilters.tsx:152` "Clear all filters" bare button vs `sessions/page.tsx:463` "Clear filters" outline Button.
- `BatchActions.tsx:78` the toolbar is `fixed bottom-6` with no offset for mobile safe-area (the `.pb-safe` utility exists in globals.css:128 and is unused here) — it sits over the last row of cards on phones.
- `BatchActions.tsx:206 "Reject 3 Sessions?"` Title Case + **:228 "Reject All"**.

---

# 4. Listed components

### `src/components/NotificationBell.tsx`
- **:21–37** colour map diverges from `notifications/page.tsx:17–38` (missing 5 types → grey dots in the popover, coloured on the page).
- **:164 "Mark all read"** vs page's "Mark all as read".
- **:205–206** "View all" with an **`ExternalLink` icon on an internal `next/link`**. *Fix: `ArrowRight`.*
- **:196** "View all" is hidden when `notifications.length === 0`, so from an empty popover there is **no route to the notifications page** — only "Settings". *Fix: always show it.*
- **:152** `PopoverContent className="w-80"` — 320px popover anchored to a button inside a 240px sidebar; on small laptops it overhangs the content edge.
- **:141** `size="sm"` (h-10) next to the sign-out `size="icon-sm"` (h-10 w-10) in `DashboardLayout.tsx:239` — the bell is wider than square and the pair looks unaligned.

### `src/components/SessionFeedback.tsx`
- **:163** native `confirm('Withdraw your feedback…')`.
- **:156 "Loading feedback..."**.
- **:268–281** "Edit" is a text ghost button, "withdraw" next to it is an **icon-only** ghost button — asymmetric pair for two peer actions. *Fix: both text.*
- **:195** `err.message : 'Failed to save feedback'` and **:174 'Failed to withdraw feedback'` — dev-register copy ("Failed to X") vs the house style elsewhere ("Your saved schedule could not be updated. Please try again.").
- **:325 "Comment (optional)"** — good; contradicts the `*` convention used in members/tracks/communications/onboarding.

### `src/components/SessionResources.tsx`
- **:128** native `confirm(\`Remove "${title}"?\`)`.
- **:231–241** icon buttons forced to `h-7 w-7` (28px) overriding `size="icon"` (44px) — the smallest touch targets in the product.
- **:177 "Add"** (ghost, no noun) vs **:312 "Add resource"** in the form it opens. *Fix: "Add resource" both.*
- **:121, :135, :158** "Failed to add resource" / "Failed to remove resource" / "Failed to reorder resources" — dev register.
- **No success feedback** on add/remove/reorder; failures silently roll the list back (**:157**).
- **:190 "Loading..."**.

### `src/components/TimePreferences.tsx`
- **:139, :151, :153** raw `<select>`/`<input type="time">` at `h-9` (36px) inside forms that otherwise use `<Input>` at h-11 (44px) — visibly shorter controls mid-form. *Fix: use `Input`/a `Select` primitive.*
- **:224 "Add"** appears **twice** on the same screen (once per section) with no noun. *Fix: "Add a window" / "Add a blackout".*
- **:233** "Organisers use this…" (British).
- **:232/:233** section titles "When you can be there" / "When you cannot" — the second is a fragment. *Fix: "When you can't be there".*
- No empty-state line when both lists are empty (just a lone "Add" button).

### `src/components/AddToCalendar.tsx`
- **:100–101** the label and chevron are `hidden sm:inline`. In `SessionDetailClient.tsx:522` this button is rendered inside a `w-full justify-start` Quick Actions stack, so **on mobile it becomes a left-aligned bare calendar icon with no text**, unlike the five labelled rows around it. *Fix: drop the `hidden sm:inline`.*
- **:96** the `variant="icon"` mode renders **no text and no `aria-label`** — unnamed control. *Fix: add `aria-label="Add to calendar"`.*
- **:100 "Add to Calendar"**, **:153 "Export My Schedule" / "Export Full Schedule"** Title Case.
- **:91** `variant === 'outline' ? 'outline' : 'ghost'` — passing `variant="default"` silently yields a ghost button. *Fix: pass through the real variant.*

### `src/components/PublishJobProgress.tsx`
- **:76** the polling error is rendered `text-xs text-muted-foreground` — an error styled as a hint. *Fix: `text-destructive` or keep muted but say "retrying…" (it does; acceptable).* Only real nit here.

### `src/components/GatheringArtwork.tsx`
- Decorative only; `globals.css:140–141` hardcodes `.gathering-art { color: #246653 }` and `button[aria-pressed=true] { background:#246653 }` outside the token system, so the artwork ignores theming. *Fix: use `hsl(var(--primary))`.*

### `src/components/SkillPicker.tsx`
- **:157** when a query ≥2 chars returns nothing, **no "no matches" state** renders — the dropdown just doesn't appear and the user can't tell whether it's loading, broken or empty. *Fix: render an empty `<li>Nothing matches "x"</li>`.*
- **:78–88** the remove-`X` inside the Badge is a ~20px target.
- **:129** renders the raw taxonomy status `proposed` in lowercase.

---

# 5. Product-specific naming inventory ("Telegram" → "chat group")

**A. User-visible strings (change these; no schema impact)**

| file:line | string |
|---|---|
| `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx:456` | `Join Telegram Group` (button label, + brand colour `bg-[#0088cc]` at :453) |
| `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx:463` | `This session has a Telegram group for confirmed attendees.` |
| `src/app/e/[slug]/sessions/[id]/SessionDetailClient.tsx:556` | `Add Telegram Group` (button label) |
| `src/components/EditSessionModal.tsx:472` | `Telegram Group URL (optional)` (field label) |
| `src/components/EditSessionModal.tsx:474` | placeholder `https://t.me/your_group` |
| `src/components/SettingsModal.tsx:491` | `Telegram` (profile field label) |
| `src/components/SettingsModal.tsx:495` | placeholder `@username`; `:166` prefixes `@` |
| `src/components/auth/OnboardingModal.tsx:334` | `Telegram (optional)` |
| `src/components/auth/OnboardingModal.tsx:339` | placeholder `@username` |
| `src/components/auth/OnboardingModal.tsx:345` | help text "Only fellow members … can see this." (no product name — fine) |
| `src/app/e/[slug]/participants/page.tsx:367` | `…your name, photo, affiliation, interests and Telegram.` |
| `src/app/e/[slug]/participants/page.tsx:545` | link `https://t.me/${participant.telegram}` and `:550` `@{telegram}` |
| `src/app/create/steps/BrandingStep.tsx:796` | `Telegram` label; `:804` "Enter your Telegram channel or group URL" |
| `src/app/create/steps/BrandingStep.tsx:810` | `Discord` label; `:813` placeholder `https://discord.gg/yourserver`; `:818` "Enter your Discord invite URL" |
| `src/app/create/steps/ReviewStep.tsx:633` | `Telegram`; `:639` `Discord` |
| `src/app/e/[slug]/admin/settings/_components/BrandingSection.tsx:100` | `Telegram` label + placeholder `https://t.me/…` |
| `src/app/e/[slug]/admin/settings/_components/BrandingSection.tsx:101` | `Discord` label + placeholder `https://discord.gg/…` |
| `src/components/Footer.tsx:52` | icon link label `Telegram`; `:54` `Discord` (+ `DiscordIcon` at `:16`) |
| `src/lib/email/session-scheduled.ts:222` | email copy: "…add a Telegram group link…" |
| `src/app/privacy/page.tsx:106` | "Telegram is shown only to fellow members." |
| `src/app/codeofconduct/page.tsx:52` | "Telegram groups, Discord servers, forum threads…" |
| `src/app/codeofconduct/page.tsx:96` | "…unsolicited referral links, Discord invitations…" |
| `src/app/codeofconduct/page.tsx:150` | "Removal from Telegram, Discord, or other community channels" |

*Suggested generic wording:* session-level → **"Chat group"** / "Join the chat group" / "Chat group link (optional)"; profile field → **"Chat handle"** or keep a typed field but label it "Messaging handle"; branding/social → keep per-platform labels there (they're explicitly a social-links block) but the *session* and *profile* fields should go generic. Policy pages → "chat groups and other community channels".

**B. Field/column names (do NOT rename without a migration — keep as-is, relabel in UI only)**

| identifier | file:line |
|---|---|
| `public.profiles.telegram` (column) | `db/migrations/0001_baseline.sql:1343`; comment `db/migrations/0008_people.sql:34`; CHECK `profiles_telegram_format` `db/migrations/0008_people.sql:60`; note at `:9` and `:103` |
| `public.sessions.telegram_group_url` (column) | `db/migrations/0001_baseline.sql:1447` |
| `telegram_group_url` (API/read model) | `src/app/api/v1/sessions/_lib/read.ts:61, 161, 212, 355`; `src/app/api/v1/sessions/_lib/validate.ts:23 (LOGISTICS_COLUMNS), :142` |
| `has_telegram_group` (derived API flag) | `src/app/api/v1/sessions/_lib/read.ts:165, 348`; consumed at `SessionDetailClient.tsx:460` |
| `telegram` (profile API field) | `src/app/api/me/profile/route.ts:12, 34, 46, 116`; `src/app/api/v1/events/[slug]/participants/people.ts:26, 40`; `src/hooks/useAuth.tsx:33`; `src/components/SettingsModal.tsx:55, 70, 147, 305`; `src/app/e/[slug]/participants/page.tsx:44, 539` |
| `theme.social.telegram` / `.discord` (jsonb) | `src/types/event.ts:48–49`; `src/app/create/useWizardState.ts:96–97, 222–223`; `src/app/api/events/create/route.ts:65–66`; allow-list `src/app/api/events/[eventId]/settings/route.ts:128` |
| `session.telegram` (form state) | `src/components/EditSessionModal.tsx:115, 152, 207` |

**C. Comments/doc strings mentioning Telegram (harmless, update for consistency):** `src/app/api/v1/schedule/public-read.ts:10,11`; `src/app/api/v1/sessions/_lib/read.ts:8,11`; `src/app/api/v1/sessions/[id]/route.ts:76`; `src/app/api/v1/profiles/gone.ts:4`; `src/app/api/v1/events/[slug]/participants/people.ts:7`; `src/app/api/v1/events/[slug]/participants/route.ts:9`; `src/app/api/v1/events/[slug]/sessions/[id]/route.ts:8`; `src/components/EditSessionModal.tsx:77`; `src/lib/atproto/records.ts:401, 707`.

**D. Other platform names found:** `Zoom`/`meet.` only in a URL-detection regex at `src/lib/atproto/records.ts:89` (`/^(https?:\/\/|meet\.|zoom\.us|www\.)/i`) — internal, not user-visible. **No occurrences of Luma, WhatsApp, Signal, or Google Meet** anywhere in `src/` (the Google Maps directions links at `SessionDetailClient.tsx:376, 407` are the only other third-party service references, both unlabelled as "Google").

---

# 6. Suggested order of attack

1. `globals.css:264` h1 clamp (fixes cramped headers app-wide in one line).
2. Extract `EVENT_STATUS_BADGE` + `SESSION_STATUS_LABEL` + `NOTIFICATION_TYPE_COLOR` into `src/lib/` and delete the 4 / 3 / 2 duplicate maps.
3. Sweep raw palette colours → `success` / `amber` / `destructive` tokens; add `Alert variant="success"`.
4. Extract `<FilterChip>`, `<SegmentedControl>`, `<ConfirmInline>`; replace the 4 + 2 + 4 ad-hoc implementations.
5. Sentence-case sweep (members, revenue, tickets, check-in, propose, session-detail Quick Actions, co-host invite, MyEventsSection).
6. Dead ends: participants `not_member` join button · propose success → the new session · check-in camera error + manual entry · check-in route escaping the admin shell · session-detail "RSVP to get the chat link" · notifications retry · `NotificationBell` "View all" when empty.
7. Telegram → "chat group" in UI strings only (table A), leaving columns/fields untouched.
