# Static UX/code audit — create wizard, propose/edit, settings, shared shells

Branch `atproto`. All paths relative to repo root; line numbers from the files as they stand now.

---

## 0. Tokens & patterns already consistent (match fixes to these)

**Primitives**
- `src/components/ui/button.tsx:9-34` — variants `default | destructive | outline | secondary | ghost | link`; sizes `default` (h-11 px-4), `sm` (h-10 rounded-lg px-3), `lg` (h-12 rounded-xl px-6), `icon` (h-11 w-11), `icon-sm` (h-10 w-10). Base radius `rounded-xl`, `active:scale-[0.98]`.
- `src/components/ui/button.tsx:39,62-65` — **`loading` prop exists** (disables + renders `Loader2 mr-2`). Almost nothing uses it; ~12 call sites hand-roll the spinner.
- `src/components/ui/badge.tsx:5-23` — base `rounded-full border px-2.5 py-1 text-xs font-medium`; variants `default | secondary | destructive | success | outline | muted | amber`. `success` and `amber` map to real tokens (`--success` globals.css:58, `--signal-amber` globals.css:60).
- `src/components/ui/card.tsx:16,36,57,64` — `rounded-2xl border bg-card`; header/content/footer padding `p-4 sm:p-6` (content & footer `pt-0`); `accent="top"|"left"` + `accentColor`.
- Also available and under-used: `ui/checkbox`, `ui/color-picker`, `ui/timezone-picker`, `ui/label`, `ui/alert`, `ui/input` (h-10).

**Layout**
- Workspace pages: `.workspace-content` = `mx-auto w-full max-w-[1440px] p-5 md:p-8 lg:p-10` (`src/app/globals.css:132`), with an inner `max-w-2xl` (forms) or `max-w-4xl` (settings).
- Site chrome: `container mx-auto px-5`, header height `h-[76px]` (`SiteHeader.tsx:16`, `WorkspaceHeader.tsx:10`, `Footer.tsx:92`).
- **`.workspace-content h1` is already styled** `text-3xl md:text-4xl font-semibold` (globals.css:133) and clamped at 264. Pages that also set `text-2xl font-bold` are fighting it.
- Sidebar nav: `.workspace-nav-link` `min-h-11 rounded-xl px-3 py-2.5 text-sm` + `[aria-current=page]` active rule (globals.css:135-136).

**Composition patterns worth standardising on**
- Settings section kit: `SectionCard` / `Field` / `SaveBar` / `Toggle` / `ChoiceCard` (`admin/settings/_components/SectionCard.tsx`) — the cleanest pattern in the repo.
- Selected-option card: `rounded-lg border-2 p-4 text-left … border-primary bg-primary/5` (BasicsStep:280-287, VotingStep:231-238, SectionCard.tsx:101).
- Inline error box: `rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive`.
- Inline destructive confirm (no `confirm()`/`alert()`): setup page:431-438, 610-618.

**Cross-cutting gaps that cause most of the findings below**
1. No `ui/select` primitive → **6 distinct raw `<select>` class strings**: `rounded-xl … p-2.5` (VotingStep:444), `rounded-xl … p-3` (SafeguardsSection:28, BasicsSection:41), `rounded-lg … px-3 py-2` (propose:602, sessions/new:272), `rounded-md … px-2 py-1.5` (EditSessionModal:415), `min-h-[44px] rounded-md px-3` (setup:681), `h-9 rounded-md px-2` (AtprotoSessionActions:238).
2. No `ui/switch` → **4 toggle implementations**: VotingStep:349-360 (×3 in one file), SectionCard.tsx:80-83, notifications/page.tsx:41-53 (white knob, h-4), plus ScheduleStep:458-466.
3. `Badge` is bypassed for ad-hoc spans in ≥7 places → **7 chip styles** (listed per-surface below).
4. `btn-primary-glow` (SettingsModal.tsx:674, OnboardingModal.tsx:513, schedule/page.tsx:266) **is not defined anywhere** — a dead class on the profile modal's primary Save.
5. Hard-coded Tailwind colors instead of tokens: `green-500/600`, `amber-500`, `red-500`, `gray-300` across RSVPButton, SettingsModal, propose, sessions/new, ReviewStep, ManageCohosts — while `success`/`amber`/`destructive` Badge variants and `--success`/`--signal-amber` exist.
6. Title Case vs sentence case is mixed within single screens ("Event Details"/"Propose a Session"/"Save Changes" vs "Network identity"/"Dates & timezone"/"Save changes").

---

## 1. Gathering creation wizard — `src/app/create/**`

