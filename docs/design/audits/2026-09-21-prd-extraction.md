## Source files

- PRD: `.claude/schelling_point_PRD.md` (2301 lines, v3.0) — read in full
- `docs/brainstorms/design_doc_01.md` (564 lines) — read in full
- `docs/MULTI_TENANT_EVOLUTION_STRATEGY.md` (1531 lines) — skimmed

Structural note up front, because it matters for item 1: **the PRD contains no pseudocode, no formula, and no step-by-step specification for the scheduling/clustering algorithm.** Everything it says about clustering and matching lives in (a) §2.2's three-bullet "Algorithm Input" list and (b) the ASCII UI mockups of §4.7. Sections 5.1–5.5 (Technical Architecture) cover system diagram, data flows, DB schema, API routes and the Solidity treasury — the only algorithm trace is the API route `POST /:slug/schedule/generate  # Run algorithm` (line 2005). The one numeric scoring scheme that exists anywhere in these docs is in MULTI_TENANT §9.2, not the PRD.

---

# 1. Auto-scheduling / cluster matching (exhaustive)

### PRD §2.2 "Pre-Event Voting (Schedule Influence)" — lines 67–88

Purpose statement, line 69, verbatim:
> **Purpose:** Signal demand to inform scheduling algorithm

The complete definition of what the algorithm consumes, lines 83–87, verbatim:
> **Algorithm Input:**
>
> - Sessions ranked by total quadratic votes  
> - Voter overlap matrix (which sessions share voters)  
> - Demand distribution across formats/durations

Also relevant as a scheduling-gate parameter, from the parameter table at lines 71–77, verbatim row:
> | Minimum to schedule | None (admin discretion) | Yes |

and line 75:
> | Vote visibility | Hidden until deadline | Yes |

Resolved in §8 (line 2297), verbatim:
> | Minimum votes to schedule? | ✅ Admin discretion, soft recommendation |

### PRD §3.3 / §3.4 — lines 198, 216–217

Only admins may "Run scheduling algorithm" (line 198); permission matrix rows "Run scheduler | — | — | ✓" and "Adjust schedule | — | — | ✓" (lines 216–217).

### PRD §4.4 Merger vote transfer — lines 830–836 (affects the demand numbers fed to scheduling)

Verbatim, lines 830–836:
> **Vote Transfer Logic:** When merger executes:
>
> ```
> new_session_votes = (original_A_votes + original_B_votes) × 1.1
> ```
>
> The 10% bonus incentivizes collaboration.

Also line 780 (confirmation copy): `"Votes from both sessions will combine (with 10% bonus)."` and line 788: `- Votes from both sessions transfer to new session × 1.1`.

### PRD §4.7 "Journey: Admin Schedule Generation" — lines 1058–1285

This is the core section. Header, lines 1058–1060, verbatim:
> ### 4.7 Journey: Admin Schedule Generation
>
> **Actors:** Admin **Precondition:** Pre-voting closed, sessions approved **Goal:** Generate optimal schedule using algorithm

**Step 2 — Review Pre-Vote Results (lines 1069–1095).** The demand table columns are `Rank │ Session │ Votes │ Voters │ Fmt` — i.e. total votes, unique voter count, and format are the surfaced per-session demand metrics. Worked example rows, lines 1085–1091, verbatim:
> ```
> │  1    │ Building DAOs That Actually Work     │ 127   │ 68     │ 🎤  │
> │  2    │ ZK Proofs Workshop                   │ 98    │ 42     │ 🛠   │
> │  3    │ The Future of L2s                    │ 89    │ 51     │ 🎤  │
> │  4    │ Regenerative Finance Panel           │ 84    │ 47     │ 👥  │
> │  5    │ MEV Deep Dive                        │ 76    │ 38     │ 🎤  │
> │  ...  │ ...                                  │ ...   │ ...    │ ... │
> │  24   │ NFT Art Showcase                     │ 12    │ 9      │ 🖥   │
> ```
> (context: `Status: Pre-voting closed ✓  |  Sessions approved: 24  |  Participants: 156   |  Schedule: Not generated`, lines 1076–1077)

**Step 3 — Review Audience Clusters (lines 1097–1126).** This is the only place the overlap semantics and thresholds are defined. Verbatim, lines 1100–1126:
> ```
> ┌────────────────────────────────────────────────────────────────────┐
> │  AUDIENCE CLUSTERS                                                 │
> │  Sessions that share voters (should NOT overlap in schedule)       │
> ├────────────────────────────────────────────────────────────────────┤
> │                                                                    │
> │  ⚠️ HIGH OVERLAP (>60% shared voters)                              │
> │                                                                    │
> │  ┌─────────────────────────────────────────────────────────────┐   │
> │  │  "Building DAOs" ←── 73% overlap ──→ "Governance Patterns"  │   │
> │  │  These sessions must be in different time slots             │   │
> │  └─────────────────────────────────────────────────────────────┘   │
> │                                                                    │
> │  ┌─────────────────────────────────────────────────────────────┐   │
> │  │  "ZK Workshop" ←── 65% overlap ──→ "Cryptography 101"       │   │
> │  │  These sessions must be in different time slots             │   │
> │  └─────────────────────────────────────────────────────────────┘   │
> │                                                                    │
> │  ✓ GOOD PARALLEL OPTIONS (<20% overlap)                            │
> │                                                                    │
> │  ┌─────────────────────────────────────────────────────────────┐   │
> │  │  "DAO Governance" ←── 12% ──→ "NFT Art" ←── 8% ──→ "DeFi"   │   │
> │  │  These can safely run at the same time                      │   │
> │  └─────────────────────────────────────────────────────────────┘   │
> │                                                                    │
> │  [View Full Cluster Analysis]                                      │
> │                                                                    │
> └────────────────────────────────────────────────────────────────────┘
> ```