### Shell & navigation
| Where | Problem | One-line fix |
|---|---|---|
| `page.tsx:336-351` | Bespoke header (`h-14`, `container px-4`, "Back to home") instead of `SiteHeader`; no sign-out, no profile, no footer. | Render `<SiteHeader/>` (+ `<Footer variant="minimal"/>`) and drop the custom bar. |
| `page.tsx:346-348` | "Draft saved on this device" is static text shown even before anything is typed; no timestamp, never changes. | Drive it off `getDraftTimestamp()` and render only after the first save. |
| `page.tsx:337,354` | `px-4` while the whole app uses `px-5`. | Change to `px-5`. |
| `page.tsx:404-421` **and** `437-447` | Two `WizardNavButtons` on screen at once (top card + sticky bottom card) → duplicate "Continue to X" buttons. | Keep only the sticky bottom nav; leave tabs + validation errors in the top card. |
| `page.tsx:413-419` vs `436` | On Review, the top nav is hidden by `hideOnLastStep` and the bottom card by `currentStep < length-1`, so no Back button exists on the final step. | Render the bottom card on the last step with Back only. |
| `page.tsx:426-432` | "Start simple" shortcut keyed to hard-coded `state.currentStep === 1`; uses `variant="outline"` for what is the recommended fast path; `disabled` with no explanation. | Key off `WIZARD_STEPS.indexOf('dates')`, make it `variant="default"`, add a hint when disabled. |
| `page.tsx:85-92` | Resume dialog: two equal `flex-1` buttons, "Start Fresh" (discards work) given equal weight and no warning; Esc/outside-click disabled (75) so the dialog can't be dismissed. | Make "Start Fresh" `variant="ghost"`, add "this deletes your saved draft", allow Esc. |
| `page.tsx:386-392` vs `IdentityStep.tsx:86` | Same slug-suggestion buttons, but page.tsx adds `className="text-xs"` overriding size `sm`'s text-sm. | Drop the `text-xs`. |
| `page.tsx:229-230` | On success the user is pushed to `/e/{slug}/admin` with **no success confirmation** — the gathering just appears. | Redirect with `?created=1` and show a success banner on the admin overview. |
| `WizardNavigation.tsx:274` | Stray indentation (`                        className="gap-2"`). | Reformat. |
| `WizardNavigation.tsx:255-281` | Two empty wrapper `<div>`s to fake `justify-between`; `gap-3` never applies. | `<div className="flex items-center justify-between gap-3">` with `ml-auto` on the Next button. |
| `WizardNavigation.tsx:276` | Button label "Continue to {next step}" makes the primary button change width every step. | Use a fixed "Continue" with the next step name as a sub-hint, or `aria-label` only. |
| `WizardNavigation.tsx:17-27` | Step "Voting" actually contains proposal window + safeguards + formats + durations. Admin settings splits these into **Participation / Voting / Safeguards** (`admin/settings/page.tsx:23-32`). | Rename/split the step to match the settings IA the organizer sees five minutes later. |
| `WizardNavigation.tsx:199` | Error box `border-destructive/50 bg-destructive/10 p-4` vs the house `/20 … p-3`. | Match the house error box. |

### BasicsStep
- `BasicsStep.tsx:165,265,345,373` — card titles are Title Case ("Event Details", "Event Type") while newer surfaces use sentence case. → Sentence case throughout.
- `BasicsStep.tsx:271-323` uses `rounded-lg border-2 p-4` + hover + focus ring; `BasicsStep.tsx:349-359` (Admission) uses `rounded-xl border-2 p-4` with **no hover and no focus ring**, and `aria-pressed` on what is a radio group. → Reuse `ChoiceCard` (SectionCard.tsx:99-107) for all three groups.
- `BasicsStep.tsx:343-368` — "Admission" + a revenue-share field sits between Event Type and Visibility. A first-time organizer meets a platform-fee input before they've described the event. → Move to its own step (or to settings), after Identity.
- `BasicsStep.tsx:361-366` — label "Contribution to unconference (%)" is product-jargon; `required` on a pre-filled field; width `max-w-32` where the rest of the wizard uses `max-w-[200px]` (VotingStep:209). → Rename to "Platform contribution", drop `required`, use `max-w-[200px]`.
- `BasicsStep.tsx:172-189` vs `209-221` — Name and Tagline have character counters, Description has neither counter nor `maxLength`. → Add both or drop both.
- `BasicsStep.tsx:246-257` — two stacked hints at `text-sm` then `text-xs` under one field. → Single `text-xs` hint (the `Field` pattern).

### DatesStep
- `DatesStep.tsx:452-459` — **the only step rendered without `Card` wrappers** (bare `h2` + `space-y-8`). The wizard visually jumps between step 1 and step 2. → Wrap in `Card`/`CardHeader`/`CardContent` like every sibling.
- `DatesStep.tsx:134-357` — a 220-line hand-rolled `TimezoneSelect`, while `src/components/ui/timezone-picker.tsx` exists and admin settings uses it (`DatesSection.tsx:32`). Two timezone UIs for one job. → Delete and use `TimezonePicker`.
- `DatesStep.tsx:294-353` — `<li role="option" onClick>` with no `onKeyDown`, no `tabIndex`, no `aria-activedescendant`. → Covered by the swap above.
- `DatesStep.tsx:466,478` — required fields (navigation is gated on them, `useWizardState.ts:278-283`) with no `*` marker, unlike BasicsStep:175. → Add the destructive `*`.
- `DatesStep.tsx:506-529` — Location Type uses a **third** selection style (`border p-4` + `ring-1 ring-primary`). → `ChoiceCard`.
- `DatesStep.tsx:535` — the conditional location block is a `border-dashed` box, a style used nowhere else for inputs. → Plain `space-y-4`.

### VenuesStep / TracksStep / ScheduleStep (the three "add items" steps disagree with each other)
- **Form footer order/alignment differs three ways:** VenuesStep:366-373 `flex gap-3` submit-then-Cancel; TracksStep:310-319 `justify-end` ghost-Cancel-then-submit; ScheduleStep:476-480 submit-then-Cancel. → Pick one (Cancel `outline` left, submit right) and apply to all, including setup:395-401 and EditSessionModal:549-555.
- **Destructive safety is inconsistent:** VenuesStep:140-162 confirms deletion inline; `TracksStep.tsx:435` deletes a track with **no confirmation at all**. → Add the same inline confirm.
- **Icon-button sizes for the same edit/delete pair:** VenuesStep:92,102 & TracksStep:227,236 `size="icon" className="h-8 w-8"`; setup:448-449 `h-9 w-9`; ManageCohosts:138 `h-7 w-7`. All override the `icon`/`icon-sm` tokens and all are under 44px. → Use `size="icon-sm"` (h-10) everywhere.
- `VenuesStep.tsx:437` and `443-450` say the same thing twice ("virtual, but you can still add venues"). → Delete the box at 443-450.
- `VenuesStep.tsx:466-476` (empty state, primary button) vs `480-485` ("Add Another Venue", full-width outline) — same action, two weights. → Same variant for both.
- `VenuesStep.tsx:284-320` — selected preset features and custom features render as visually identical pills but one is a toggle button and one is a span+X. → Give custom chips the same button affordance, or add an X to both.
- `VenuesStep.tsx:519-534` & `ScheduleStep.tsx:1158-1172` — "Tips" cards exist on 2 of 8 steps. → Either add to all or move into `CardDescription`.
- `TracksStep.tsx:484-497` — "Track Preview" duplicates the chip already rendered on every TrackCard (207-214). → Remove.
- `TracksStep.tsx:505-513` "Attendee Profile Topics" vs `ParticipationSection.tsx:102` "Suggested topics" — same field, two names. → "Suggested topics".
- `TracksStep.tsx:518-541` — the Add button is default size (h-11) next to an Input (h-10); VotingStep:604 and ParticipationSection:109 use `size="sm"` for the identical control. → `size="sm"`.
- `ScheduleStep.tsx:928-957` — Calendar/List segmented control built from bare buttons; `admin/sessions/new/page.tsx:166-179` implements the same idea as `role="tablist"` pills. → One shared segmented control.
- `ScheduleStep.tsx:960-977` — prerequisites empty state ("add a venue first") with **no link back to the Venues step**. → Add a `Button variant="link"` dispatching `SET_STEP`.
- `ScheduleStep.tsx:1063-1082` vs `1085-1096` vs `1010-1018` — the same "Add Time Slot / Bulk Generate" pair appears three times with different labels ("Add slot"/"Add Time Slot"), sizes and variants. → One `<SlotActions/>`.
- `ScheduleStep.tsx:276-279` — confirm buttons `size="sm" className="h-7 text-xs"` (28px) — below the `sm` token. → Drop the overrides.

### VotingStep
- `VotingStep.tsx:191` — a bare paragraph above the first card; no step heading at all (other steps have one). → Add a step header or move into the first `CardDescription`.
- `VotingStep.tsx:340-361, 399-416, 472-491` — the switch is re-implemented three times **in this one file**. → Import `Toggle` from the settings kit.
- `VotingStep.tsx:363-369, 418, 493` — `<Label onClick={…}>` with no `htmlFor` → label clicks work only via JS, no a11y association. `SectionCard.tsx:80-86` does this correctly. → Use `id`/`htmlFor`.
- `VotingStep.tsx:429-502` — "Safeguards" inside the Voting step, but a top-level section in settings. → Split (see nav finding above).
- `VotingStep.tsx:513-556` & `634-677` — formats/durations use hand-rolled checkboxes with inline SVG checks; `ParticipationSection.tsx:71-83` does the identical setting with the `Checkbox` primitive + `has-[:checked]` styling. → Reuse the settings version.
- `VotingStep.tsx:566-585, 687-706` — custom format/duration chips `border-2 border-primary bg-primary/5 rounded-full px-3 py-1.5`: chip style #4. → `Badge variant="default"` + an X button.
- `VotingStep.tsx:439-452` — "Approvals to move or cancel a published session" lets an organizer pick 3 with no co-organizers, silently locking themselves out. → Warn when the value exceeds the current organizer count.
- `VotingStep.tsx:444` vs `SafeguardsSection.tsx:28` — same two selects, `max-w-[200px] p-2.5` vs `max-w-[220px] p-3`. → Unify.

### BrandingStep
- `BrandingStep.tsx:362-415` — a local `ColorPicker` while `ui/color-picker` exists and `BrandingSection.tsx:80-82` uses it. → Delete the local one.
- `BrandingStep.tsx:130-134` vs `admin/.../constants.ts:21-25` — the same three theme modes labelled "System / Follow user preference" vs "Match device / Follow each visitor's device preference". → One copy source.
- `BrandingStep.tsx:36-126` — ten theme presets in the wizard, **zero in admin settings** → an organizer can never reselect a preset after creation. → Export `THEME_PRESETS` and render them in `BrandingSection`.
- `BrandingStep.tsx:692-711` — preview swatches force `text-white` on all three colors; the default secondary is `#E8F1EB` (constants.ts:27) → white on near-white. Same bug, differently, at `BrandingSection.tsx:87-89` where only Primary gets `text-white` and the other two get no text color. → Compute contrast (the helper already exists at `TracksStep.tsx:63-76`).
- `BrandingStep.tsx:244-251` — each image field stacks Label → `text-sm` description → `text-xs italic` aspect hint (three type sizes per field); `BrandingSection` ImageField:44 collapses this into one `hint`. → Collapse.
- `BrandingStep.tsx:274-296` — the remove-image button is `opacity-0 group-hover:opacity-100` with **no `focus-visible:` variant** → unreachable on touch and by keyboard. (`SettingsModal.tsx:412` gets this right.) → Add `focus-visible:opacity-100`.
- `BrandingStep.tsx:781-834` — Twitter / Telegram / Discord / Website, each with a helper line that restates its placeholder ("Enter your Telegram channel or group URL"). `BrandingSection.tsx:98-101` shows the same four in a 2-col grid with no hints. → One layout; drop the redundant hints; consider a repeatable "links" list so Signal/Matrix/Luma/Meet organizers aren't excluded.

### IdentityStep (strongest step — small notes)
- `IdentityStep.tsx:112-120` — amber box `border-amber-500/40 bg-amber-500/10`: raw Tailwind amber, one of **six different amber recipes** in the audited surfaces (`DatesSection.tsx:34`, `NetworkSection.tsx:43`, `setup:595`, `setup:689`, `AtprotoSessionActions.tsx:256`, `ReviewStep.tsx:141`). → One `<WarningBox>` on `--signal-amber`.
- `IdentityStep.tsx:142` — references `feedbackK` ("counts from at least N voters") without naming the setting the user configured two steps earlier as "Fewest voters before a count is shown". → Name it.