Faithful summary of what that fixes: overlap is a **pairwise percentage of shared voters** between two sessions; ≥/>60% is a hard "must be in different time slots" constraint (labelled HIGH OVERLAP, warning icon); <20% is the "safe to run in parallel" band (labelled GOOD PARALLEL OPTIONS, check icon); the band in between is unlabelled/unspecified. Note the PRD never defines the denominator of the percentage (e.g. whether it is intersection/union, or intersection over the smaller voter set), never defines a threshold for merge-suggestion vs. scheduling, and calls the cluster view "AUDIENCE CLUSTERS" while the displayed structure is a pairwise graph, not partitioned clusters. There is a `[View Full Cluster Analysis]` affordance with no further spec.

**Step 4 — Configure Constraints (lines 1128–1166).** Three constraint families. Venues, verbatim lines 1135–1143:
> ```
> │  Venues:                                                           │
> │  ┌──────────────────────────────────────────────────────────────┐  │
> │  │  Main Hall       │ 150 cap │ Projector, Audio │ All formats  │  │
> │  │  Workshop Room A │ 40 cap  │ Whiteboard       │ Workshops    │  │
> │  │  Workshop Room B │ 30 cap  │ Whiteboard       │ Workshops    │  │
> │  │  Breakout 1      │ 25 cap  │ Basic AV         │ Discussions  │  │
> │  │  Breakout 2      │ 20 cap  │ Basic AV         │ Discussions  │  │
> │  └──────────────────────────────────────────────────────────────┘  │
> │  [Edit Venues]                                                     │
> ```
i.e. each venue carries capacity, feature list, and an allowed-format restriction ("All formats" / "Workshops" / "Discussions").

Time slots, verbatim lines 1145–1156:
> ```
> │  Time Slots:                                                       │
> │  ┌──────────────────────────────────────────────────────────────┐  │
> │  │  9:00 - 9:30    │ Opening / Keynote (locked)                 │  │
> │  │  9:45 - 10:45   │ Session Block 1 (60 min)                   │  │
> │  │  11:00 - 12:00  │ Session Block 2 (60 min)                   │  │
> │  │  12:00 - 1:00   │ Lunch (locked)                             │  │
> │  │  1:00 - 2:30    │ Session Block 3 (90 min)                   │  │
> │  │  2:45 - 3:45    │ Session Block 4 (60 min)                   │  │
> │  │  4:00 - 5:00    │ Session Block 5 (60 min)                   │  │
> │  │  5:15 - 6:15    │ Closing / Social (locked)                  │  │
> │  └──────────────────────────────────────────────────────────────┘  │
> ```
Slots are typed by duration (60/90 min blocks) and can be `locked`. Sessions have `duration_minutes IN (30, 60, 90)` (line 1695), so slot-duration matching is implied but never stated as a rule.

Manual constraints, verbatim lines 1158–1164 — the three supported constraint kinds are session→venue pinning, session→slot+venue locking, and host unavailability windows:
> ```
> │  Manual Constraints:                                               │
> │  ┌──────────────────────────────────────────────────────────────┐  │
> │  │  + "ZK Workshop" MUST be in Workshop Room A (needs setup)    │  │
> │  │  + "Keynote" LOCKED to 9:00 AM Main Hall                     │  │
> │  │  + Alice (host) unavailable 1:00-2:30 PM                     │  │
> │  │  [+ Add Constraint]                                          │  │
> │  └──────────────────────────────────────────────────────────────┘  │
> ```

**Step 5 — Run Algorithm (lines 1168–1204).** The objective function, stated as four bullets, verbatim lines 1175–1179:
> ```
> │  Algorithm will optimize for:                                      │
> │  ✓ Minimize audience conflicts (cluster separation)                │
> │  ✓ Match venue capacity to session demand                          │
> │  ✓ Respect all manual constraints                                  │
> │  ✓ Balance high-demand sessions across time slots                  │
> ```
No weights, no ordering, no tie-breaks are given. Runtime expectation, line 1185: `Estimated time: 15-30 seconds`.

The five execution stages exposed in the progress UI, verbatim lines 1198–1202 (this is the closest thing to algorithm steps in the PRD):
> ```
> │  ✓ Analyzing voter clusters                                        │
> │  ✓ Calculating venue requirements                                  │
> │  → Optimizing time slot assignments                                │
> │  ○ Resolving conflicts                                             │
> │  ○ Final validation                                                │
> ```