### ReviewStep
- `ReviewStep.tsx:254-259` — the only centered heading in the wizard, and `text-2xl font-bold` vs `font-semibold` elsewhere. → Left-align, `font-semibold`.
- `ReviewStep.tsx:265-268` — an untitled `bg-muted/30` ticketing block floats above the first `Section` card. → Fold into a Section or give it a title.
- `ReviewStep.tsx:672-697` — raw `<input type="checkbox" className="… border-gray-300 …">` for the terms gate: hard-coded gray breaks dark mode; `ui/checkbox` is used correctly 500 lines earlier in `IdentityStep.tsx:145`. → Use `Checkbox`.
- `ReviewStep.tsx:232,247` — `termsAccepted` is local state; clicking "Edit" on any section and coming back silently resets it. → Move into wizard state.
- `ReviewStep.tsx:701-709` — `size="lg"` plus `className="w-full text-lg py-6"` overrides the `lg` token into a size that exists nowhere else. → `size="lg" className="w-full"`.
- `ReviewStep.tsx:710-719` — "Please complete all required fields" doesn't say which; `ValidationSummary` above only ever renders one error (179-186) yet is titled "complete the following" with a `<ul>`. → Link the message to the offending step.
- `ReviewStep.tsx:50-84` — duplicate label maps that have drifted: `FORMAT_LABELS` has `lightning`/`keynote`/`networking` (never offered) and lacks `fireside`/`ceremony` (offered at `VotingStep.tsx:55-56`) → Review shows raw slugs for real formats. → Import `SESSION_FORMATS`/`VOTING_MECHANISMS` from the shared constants.
- `ReviewStep.tsx:363-374, 509-540` — chips as `px-2 py-0.5 rounded text-xs bg-muted`: chip style #5, and square where every other chip is `rounded-full`. → `Badge variant="muted"`.
- `ReviewStep.tsx:620-648` — social entries render as chips labelled "Twitter"/"Telegram"/… with an `ExternalLink` icon but are **not links**. → Render as `<a>` or drop the icon.

---

## 2. Session propose + edit

### `src/app/e/[slug]/propose/page.tsx`
| Where | Problem | Fix |
|---|---|---|
| `258` | Proposals-closed state: one Card, no back link, and no indication of **when** proposals open even though `proposalsOpenAt` exists on the event. | Show the opening time + a "Back to {event}" link. |
| `261-321` | Success state renders at `max-w-md` while the form is `max-w-2xl` → the page visibly narrows on submit. | Keep `max-w-2xl`. |
| `288-314` | Success offers "View Sessions" / "Propose Another" but **never links to the session just created** — despite line 285 telling the user to go to the session page for co-host invites. The API returns `id` (212) and it's discarded. | Make the primary button `Link href={/e/${slug}/sessions/${result.id}}`. |
| `287-315` vs `sessions/new:148-152` | Two success layouts for "you made a session": propose has 2 buttons, admin has 2 + a ghost "Back to overview". | One shared `<SuccessPanel/>`. |
| `327` | `h1 text-2xl font-bold` inside `.workspace-content`, which already sets `text-3xl md:text-4xl font-semibold`. Same at `settings/notifications:117`, `my-votes:73`, `my-schedule:210`, `schedule:222`. | Drop the local classes. |
| `347,361,374,397,419,448,480,524,569,594,625,674` | Field labels are bare `<label className="text-sm font-medium">` with **no `htmlFor`** (only `642` has one) → label clicks do nothing, no a11y association. | Add `htmlFor`/`id`, or use the `Field` component from the settings kit. |
| `645-653` | One field is a raw `<input className="w-full rounded-md border … py-2 text-sm">` instead of `Input` → 8px shorter than its neighbours. | Use `Input`. |
| `599-619` | Raw `<select>` styling that matches nothing else. | `ui/select` (to be created) or match `SectionCard`'s style. |
| `676-685` | Tag chip renders a literal lowercase **`x`** as the remove affordance, inside a clickable `Badge` with no `role`/`aria-label`/keyboard access. `EditSessionModal:485` uses `×`; `sessions/new:313-316` uses a real `<button aria-label>`. | One `<RemovableChip/>` with a real button. |
| `708-722` | Suggested-tag buttons `px-2 py-1 text-xs rounded border` prefixed `"+ "` (chip style #6) and they go silently `disabled` at 5 tags with no message. | Badge-based chips + "5 of 5 tags used". |
| `375,398,426,484,525` | The same card-grid pattern uses `gap-2` in four places and `gap-3` in one; durations use `flex gap-2` and wrap badly with 6+ options. | `gap-3` + `grid` everywhere. |
| `753-755` | Submit is a full-width default-size Button; the wizard's equivalent is `size="lg"`. | Pick one weight for "final submit". |
| `43-49` | `"Auditorium (100+)"` stores `value: 150` — the number doesn't match the label. | Label the actual value. |
| `52-55` | `DEFAULT_TAGS` are crypto-specific (`defi`, `nfts`, `governance`) and are shown to **every** gathering that hasn't set topics. | Drop the defaults, or make them neutral. |
| `58-67` | `TIME_OPTIONS` hard-coded 09:00–22:00 → no breakfast or late-night self-hosted session. Duplicated verbatim at `EditSessionModal.tsx:41-49`. | Extract to a shared util covering 00:00–23:30. |
| `540` | Unescaped `'` in JSX text (`event's`). | `&apos;`. |

### `src/components/EditSessionModal.tsx`
- `251-258` — **third modal implementation**: no Radix, no focus trap, no Escape handler, no scroll lock. (`SettingsModal` at least handles Escape + `body.overflow`; `create/page.tsx:75` uses Radix Dialog.) → Move all three to Radix `Dialog`.
- `260-265` vs `SettingsModal.tsx:371-376` — modal header close is a raw `<button className="p-2 rounded-full">` here, a `Button variant="ghost" size="icon"` there. → One.
- `267` `p-4 space-y-5` vs `SettingsModal.tsx:379` `p-6 space-y-6` → modal body padding/rhythm differs.
- `549-555` `flex gap-3 p-4 border-t` with two `flex-1` buttons vs `SettingsModal.tsx:662-679` `justify-between` with a status message + auto-width buttons → two modal footers.
- `313,319,325,345,373,398,428,434,445,470,481` — mixed `<label htmlFor>` and `<span className="text-sm font-medium">` as field labels in one form; **"Format" (325), "Track" (345), "Hosting" (373), "Your availability" (445), "Tags" (481) are spans, not labels.** → Use `fieldset`/`legend` for groups (as `sessions/new:227` already does).
- `397-411` vs `propose:574-586` — the same day picker at `px-2.5 py-1.5 … text-xs` here and `px-3 py-2 … text-sm` there. Same for the time selects (415-423 vs 599-619).
- `470-476` — **"Telegram Group URL"** is the only attendee-logistics channel in the product, hard-coded (also in the API body at 207 and on the profile at `SettingsModal.tsx:489-501`). An organizer on Discord/Signal/Matrix/Meet has nowhere to put a link. → Rename to "Attendee chat or meeting link" with a free URL + optional label.
- `528-541` — the two organizer selects are labelled `text-xs font-medium text-muted-foreground` while every other label in the modal is `text-sm font-medium` → the organizer block reads as de-emphasised.
- `516-546` — the organizer block uses `border-primary/20 bg-primary/5`, which in this codebase means *selected*. → Use `bg-muted/40` or a `Badge`-headed section.
- `551-554` — manual `<Loader2 className="mr-2 animate-spin"/>` instead of `loading` (same at `sessions/new:330`, `SettingsModal:675`, `NetworkSection:50`, `DangerZone:39`, `SectionCard:49`, `LifecycleSection:56`).
- `300-305` — "Send request" success is a `text-xs` "Sent." that never clears and has no `aria-live` beyond `role="status"` on the span. → Persist a proper success state; reset when the textarea changes (it already does at 294).
- `484-486` — clickable `Badge` with no `role="button"`/`tabIndex`/keyboard handler.

### `src/app/e/[slug]/admin/sessions/new/page.tsx`
- `134-136` — no-permission state is a bare centered muted line with no heading and no back link; `admin/settings/page.tsx:45` does the same state with a heading + "Return to the gathering" button. → Reuse that pattern.
- `166-179` — `role="tablist"` with no `role="tabpanel"` and no `aria-controls` on the panels.
- `138-156` (full-page success takeover) vs `191-199` (green inline banner) — two success patterns on one page depending on mode.
- `212-225` use `<label htmlFor>`; `227,239,250,295` use `fieldset/legend` — two labelling systems in one form.
- `313-316` — tag remove is a bare `×` `<button>` with no padding → ~10px hit area.
- `327-333` — footer is Cancel-link + submit, both `flex-1`; propose's is full-width; EditSessionModal's is two `flex-1`. Third variant.
- `38-39` — a third hard-coded copy of fallback formats/durations (after `propose:28-41` and `EditSessionModal:20-26`). → One shared constant (the admin settings `constants.ts` already has `SESSION_FORMATS`/`SESSION_DURATIONS`).
- `184-189` and `222-225` — the "listed as" privacy rule is explained twice, in a banner and in a hint.
- `268-291` — the only nested panel in the form (`p-4 border rounded-lg bg-muted/50`), appearing/disappearing on a radio choice above it → layout jump with no transition.

---

## 3. Settings

### `src/components/SettingsModal.tsx` (account)
- `372` — title is **"Edit Profile"** but this is the app's only account surface: it also holds ATProto identity, "take ownership", publish-to-repo, and ENS. Meanwhile there is **no email, password, notification, or delete-account control anywhere**. → Retitle "Account", add tabs (Profile / Identity / Notifications) or link out.
- `359-368` — clicking the overlay closes the modal and discards unsaved edits with no confirmation.
- `379` vs `582` vs `771` — one `p-6 space-y-6` body, but the ATProto block gets `pt-4 border-t` and the ENS block gets no divider at all → inconsistent section separation inside one modal.
- `599-614, 625-634, 837-851` — **three raw `<input type="checkbox" className="h-4 w-4">`** in a shadcn app that has `ui/checkbox` (used correctly at `propose:461`).
- `583` — `<label className="text-sm font-medium">` with no `htmlFor` wrapping a non-input block (the identity card).
- `653-655, 665, 854` — `text-green-500` hard-coded for success (also `propose:269`, `sessions/new:143,193-196`, `ManageCohosts:167`, `RSVPButton:163,224`). → `text-success` / `Badge variant="success"`.
- `674` — primary Save carries `btn-primary-glow`, **a class that does not exist** anywhere in the CSS (also `OnboardingModal.tsx:513`, `schedule/page.tsx:266`). → Delete or define.
- `313` — `setTimeout(() => onClose(), 1000)` after save: the "Saved!" confirmation is destroyed by the auto-close, and the modal moves without the user asking. → Keep it open with a persistent saved state, or close immediately with a toast.
- `419-424` — "Remove" photo is a bare underlined `<button className="text-xs underline">` next to a hint, not a Button.
- `529-531` — `Button size="icon"` (h-11) beside an `Input` (h-10); the suggestion popover then needs `right-12` (537) to line up. → `size="icon-sm"`.
- `616-644` — "Take ownership" is irreversible and destroys the app's ability to publish for you, yet its button is the **smallest, lowest-contrast** control in the modal (`size="sm" variant="outline"`). → `variant="destructive"` or at least default size, in a bordered warning block.
- `776-779` — `Badge className="text-[10px]"` undercuts the badge token's `text-xs`.
- `487-501` — "Telegram" is the only contact field on a profile. Same opinionated-label issue as `EditSessionModal:470`.

### `src/app/e/[slug]/settings/**` (participant)
- **The only page under `/settings` is `notifications`** — there is no `/e/[slug]/settings` index, so that URL 404s, and the only route in is the NotificationBell dropdown (`NotificationBell.tsx:217`). Nothing in `DashboardLayout` links to it. → Add a settings index (or surface it from the profile menu at `DashboardLayout.tsx:219-236`).
- `notifications/page.tsx:109-115` — a `ghost sm` "Back" button next to the h1; no other workspace page has one (`WorkspaceHeader` provides the breadcrumb). → Remove or make it universal.
- `notifications/page.tsx:117` + `122-126` — h1 "Notification Settings" immediately followed by a card titled "Notification Preferences" → the same words twice, and `text-2xl font-bold` fights the global `h1` rule.
- `notifications/page.tsx:20-56` — a 4th toggle implementation (white knob, `h-4 w-4`, `translate-x-6`) visibly different from `SectionCard.tsx:78-89`.
- `notifications/page.tsx:89` — the Push toggle is permanently `disabled` with the reason only in the `aria-label`; the visible explanation is 75 lines below at `163-166`. → Put "coming soon" in the column header at 146-149.
- `notifications/page.tsx:135-151` — column headers hand-aligned with `w-11` spacers and `gap-6`; on mobile `flex-1 mr-4` collapses and three toggles overflow the row. → Grid with named columns, or stack on mobile.
- No global "mute all", and no save confirmation beyond a spinner inside the toggle.

### `src/app/e/[slug]/admin/settings/**` (organizer)
**The section kit is the best pattern in the repo — the issues are mostly in how the page uses it.**
- `page.tsx:23-32` — section order is Lifecycle → Network identity → Basics → Dates → … A first-time organizer meets "Lifecycle" and "Network identity" before "Basics". → Basics/Dates/Participation first; Lifecycle and Network identity after.
- `page.tsx:56-61` — anchor pills `rounded-full border bg-card px-3 py-1.5` (chip style #7) as plain `<a href="#">` with **no active/scroll-spy state** — you can't tell where you are on an 8-section page.
- `page.tsx:59` — the Danger zone anchor is appended to the same pill row in destructive colors → mixes navigation with severity.
- `page.tsx:51` — `h1 text-4xl font-semibold` duplicating the global `.workspace-content h1` rule, and `50` adds an eyebrow ("Your gathering, your rhythm") used on no other page.
- `page.tsx:45` — the access-denied Card is rendered outside the `max-w-4xl` wrapper → full-bleed card.
- `SectionCard.tsx:28` — `aria-labelledby={`${id}-title`}` but **no element carries that id** → a broken ARIA reference on all 8 sections. → Put `id={`${id}-title`}` on the `CardTitle` at 24.
- `SectionCard.tsx:24` — `CardTitle className="text-xl"`; elsewhere `text-lg` (VenuesStep:492, ScheduleStep:1104) or unset → three CardTitle sizes.
- `SectionCard.tsx:26` — the footer sets `py-4` on top of `CardFooter`'s `p-4 sm:p-6 pt-0`, so vertical padding is re-added asymmetrically and the footer content can crowd the divider on mobile. → `className="border-t bg-secondary/40 p-4 sm:px-6"`.
- `SectionCard.tsx:41,47` — the default `idleHint` "Changes apply when you save." renders in **all 8 footers simultaneously**. → Show it only after the section becomes dirty.
- `LifecycleSection.tsx:35` — the only section with no `footer`, so it duplicates `SaveBar`'s feedback markup inline at `40-43`.
- `LifecycleSection.tsx:52` and `58-60` — `getTransitionLabel(status, next)` is printed as the row title **and** as the button label → the same sentence twice per row.
- `LifecycleSection.tsx:56,58` — the button for a given transition is `outline` before confirming and `destructive` while confirming (for archive) → the control changes variant mid-interaction.
- `NetworkSection.tsx:69-71` — three buttons in one `gap-2` row, `outline`/`outline`/`ghost`, one of which navigates to an entirely different page ("Network page") → no hierarchy, and `gap-2` where the page uses `gap-3`.
- `NetworkSection.tsx:50` — a default-size (h-11) Retry button inside a `text-sm` alert → oversized relative to its container.
- `DangerZone.tsx:36-37` — "Type `{slug}` to confirm" **and the same slug as the input's `placeholder`** → the placeholder makes the safety check copy-pasteable. → Remove the placeholder.
- `DangerZone.tsx:40-42` — the two "can't delete" messages differ only subtly and both tell you to archive; the first branch's premise (published) overlaps the second's. → Single message.
- `ParticipationSection.tsx:84-85` — custom durations are `<span>`s with a border while presets are `<label>`+`Checkbox` in the same wrapping row → two visual languages in one control.
- `ParticipationSection.tsx:96` and `VotingStep.tsx:377` — `pl-14` magic indent to align under a toggle. → Wrap in a `ml-14` container tied to the toggle width.
- `VotingSection.tsx:26` — "Changing this only affects members who join afterwards" is a consequential warning hidden in a `text-xs` hint. → Amber inline notice when the value changes (the pattern already exists at `DatesSection.tsx:34-37`).
- `SafeguardsSection.tsx:28,34` — selects `max-w-[220px] p-3` vs the wizard's `max-w-[200px] p-2.5` for the same two settings.
- `BrandingSection.tsx:59` — a **second** `useSectionSave` in one card; its feedback renders at `106-108`, far from the `SaveBar` at `78` → two save indicators with two different behaviours (images save instantly, colors need Save) explained only by a `hint` at 104. → Move image saves behind the same SaveBar, or visually separate them into their own SectionCard.
- `BrandingSection.tsx:87-89` — Secondary and Accent preview chips have a background but **no text color set** → unreadable on dark swatches.

### `src/app/e/[slug]/admin/setup/**`
- `315-316` — `<h1 className="font-semibold">` with no size (relies on the global rule) while every other admin page hard-codes `text-2xl font-display font-bold` (`admin/page.tsx:267`, `tracks:170`, `members:265`, `tickets:421`) → the admin area has no single page-title style.
- `311-312` — page-level error/status banners render **above** the h1 → feedback appears before the page title; success auto-dismisses after 5s (115-119) while errors never clear.
- `319-326` — an info card that mostly restates the `h2` directly below it (329).
- `328-342` — "Add room" (default h-11) + "Generate slots" (outline) with a responsive label swap "Generate slots"/"Slots" (336-338) — abbreviation pattern used nowhere else.
- `440-452` — action row: the primary disclosure ("Availability") is a full-width **ghost** button while destructive delete is a bare icon; both icon buttons override the token with `h-9 w-9`.
- `395-401` — form footer `justify-end`, Cancel then Create → a third footer alignment; and Create uses a `Check` icon (398) while the slot form's Add uses `Plus` (733) for the same verb.
- `299` (`text-sm font-medium`) vs `696,711,719,725` (`text-xs font-medium`) — two label scales on one page.
- `681` — `selectClass` is `min-h-[44px]` while `Input` is `h-10`, so `712,716,726` bolt `min-h-[44px]` onto the Inputs to compensate → a local patch instead of a control-height token.
- `595` — break slots use `bg-amber-50 dark:bg-amber-950/20 border-amber-200`; `689-691` uses a different amber recipe in the same component.
- `730-736` — SlotForm footer is Cancel-then-submit `flex gap-2`; the venue form 300 lines above is `justify-end gap-2`.
- `583` — day filters use real `Button size="sm"` with `default`/`outline` (good) while `propose:574` and `EditSessionModal:401` hand-roll the same picker. → Extract `<DayPicker/>`.
- `477-486` — good empty state for "no rooms", but **no empty state for "rooms exist, no slots anywhere"** beyond a per-day line at 589, and no next-step link at the bottom of the page (the only link to the Schedule builder is buried in the intro card at 322-324).
- Only one inbound link exists to this page in the whole app (`admin/schedule/page.tsx:704`) — it's not in the admin nav.

### `src/app/account/**`
- The directory contains **only `reveal/page.tsx`** — "Account settings" as a destination does not exist; `/account` 404s. Given `SiteHeader` has no profile menu either (see below), a signed-in user outside an event has no way to reach any settings.
- `reveal/page.tsx:46-47` — the only page in the app rendered with **no `SiteHeader` and no `Footer`**; the only way out is a `text-xs` link at 100.
- `reveal/page.tsx:49-51` — `<h1 className="text-2xl font-semibold">` inside `CardHeader` instead of `CardTitle` → bypasses card typography.
- `reveal/page.tsx:81-84` — the copy button is icon-only with **no `aria-label`**, and its only feedback is an icon swap with no `aria-live` → a one-shot, unrecoverable action with no accessible confirmation.
- `reveal/page.tsx:86-94` — a 4-item ordered list including `com.atproto.sync.getRepo` in raw code font, on a member-facing page.
- `reveal/page.tsx:98` — the error state has no retry and no "request a new link" path → a hard dead end on a single-use token.

---

## 4. Shared shells

### `SiteHeader.tsx`
- `24` vs `29` — the same "Create event" CTA renders with a `Plus` icon when signed in and without one when signed out.
- `23` — the loading skeleton is `h-10 w-20`, narrower than what it replaces (button + name + icon) → layout shift on auth resolution.
- No profile/settings entry point at all → outside a workspace there is no route to `SettingsModal`.
- `26` uses `aria-label="Sign out"` while `DashboardLayout.tsx:239,338` use only `title="Sign out"` for the identical control.

### `WorkspaceHeader.tsx`
- `10` — `hidden md:flex`: on mobile the workspace has **no page context at all**; the label computed at `DashboardLayout.tsx:362` is discarded.
- `14` "Event page" vs `admin/settings/page.tsx:54` "View event" vs `EventUtilityLayout.tsx:11` "Back to {event.name}" → three labels for one destination.

### `DashboardLayout.tsx`
- `362` — the header label is a chain of `pathname.endsWith(...)` ternaries; any route not in `navItems` falls back to "Your gathering" (e.g. `/tickets`, `/admin/*`). → Map routes to labels once.
- `38` "Your gathering" as the dashboard nav label **and** as the fallback label at 362 → ambiguous.
- `41-42` "My Schedule"/"My Votes" Title Case beside "Sessions"/"Schedule"/"People" in one nav.
- `184-193` vs `301-307` — "Propose a session" is a `Button size="sm"` (h-10) inside a list of `min-h-11` nav links on desktop, and a plain `text-primary` Link on mobile that carries **both `text-sm` and `text-xs`** (303). Same conflicting-class bug on the mobile Admin link (311).
- `195-210` — the desktop Admin link re-implements the active state that `globals.css:136` already provides for `.workspace-nav-link`; the mobile one (308-316) has no active state at all.
- `219-236` — the avatar button opens "Edit Profile"; there is no menu, so notification settings, the event page, and sign-out are three separate controls with no grouping.
- `138` + `358` — sidebar width `w-[240px] lg:w-[260px]` duplicated as `md:ml-[240px] lg:ml-[260px]` in the main element → a layout constant maintained in two places.

### `Footer.tsx`
- `81-88` computes `branding.name`, `branding.logoUrl` and `branding.tagline` — and **none of them are rendered**. `95` prints the literal "Powered by unconference" and `96` prints a hard-coded tagline. → A branded event page ends with only the platform's name; either use `branding` or delete the dead fields.
- `52` — the Telegram link uses lucide's generic `Send` paper-plane while X and Discord get real brand glyphs (10-20) → mismatched icon fidelity in one row.
- `98-103` — footer links at `text-xs` with `gap-5`, while all other nav is `text-sm` → smallest text in the app on legal links.
- `42-46` — `PLATFORM_BRANDING` has a stray blank line and no `social`, so `SocialIcons` always returns null on non-event pages.

### `SessionCard.tsx`
- `74` — `p-3.5 sm:p-5`, a bespoke padding against the primitive's `p-4 sm:p-6`; `75` adds a unique `space-y-2.5 sm:space-y-3` rhythm.
- `78-83` vs `87` — `text-[11px] tracking-wider` and `text-xs` side by side in the same meta row.
- `136-145` — topic tags `rounded-sm border bg-surface-2 px-2 py-0.5 text-xs` — **chip style #7, and the only square chip in the app**. → `Badge variant="muted"`.
- `98-113` — the favorite button is a raw `<button className="p-2 rounded-md">` (not a `Button`), and renders only when logged in with **no signed-out affordance** → the heart silently doesn't exist for visitors.
- `163-178` — the footer/divider renders only when capacity info or voting exists → cards in one list have ragged bottoms; `165-173` is a `flex gap-3` wrapper around a single optional child (often empty).
- `116-121` + `128-132` — two separate `<Link>`s to the same href (title and description) → duplicate targets for keyboard/screen-reader users.
- `60` vs `88-91` — untracked sessions get `hsl(var(--signal))` as the top accent (implying a track) while the track dot is correctly hidden.

### `RSVPButton.tsx`
- `33-35` — re-declares narrowed `variant`/`size` unions instead of reusing `ButtonProps` → callers can't pass `secondary`/`icon-sm`.
- `162-165` — `bg-green-600` / `bg-amber-500` hard-coded over the variant → the only button in the app with brand-foreign colors; `success` and `amber` tokens exist.
- `108-151` — loading replaces the label with "Loading..." instead of using the `loading` prop → the button width jumps on every click.
- `170` — error as centered `text-xs` under the button, while every other form error is a bordered box.
- `172-193` + `217-228` — `text-amber-500`, `text-red-500`, `text-green-600` hard-coded across both exports.
- `224,227` — "(Going)" / "(Waitlist)" as parenthesised inline text where `Badge variant="success"|"amber"` is the house pattern.
- `145-150` vs `118-124` — the CTA is a bare verb ("RSVP") while the confirmed state is a sentence ("You're going").

### `VoteControl.tsx` (strongest shared component; minor)
- `114` — the label's `ml-1.5` is conditional on state, so spacing shifts between "Approve" and "Approved".
- `148,175,85` — magic widths `min-w-[2.5rem]` / `min-w-[3.5rem]` / `max-w-[14rem]` / `max-w-[18rem]` / `max-w-[16rem]` (five values).
- `116-120` — the "no approvals left" reason renders only when `voting.canVote`; in compact card context a disabled button can appear with no adjacent reason.

### `ManageCohostsSection.tsx`
- `90,115` — `<Card className="p-6">` puts padding on the Card instead of a `CardContent` → diverges from the primitive (`p-4 sm:p-6`) and from every other card; `91,116` use `<h3>` instead of `CardTitle`.
- `136-147` — remove button `size="icon" className="h-7 w-7"` = **28px, the smallest touch target in the app**.
- `96-107` (destructive "Step down") and `188-191` (primary "Create Invite Link") are rendered with **identical** `variant="outline" className="w-full justify-start"` → the section's primary and its destructive action look the same.
- `153` — empty state is one muted line with no explanation of what a co-host is; the explanation only exists on the invite branch (117).
- `140-143` and `173-176` — removing a co-host and revoking an invite both happen with **no confirmation**, while the wizard confirms deleting a venue.
- `82-86` — copy feedback is a 2s icon swap with no `aria-live`.
- `163` — invite rows show only "Expires {date}" — no preview of the link, no created-at, no "who has it".
- `116` "Co-Hosts" vs `EditSessionModal:741` "Co-hosts" vs `91` "Co-Host" → three casings of one word.

### `AtprotoSessionActions.tsx`
- `128-133` — the `button()` helper defaults everything to `outline`/`sm` and takes the variant as a 4th positional arg, so at `186-209` "Update my proposal", "Withdraw my proposal", "Confirm I co-host this" and "Endorse publicly" all land in one wrapping `gap-2` row distinguished only by outline-vs-ghost → no hierarchy between a publish and a withdraw.
- `136` — `<Card className="space-y-4 p-4">`: padding on the Card again, and no `sm:p-6`.
- `139` — the section title is `text-sm font-semibold`, the same size as body copy.
- `144,157,171` — `<dt className="text-xs uppercase tracking-wide">`: an uppercase micro-label style used nowhere else in these surfaces.
- `232` — prints the raw enum: users see **"Your RSVP is public (notgoing)."** → map to "Not going".
- `238-246` — a raw `h-9` `<select>` next to a `size="sm"` Button (h-10) → 4px mismatch in one row.
- `256-267` — a 6th amber recipe (`border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40`).
- `177,180` — two different "you can't act" messages, both plain `text-xs text-muted-foreground` with no icon → easy to miss.
- `124` — returns `null` when ATProto isn't configured → the whole card vanishes with no explanation on a page that otherwise references network publishing.

---

## 5. Dead / orphaned code found along the way

- `src/app/create/components/TemplateSelector.tsx` (282 lines) + `src/app/create/components/index.ts` — exported but **imported nowhere**; `EVENT_TEMPLATES` is never rendered, so the wizard has no template step despite the code existing.
- `TemplateSelector.tsx:91-93` — an empty `useEffect` with only a comment; `index`/`totalItems` props (50-51) are accepted and unused.
- `Footer.tsx:35-40,81-88` — `FooterBranding.name` / `logoUrl` / `tagline` computed, never rendered.
- `btn-primary-glow` — undefined class, 3 usages (see §0).
- `create/page.tsx:114` — `currentStepName` destructured and unused; `156-165` — `handleNext`/`handlePrev` are empty callbacks threaded through four components.