**Step 6 — Review Generated Schedule (lines 1206–1247).** Output is scored. Verbatim lines 1213–1214:
> ```
> │  Quality Score: 87/100                                                             │
> │  ✓ No high-overlap conflicts  ✓ All constraints met  ⚠️ 2 warnings                │
> ```
The quality-score formula is never defined; the three checked criteria mirror the objective bullets.

The worked example grid (lines 1218–1236) is the canonical popularity→room-size demonstration. Verbatim:
> ```
> │            │ Main Hall (150)  │ Workshop A (40)  │ Breakout 1 (25)  │ Breakout 2   │
> │  ──────────┼──────────────────┼──────────────────┼──────────────────┼──────────────│
> │  9:00 AM   │ 🔒 Opening       │                  │                  │              │
> │  ──────────┼──────────────────┼──────────────────┼──────────────────┼──────────────│
> │  9:45 AM   │ DAO Governance   │ ZK Workshop      │ Community DAOs   │ DeFi Basics  │
> │  (60 min)  │ 127 votes        │ 98 votes         │ 45 votes         │ 38 votes     │
> │            │ ████████████     │ █████████        │ ████             │ ███          │
> │  ──────────┼──────────────────┼──────────────────┼──────────────────┼──────────────│
> │  11:00 AM  │ Future of L2s    │ MEV Workshop     │ NFT Art          │ Regen Panel  │
> │  (60 min)  │ 89 votes         │ 52 votes         │ 12 votes         │ 84 votes     │
> │            │ ████████         │ █████            │ █                │ ████████     │
> │  ──────────┼──────────────────┼──────────────────┼──────────────────┼──────────────│
> │  12:00 PM  │ 🔒 LUNCH         │ 🔒 LUNCH         │ 🔒 LUNCH         │ 🔒 LUNCH     │
> │  ──────────┼──────────────────┼──────────────────┼──────────────────┼──────────────│
> │  1:00 PM   │ Privacy Panel    │ Smart Contract   │ DAO Legal        │              │
> │  (90 min)  │ 67 votes         │ Security (90min) │ 34 votes         │ [EMPTY]      │
> │            │ ██████           │ 71 votes         │ ███              │              │
> ```
Read off: within each time row, vote rank is monotonically mapped onto venue capacity rank (127→150-cap Main Hall, 98→40-cap Workshop A, 45→25-cap, 38→20-cap), venues are columns ordered by descending capacity, locked slots block the entire row, and 90-min sessions occupy the 90-min row. Empty cells are permitted.

The two warnings define the post-hoc validation checks, verbatim lines 1240–1243:
> ```
> │  Warnings:                                                                         │
> │  ⚠️ "Regen Panel" (84 votes) assigned to Breakout 2 (20 cap) - may exceed          │
> │     Consider moving to Main Hall in 11:00 slot                                     │
> │  ⚠️ 4:00 PM Breakout 2 is empty - consider combining rooms                         │
> ```
So: a capacity-vs-votes mismatch warning (note the algorithm itself produced this violation in the example — 84 votes into a 20-cap room — so capacity matching is a soft objective, not a hard constraint) and an empty-room warning. No stated conversion factor from votes to expected attendance.

**Step 7 — Manual Adjustments (lines 1249–1256), verbatim:**
> ```
> Admin can drag-drop sessions between slots/venues
>
> On drag:
> - System validates constraints in real-time
> - Shows warning if creating conflict
> - Recalculates quality score
> ```

**Step 8 — Publish (lines 1258–1285).** Publishing notifies all participants (optional push+email vs. quiet publish, lines 1272–1274) and hosts of their time slots; `Schedule locked (but can be edited with re-publish)` (line 1281).

### PRD §5.3 schema support for scheduling — lines 1711–1713, 1776–1795

`sessions.venue_id` / `sessions.time_slot_id` populated when scheduled (1711–1713). `venues(name, capacity, features JSONB)` — **no allowed-format column despite the §4.7 UI showing one, and no address/geo** (1776–1784). `time_slots(start_time, end_time, slot_type IN ('session','break','locked'), label)` (1786–1795). Pre-vote aggregation view `session_pre_vote_stats` exposes `total_votes`, `unique_voters`, `total_credits`, excluding `declined`/`merged` sessions (1912–1923) — this is the demand feed. **There is no table, view, or column anywhere in §5.3 for voter-overlap/cluster data, no schedule-run/quality-score persistence, and no constraints table.**

### PRD §7 — line 2269

> | 9-10 | Scheduling | Algorithm, admin interface, publishing |

### MULTI_TENANT §9.2 "Smart Scheduling Algorithm" — lines 766–777 (the only scored algorithm spec in the repo; note it is *not* voter-overlap based)

Verbatim:
> An API endpoint `/api/e/{slug}/admin/auto-schedule` that:
>
> 1. Takes all approved sessions sorted by vote count (descending)
> 2. For each session, finds the best available slot by scoring:
>    - **Time preference match** (+10 points if host's preferred time)
>    - **Capacity fit** (+5 if venue capacity ≥ estimated attendance based on votes)
>    - **Track spread** (+3 if no other session from same track in same time row)
>    - **Duration match** (+8 if session duration matches slot duration)
> 3. Admin previews the proposed schedule before confirming
> 4. Allows manual adjustments after auto-scheduling

Related, MULTI_TENANT §9.1 lines 757–764 — conflict prevention is a DB uniqueness constraint:
> ```sql
> -- Add constraint to prevent double-booking
> CREATE UNIQUE INDEX idx_unique_session_per_slot
>   ON sessions (time_slot_id)
>   WHERE time_slot_id IS NOT NULL AND status = 'scheduled';
> ```

MULTI_TENANT §7.3 lines 680–685, the same four criteria restated for the "Auto-Schedule" button:
> - "Auto-Schedule" button: algorithmically assign approved sessions to slots based on:
>   - Vote count → venue capacity matching
>   - Time preferences → respect host availability
>   - Track grouping → same-track sessions spread across different time slots (avoid overlap)
>   - Duration matching → session duration fits slot length

MULTI_TENANT §7.2 line 666: `Auto-suggest: recommend venues and time slots based on vote count (high votes → larger venues), time preferences, and track grouping`.

MULTI_TENANT §7.3 line 678 defines the capacity indicator bands: `Capacity indicator (color-coded: green if session votes < venue capacity, yellow if close, red if over)`.

MULTI_TENANT §12.18 line 1175 is the one place outside the PRD that restates voter-overlap scheduling: `Attendee demand analysis (if many users voted for both Session A and Session B, schedule them in different slots)`; same section lines 1173–1176 add host availability windows (`already partially implemented as time_preferences`), co-host conflict detection, and a "Conflicts" indicator in my-schedule. MULTI_TENANT §12.3 lines 991–999 add estimated attendance "based on vote count and historical conversion rates", undersized-venue warnings, RSVP, and live capacity indicators (`"23 / 50 spots claimed"`).

Design doc §11 "Schedule Page → Convergence Map" lines 343–353 describes the scheduling *output* rendering: day tabs as coordinate labels, time-slot headers as axis tick marks, venue groupings with map-pin glyphs, compact "plotted nodes", and line 353 verbatim: `If a session has high votes relative to others in its time slot, its signal indicator glows slightly brighter — the Schelling point is visible as the brightest node in each time cluster.`

---

# 2. Maps / venues / location

The PRD has effectively **no** map, address, geo-coordinate, wayfinding, or self-hosted-session-location content. What exists:

- **PRD §4.1 line 236** — event landing page shows "Event name, dates, location" (free text).
- **PRD §4.6 line 978** — the live session header shows a room name only: `│  10:00 AM - 11:00 AM • Main Hall`.
- **PRD §4.5 lines 847–849** — "Arrive at Venue / Goes to check-in desk"; §4.6 lines 942–943, participant "enters session room / Sees NFC reader near entrance".
- **PRD §4.7 lines 1135–1143** — venues are name + capacity + features + allowed formats (quoted in item 1). **No address field.**
- **PRD §5.3 lines 1776–1784** — `venues` table: `event_id, name, capacity, features JSONB`. No address, no lat/lng, no geo.
- **PRD §5.4 lines 2012–2015** — `/venues` CRUD endpoints (list/add/update). Nothing location-bearing.
- **PRD §4.2 lines 426–431** — technical requirements checkboxes (projector, whiteboard, audio, seating) are the only venue-fit inputs from proposers.

MULTI_TENANT adds the location layer not in the PRD:
- **§2.2 lines 79–85** — `location_name TEXT, -- "Boulder, CO"`, `location_address TEXT`, and verbatim line 85: `location_geo POINT,                  -- For map features`.
- **§3.1 Step 2, line 258** — `Location name, address (optional: map pin)`; line 259 `Virtual/hybrid/in-person toggle`.
- **§3.1 Step 3, line 262** — `Add venues with name, capacity, features, address` (venue-level address).
- **§11.1 line 923** — platform event discovery includes `Geographic map view` (and line 920, filtering by location).
- **§1 line 37** — existing capability: `**Self-hosted sessions** — Proposers can host at their own locations with custom times`. This is the only mention of self-hosted sessions locating themselves; no schema, UI, or map treatment is specified for it anywhere.

Design doc treats maps as *metaphor*, not feature: cartographic substrate/contour lines (§Part I Layer 1, lines 27–28; §Texture lines 124–129), map-legend-derived track colors (lines 77–83), map-legend glyph bullets for event metadata including `◇ Boulder, CO` (lines 289–293), "Convergence Map" schedule page with `map-pin glyphs and monospace labels` for venue groupings (lines 347–352). No actual map rendering is proposed.

---

# 3. Transcripts / AI / collective intelligence

- **PRD §1.3 Business Model, line 40** — verbatim: `| **Premium** | Burner cards, AI transcription, RAG chatbot, unlimited | 7% \+ transcription fees |`. Transcription/RAG is a paid tier with usage-based fees on top of a 7% cut.
- **PRD §3.2 Session Host, line 186** — verbatim: `- Upload session materials (transcript, slides)`. **This is the only statement of who uploads: the session host.** No admin/staff upload path, no automated capture, no recording device spec.
- **PRD §6 "Premium Feature: AI Transcription & RAG", lines 2164–2255.** §6.1 Architecture (2166–2206) is a two-stage ASCII pipeline diagram, verbatim content: transcription pipeline `Audio Upload → Whisper API → Clean Format → Store (S3)`, with metadata to Supabase; RAG pipeline `User Query → Embed Query → Pinecone Search → Retrieve Top Chunks → Augmented Prompt → GPT-4 Generate → Stream Response`. Named stack: Whisper, S3, Supabase (metadata), Pinecone, GPT-4, streaming responses. **No chunking strategy, embedding model, index-per-event scoping, or ingestion trigger is specified.**
- **PRD §6.2 UI for RAG Chatbot, lines 2208–2255.** Named "Ask the Conference", minimizable panel. Opening copy verbatim (2217–2220):
  > `Hi! I've read all the session transcripts from [Event Name].` / `Ask me anything about what was discussed.` / `Try: "What were the main takeaways from the DAO sessions?"`

  Answers are synthesized across sessions with inline attribution to speakers and quoted lines (e.g. `Alice noted that "pure token voting leads to plutocracy"`), and end with a Sources block citing session, hosts, and timestamp offsets, verbatim (2244–2247):
  > ```
  > │  Sources:                                                        │
  > │  📄 DAO Governance panel (Alice, Bob) - 14:23                    │
  > │  📄 ReFi Discussion (Carol) - 08:45                              │
  > │  📄 Mechanism Design Workshop - 31:02                            │
  > ```
  Plus a follow-up input box (2250–2252).
- **PRD §7 Phase 3, lines 2284–2285** — `| AI Transcription | Upload flow, Whisper integration, storage |` and `| RAG Chatbot | Embeddings, Pinecone, chat interface |`.

**Not present anywhere in the PRD:** the phrase "collective intelligence"; knowledge harvesting; per-session AI summaries; post-event artifacts other than the chatbot and `[Download Report]` for the distribution (line 1427); any consent, opt-out, recording-notice, speaker-approval, or privacy handling for transcripts; any transcript/embedding tables in §5.3 (the schema has no transcripts, materials, or resources table at all); any transcript endpoints in §5.4.

MULTI_TENANT supplies the nearest adjacent material: **§12.12 lines 1091–1102** adds `sessions.resources JSONB` for slides/recordings uploaded by hosts before and after the session via Supabase Storage or external URL; **§12.6 lines 1023–1033** covers GDPR/CCPA generally (data export, deletion, anonymize votes, cookie consent, per-event privacy policy, retention) without mentioning transcripts; **§12.19 line 1184** mentions `Event-level Terms (liability waivers, photo consent, etc.)`; **§12.17 lines 1158–1166** covers full-text search, personalized recommendations, "Similar Sessions", and `Tag cloud / topic clustering visualization` — the closest thing to a knowledge-synthesis roadmap item outside the PRD.

---

# 4. Attendance voting / during-event mechanics

- **PRD §1.1 line 20** — verbatim: `2. **Attendance Voting** — Participants allocate fresh credits during the event via taps, determining how session budgets are distributed`.
- **PRD §2.1 lines 47–65** — shared QV model, verbatim: `Credits spent = (Total votes for session)²` with the 1/4/9/16 ladder and the marginal deltas (`so 3 additional`, `so 5 additional`, `so 7 additional`).
- **PRD §2.3 lines 89–129.** Parameter table (93–98) verbatim rows: `| Credits per participant | 100 (fresh) | Yes |`, `| Voting method | App tap OR Burner card | Yes |`, `| Taps per session | Unlimited (credit-constrained) | No |`, `| When voting closes | Event end \+ 1 hour | Yes |`. Then the key design decision, lines 100–104, verbatim:
  > **Critical Design Decision:** Credits reset completely for attendance voting. This creates two independent signals:
  >
  > 1. Pre-votes \= "What I want to exist"  
  > 2. Attendance votes \= "What delivered value"

  Mental model (line 107) and the tap-to-vote panel mockup (111–129) showing votes-as-dots, credits spent, next-tap marginal cost, remaining credits, and sessions-voted-today count.
- **PRD §2.4 Budget Distribution Formula, lines 132–153.** Verbatim:
  > ```
  > Session share = (Σ √individual_votes)² / Σ all_session_shares
  >
  > Session payout = Session share × Total budget pool × (1 - platform_fee)
  > ```
  > This is **quadratic funding** applied to the aggregated votes:
  >
  > - Square root of each person's votes (diminishes whale influence)  
  > - Sum of square roots, then squared (rewards breadth of support)  
  > - Normalized across all sessions

  With the three-voter worked example table (148–152): DAO Talk (4,1,1) → (2+1+1)²=16 → 40%; Workshop (1,4,0) → (1+2+0)²=9 → 22.5%; Panel (1,1,4) → (1+1+2)²=16 → 40%. (Note the example's 16/9/16 sums to 41 yet the shares are given as 40/22.5/40.)
- **PRD §4.5 Check-In & Burner Card, lines 840–929.** Two identity paths at the desk (QR from app Profile → Check-in QR; or email lookup with optional photo ID). Staff taps a fresh burner card on an activation reader to link it (`✓ Burner card linked: #4A7B2C`). Handover script, lines 901–904, verbatim: `"Here's your voting card. When you attend a session, tap it on the reader at the entrance. Each tap is a vote. You can tap multiple times to give more votes, but each tap costs more credits. Check your app to see your balance."` App confirms check-in with card ID and 100 credits (910–920). Fallback, lines 923–929: app-only check-in — show QR or email, staff marks checked in, participant uses in-app tap-to-vote.
- **PRD §4.6 Tap-to-Vote, lines 933–1054.** NFC reader at room entrance: green LED + beep + "Vote recorded ✓" (947–952), app push-updates. App path: `Opens app → Current session detected (via time) OR manual select` (line 974) — the only stated session-detection mechanism is time-based, with manual override; no geofencing/proximity. Multiple taps accumulate with escalating marginal cost (996–1022, showing 3 votes = 9 credits, next costs 7). Low-credit interstitial, lines 1028–1037, verbatim includes `You have 15 credits remaining.` / `Adding another vote here costs 11 credits.` / `You'll have 4 credits left for remaining sessions.` / `[Vote Anyway]  [Save Credits]`. Post-session summary with thank-you copy tying votes to budget (1039–1053).
- **PRD §5.2 lines 1548–1588** — burner-card data flow: card → NFC reader reads `card ID + venue` → Edge Function looks up card→user, validates credits and that the session is active, records vote → beep/LED → push update to app. **Session identity is derived from the venue the reader sits in.**
- **PRD §5.3 lines 1752–1770** — `attendance_votes(event_id, session_id, user_id, vote_count DEFAULT 1, credits_spent, vote_method IN ('app','burner_card','manual'), burner_card_id)`, `UNIQUE(event_id, session_id, user_id)` — one row per user per session, incremented. `event_access` carries `checked_in`, `checked_in_at`, `burner_card_id UNIQUE`, `burner_card_linked_at` (1663–1670); `events.burner_cards_enabled BOOLEAN DEFAULT FALSE` (1630–1631). QF view, line 1933 verbatim: `POWER(COALESCE(SUM(SQRT(v.vote_count)), 0), 2) as qf_score`, restricted to `WHERE s.status = 'completed'` (1936).
- **PRD §5.4 lines 1984, 1997–1999** — `POST /:slug/check-in`, `GET/POST /:slug/attendance-votes`, `POST /:slug/attendance-votes/card`.
- **PRD §4.8 lines 1289–1430** — distribution dashboard: pool, 5% platform fee, participation stats (`142/156 participants voted (91%)`, `Total votes cast: 847`, `Total credits spent: 3,284`), per-session QF share and payout, per-session drill-down with the QF arithmetic spelled out (1354–1357: `√1 + √2 + √3 + √4 + √2 + ... (52 voters) = 42.8` → `(42.8)² = 1,832` → `1,832 / 9,967 (total) = 18.4% share`), co-host split by percentage with verified payout addresses, on-chain execution on Base with gas estimate, completion + email notifications + downloadable report.
- **PRD §8 lines 2294–2298** — resolutions: fresh 100 credits confirmed; `Tap \= immediate vote or confirmation? | ✅ Immediate vote, can tap again for more`; `Burner card required? | ✅ No, optional premium feature`.
- **Live/realtime**: PRD §4.3 lines 676–680 — `Vote totals for each session update via WebSocket`, aggregated only, `No voter identity revealed until after deadline (optional setting)`. This is specified for pre-voting; no equivalent live leaderboard is specified for during-event.

MULTI_TENANT §12.14 lines 1127–1136 adds a different check-in design (QR per ticket, camera scanner, volunteer UI at `/e/{slug}/checkin`, real-time attendance tracking, and `Check-in gates (only allow voting after check-in for in-person events)`). §12.7 lines 1035–1044 adds offline day-of resilience: service-worker schedule cache, `Optimistic UI updates for voting (queue votes locally, sync when online)`, PWA, offline QR check-in against a pre-downloaded attendee list.

---

# 5. Other long-term visions / roadmap items

**From the PRD:**
- **§1.3 lines 34–41** — four-tier business model: Free (core voting/scheduling, ≤100 participants); Standard (NFT gating, budget distribution, ≤500, 5% of distributed funds); Premium (burner cards, AI transcription, RAG chatbot, unlimited, 7% + transcription fees); Enterprise (white-label, custom integrations, SLA, custom pricing).
- **NFT gating** — §4.1 lines 260–266 (wallet connect → NFT ownership OR whitelist check → "You need a ticket" screen with purchase/mint link); §5.3 lines 1609–1612 `access_type IN ('nft','email','open')`, `nft_contract_address`, `nft_chain_id`; §5.1 line 1490 Ticket NFT contract on Base.
- **§5.1 lines 1490–1493** — explicitly future on-chain component: `│ (Future:  Burner Wallet)  │` alongside the Ticket NFT and Treasury contracts.
- **§5.1 lines 1496–1502** — `HARDWARE LAYER (Optional)`: burner cards (NFC wallets), NFC readers at sessions, check-in stations.
- **§7 Implementation Phases, lines 2259–2286** — Phase 1 Core Platform (8–10 wks: foundation/auth/DB; events & access incl. NFT gating; sessions; pre-voting; scheduling algorithm wks 9–10). Phase 2 Budget Distribution (4–6 wks: attendance voting UI, treasury contract + audit, distribution). Phase 3 Premium Features (Ongoing): Burner Cards, AI Transcription, RAG Chatbot, and `| Analytics | Dashboards, export, insights |`.
- **Notifications in the PRD** are per-flow only: proposal status changes (507–511), merger request/counter/decline/accept (749–819), schedule publish push+email (1272–1284), distribution completion emails (1425). There is no notification system, preference, or center specified.
- **Matchmaking / "help people find each other"** — not present in the PRD as a feature. Adjacent: profile "Topics you're interested in" tags at onboarding (line 292), co-host search (443–446), and session mergers as the collaboration mechanism (§4.4). The design doc supplies the framing sentence, design_doc_01 line 13: `it doesn't say "we're a coordination engine that helps humans find each other and converge on shared experiences."`
- **Reputation** — absent from the PRD.

**From MULTI_TENANT (not in the PRD):**
- **§11.2 lines 926–932** — multi-event identity and reputation: cross-event `profiles`, profile page of all events participated in, sessions hosted across events, `Reputation/history (total sessions hosted, total votes received)`, reusable auto-filling profile.
- **§11.1 lines 916–924** — event discovery hub: featured carousel, filterable grid, search, categories, geographic map view, "My Events".
- **§11.3 lines 934–939** — recurring events, "Clone Event", event series, carry-over of venues/tracks/team.
- **§11.4 lines 941–948** — platform admin dashboard (cross-platform counts, revenue, featuring, ban/suspend).
- **§11.5 lines 950–956** — embeddable widgets (schedule, session list, voting, propose button).
- **§6 lines 498–636** — full notification system: per-lifecycle triggers for hosts/attendees/admins (tables at 512–541, incl. `Session receives N votes milestone`, `High-vote session not yet scheduled`, `Schedule conflicts detected`, `Attendee capacity threshold reached`, `Event starting soon (1 day, 1 hour)` push), `notifications` + `notification_preferences` tables (545–571), email template library, in-app notification center.
- **§12.13 lines 1104–1125** — feedback & ratings: `session_feedback` table (1–5 rating, comment, `is_anonymous`), configurable post-event feedback window, aggregate ratings to hosts, summary for organizers.
- **§7.4 lines 697–705** — admin analytics dashboard at `/e/{slug}/admin/analytics`: proposal stats, voting stats, attendee stats, schedule/venue/slot utilization, engagement.
- **§10 lines 790–912** — ticketing (Stripe + crypto), and revenue distribution smart contract `SchellingPointDistributor` where hosts claim shares based on quadratic votes with a multi-sig treasury; §10.1 line 839: admin sets a revenue share percentage (e.g. 30% of ticket revenue).
- **§12.4 lines 1001–1009** — waitlists (event-level and session-level RSVP tied to venue size, auto-promotion + notification).
- **§12.5 lines 1011–1021** — moderation at scale, incl. `Trust scores for users based on history`.
- **§12.8 lines 1046–1055** — calendar integration (.ics per session and per personal schedule, Google deep link, subscribable feed, 15-min reminders).
- **§12.10 lines 1069–1078** — mobile/PWA with push, deep linking, possible React Native/Capacitor later.
- **§12.15/12.16/12.17 lines 1138–1166** — i18n; outgoing webhooks + Slack/Discord/Zapier + per-event API tokens; in-event search, personalized recommendations, "Similar Sessions", topic clustering.
- **§12.20 lines 1188–1196** — platform economics options (freemium ≤50 attendees, 2–5% transaction fee, feature gating for custom domains/analytics/API, white-label licensing for enterprise).
- **§16 lines 1356–1462** — 8-phase, 20-week roadmap (Foundation → Self-Serve Creation → Branding → Notifications → Admin Overhaul → Attendee Experience → Ticketing & Revenue → Scale & Polish). Auto-scheduling algorithm sits in Phase 5 (Weeks 8–10).
- **Appendix line 1489** — `### Why Build Smart Contracts Later` (deliberate deferral of on-chain work).

---

# 6. Settings / organizer UX guidance and stated principles

**PRD:**
- **Defaults are stated as parameter tables with explicit configurability**, §2.2 lines 71–77 and §2.3 lines 93–98: pre-vote credits 100 (configurable 50–200), voting opens when proposals close, deadline 24h before event, votes hidden until deadline, no minimum to schedule; attendance credits 100 fresh, app-tap-or-card, unlimited taps, closes at event end + 1 hour. Schema defaults mirror these: `pre_vote_credits INTEGER DEFAULT 100`, `attendance_vote_credits INTEGER DEFAULT 100`, `burner_cards_enabled BOOLEAN DEFAULT FALSE`, `status DEFAULT 'draft'` with the 7-state lifecycle `draft → proposals_open → voting_open → scheduled → live → concluded → distributed` (lines 1615–1631).
- **Session-proposal flow principle**: 4 explicit steps with a running "Step N of 4" indicator, back navigation, live preview before submit, and a transparency note before submission (§4.2 lines 351–503; line 475–477 verbatim: `ⓘ Your session will be reviewed by the event organizers before appearing to other participants.`). Field guidance is inline microcopy: `Keep it clear and specific (5-80 characters)` (366), `What will happen? Who should attend? (50-500)` (377), `Leave blank for no limit (venue capacity)` (437).
- **Participant onboarding principle**, §4.1 lines 298–340: mandatory profile setup (display name, optional bio, interest topics) then a 4-card swipeable tutorial — how the unconference works, quadratic voting with an `[Interactive demo: try allocating votes]`, the two voting phases, and a "Ready to Explore" exit. Success criteria, lines 336–340, verbatim:
  > - User completes authentication in \<60 seconds  
  > - User understands voting mechanics (validated by tutorial completion)  
  > - User can navigate to sessions and begin participating
- **In-product nudging**: §4.3 lines 669–672, verbatim `💡 Tip: You have 82 credits left. Consider voting on more sessions to influence the schedule.` and real-time cost previews / failure microcopy (`"Not enough credits" tooltip, shake credit bar`, 591–604).
- **Organizer scheduling flow principle**, §4.7: review demand → review clusters → configure constraints → run → review with warnings and a quality score → manual drag-drop with live revalidation → publish with an explicit notify-or-quiet choice. Admin remains the final authority at every step (also §8 line 2297: minimum votes to schedule is "Admin discretion, soft recommendation").
- **Approval is the default gate** for proposals (§4.2 lines 505–511: approve / request changes / decline; approval moves a session into the voting pool).

**MULTI_TENANT §3 (the actual organizer setup-flow spec):**
- **§3.1 lines 245–295** — 8-step `/create` wizard: Basics → Dates & Location → Venues → Schedule Structure → Tracks & Categories → Voting Configuration → Branding → Review & Launch, ending in `"Save as Draft" or "Publish"`. Step 6 defaults, line 277: `Credits per attendee (default 100)`; line 278: `Voting mechanism: quadratic (default), linear, approval`; plus voting/proposal windows, max proposals per user, whether proposals require admin approval, and allowed formats/durations. Step 4 includes bulk slot creation (`"45-min sessions with 15-min breaks from 9am-5pm"`) and break/lunch/check-in presets.
- **§3.2 lines 297–304** — templates as the default-setting mechanism: Unconference Classic, Curated Conference, Hackathon, Community Meetup, Clone from Previous Event.
- **§3.3 line 308** — wizard state persisted to `localStorage` per step so progress survives navigation; completion is a single transactional API call creating event + venues + tracks + time slots.
- **§2.2 schema defaults lines 99–112** — `vote_credits_per_user DEFAULT 100`, `allowed_formats DEFAULT ARRAY['talk','workshop','discussion','panel','demo']`, `allowed_durations DEFAULT ARRAY[15, 30, 60, 90]`, `max_proposals_per_user DEFAULT 5`, `require_proposal_approval BOOLEAN DEFAULT TRUE`, `visibility DEFAULT 'public'`.
- **§12.1 lines 964–978** — phase-gating principle: `Proposals can only be submitted during proposals_open`, `Votes can only be cast during voting_open`, `Schedule is only visible after schedule_published`, with transitions either automatic (timestamp-driven) or manual.
- **§4.1 lines 328–333** — branding philosophy, verbatim line 333: `The platform provides the infrastructure; the event owns the identity` ("white-label-lite", "Powered by Schelling Point").
- **§7.1 lines 639–650** — enumerated organizer-UX pain points that any new admin flow is meant to fix (two-step scheduling, no conflict detection, no capacity warnings, no batch ops, weak filtering, no undo, no admin-created sessions).

**design_doc_01 (UX principles, aesthetic-level):**
- **Principle 5, lines 50–51** — verbatim: `**5. Progressive Revelation** — The system layer reveals itself progressively. First-time users see a clean, simple interface. As they engage — voting, proposing, navigating — the coordinate system becomes more visible. ... This prevents overwhelm while rewarding engagement with richer visual context.`
- **Principle 1 (lines 38–39) "Semantic Decoration Only"**, **Principle 4 (47–48) "Tactile Feedback, Not Animation Theater"** — micro-interactions must serve feedback (the vote "signal ping", lines 173, 176 counter-tick).
- **§17 Onboarding Modal, lines 435–448** — reframes onboarding as `Network Initialization` with a 3-step protocol sequence `[1/3] IDENTIFY / [2/3] CONFIGURE / [3/3] CONNECT` and a "Connection Established ✓" completion.
- **§4 CreditBar, lines 235–244** — the credit gauge must show quadratic pricing inline (`> cost = votes² (quadratic pricing)`) and shift green→amber below 25% remaining.
- **§15 Admin Dashboard, lines 410–419** — "Control Center" framing with batch command bar (`3 NODES SELECTED · [APPROVE] [SCHEDULE] [REJECT]`); **§6 Phase 6 line 528** — event creation wizard framed as `"Configure New Node"` with step progress as protocol stages.
