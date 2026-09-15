# Unconference production audit — 15 September 2026

Scope: the `atproto` application deployed at unconference.events on frontrange-twin-1. Baseline commit: `6be064771cc619fb979f406a2d608ee0b3d3b598`. The web2 `main` branch remains separate.

## Evidence and release status

The baseline passed all 223 existing local regression tests, typecheck, 25 lexicons, production build and transactional SQL tests. Nine additional regressions cover the defects below. The final 232-test release run and deployment are recorded in the release verification section below.

Production app/Postgres/PDS containers were healthy; the indexer was connected and advancing its Jetstream cursor. Scheduler logs contained no recent failures. Production's privacy audit passed, but checked **zero gathering actors / zero public records**. This is not evidence of a complete live publishing flow. Local tests use a reference PDS and mock PLC, exercise actual repository writes and indexed records, and clean up their own fixtures without changing seeded gatherings.

Production has an email delivery key. Stripe key and webhook secret were missing at audit time. The operator selected their Stripe account; secure pairing is pending. Paid checkout fails closed until both secrets and an organizer's payout-ready connected account are available. Free tickets remain supported.

## Confirmed defects and fixes

| Finding | Evidence | Resolution |
| --- | --- | --- |
| Apex DNS included a parking address | Authoritative servers returned both 162.255.119.84 and 2.29.37.247; ACME timed out at the former. | Operator removed the parking record. Reloaded unconference Caddy; valid public HTTPS health and OAuth metadata return 200. |
| Proposals and RSVPs bypassed ticket admission | Isolated HTTP regressions created participation without a ticket, even though Join refused admission. | Shared entitlement checks in membership paths and SQL insertion triggers. Tests refuse unpaid/attend-only proposals and unpaid RSVPs; entitled holders succeed. Voting also requires the appropriate tier rights. |
| A refunded payment could restore admission | Completion replay changed a cancelled ticket back to confirmed. | Per-payment transaction lock and private fingerprint ledger make full refunds terminal, including refunds received before completion. |
| Concurrent checkouts could open multiple payment pages for one hold | Two requests entered gateway creation concurrently. | Transactional per-holder lock, tier capacity lock, and confirmed expiry of the previous checkout before replacement. Regression asserts one gateway call. |
| Fees did not match the requested model | Fixed 5% plus 50 cents, with no creation setting. | Organizer-selected 1–100% contribution, up to two decimal places, default 1%; no fixed surcharge. Amount rounded to cents with a one-cent minimum for paid tickets. Checkout snapshots its quoted price, currency and contribution. Revenue uses stored sale amounts. |
| Price/currency/capacity edits could invalidate existing sales | Tier edits were independent of outstanding checkouts. | One supported currency per event; no repricing a tier with ticket history; capacity cannot fall below confirmed tickets plus live holds. Create a new tier to change prices. |
| Payout readiness and connected-account ownership were insufficiently guarded | Settings accepted a pasted account ID; checkout relied on configuration alone. | Accounts come through Connect onboarding. Paid checkout requires charges and payouts enabled. Disconnecting payouts preserves ticket admission restrictions. |
| Bluesky login vanished during slow configuration lookup | Browser regression timed out with only email sign-in visible; initial HTML lacked the Bluesky form. | Read the non-secret availability flag on the server for every login request. The form is present in the initial HTML. |
| Profile import raced onboarding and could overwrite edits | Import was fire-and-forget; onboarding started empty. | Await bounded Bluesky import before redirect; initialize onboarding from saved fields; compare-and-swap fills only missing fields and binds updates to the returned DID. Avatar copied through SSRF-safe bounded fetch and normalized with pixel limits. |
| Privacy audit failed when exact locations existed | An unfinished SQL WHERE clause was only reached with private location fixtures. | Fixed the query and made E2E audit fixtures exercise that branch. |
| Backup pipelines could report success after a failed dump | Fault injection demonstrated swallowed pg_dump failure. | Enable pipefail, preserve errexit through a separate loop invocation, clean temporary files. Both one-shot and loop fault-injection checks pass; disabling pipefail reproduces the failure. |
| Initial admission fix blocked curated, unattributed sessions | Full regression caught organizer CSV imports failing after entitlement enforcement. | Explicit owner/admin or service-only exception for host-less curated sessions; participant checks remain enforced. |

Migrations 0012–0017 introduce the entitlement guards, private refund ledger, contribution snapshots and pricing constraints. The refund ledger retains only SHA-256 fingerprints, without a reversible Stripe ID or an account/event link. A regression first demonstrated the raw-reference leak, then verifies that no raw ID is retained. Tickets, payment references, interests and exact locations stay app-side. No new public lexicon fields or foreign identity records were introduced.

## Experience changes and review

- Use **unconference** consistently in product navigation, metadata, login, legal copy and calendar exports. Protocol collection names remain unchanged.
- Landing page explains proposing, private voting and gathering through the existing interactive scrolling sequence, with a clearer utility-led opening and stronger typography.
- Creation includes admission and contribution settings, review summaries, and a shorter path using defaults. Identity consent explains the durable public DID history.
- Organizer workspace offers direct setup actions for details, rooms/times and tickets. Bulk scheduling supports quarter-hour boundaries, previews and preflight overlap detection.
- Ticket settings explain contribution snapshots and confirm saves; decorative sparkles and wands have been replaced with functional icons.
- Onboarding preserves imported and edited profile details; its final action says “Save profile,” accurately separating profile setup from event admission.

Browser review used a separate local gathering and account. Creation with a 3% contribution succeeded, a room saved, eight time slots saved atomically, and a duplicate overlapping batch was disabled with a clear explanation. The calendar displayed all eight slots at the expected event-local times. Ticket settings showed the original 3% contribution; changing it to 4% displayed a saved confirmation. The landing example accepted an idea and carried it into the voting chapter; no client errors were reported. The onboarding walkthrough preserved a seeded QA name, bio and two interests through Save profile; SQL confirmed all original values and completion. The isolated UX gathering and account were then removed, including their local PDS identities. Desktop layouts were inspected visually. A separate mobile browser pass is still outstanding.

## Public interests and unfinished features

Interests already belong to the account-level profile and persist across gatherings. They currently remain private application data. For portable public interests, use an **explicit opt-in, self-authored repository record** in a dedicated `schellingpoint.draft.*` collection. Resolve it by the person's DID, support editing/deletion and index it into the profile. Do not place interests into a DID document, modify the borrowed Bluesky profile lexicon, infer interests from votes, or publish another person's interests. Public replication/deletion limits need to be clear before consent. This public record feature is not implemented in this release.

Push notifications remain a visibly disabled, unshipped setting. Existing email/in-app notifications are separate. Partial refunds are not reflected in the revenue dashboard; full refunds revoke ticket entitlements. Historical membership and shared history are retained after refunds, while new ticket-gated participation is refused. Stripe remains the accounting source of truth, including processing fees and partial refunds.

## Operational checks still requiring external access

- Complete a real Bluesky sign-in callback and verify imported name, avatar and bio on the live domain. The public authorization-start route currently reaches bsky.social; that alone does not verify callback or consented publishing.
- Pair the selected Stripe account, provision production configuration securely, and exercise sandbox Connect onboarding, checkout, signed webhook delivery, refund and revenue before enabling live sales. Injected gateway tests verify application logic, not provider connectivity.
- Confirm actual email delivery with an operator-owned inbox.
- Rehearse recovery from encrypted R2 backups. The 20260915T055214Z Postgres and PDS SQLite archives exist both on-server and in R2 with matching sizes (130975 and 5513 bytes). Automatic approval review blocked transfer of production backups into local temporary storage pending explicit operator authorization. No decrypted production data has been downloaded and no restore is claimed.

## Release verification

Final code, including refund fingerprints:

- `npm test -- --retries=0`: **232 passed**, no retries or skips (45.1 seconds).
- `npm run typecheck`: passed.
- `npm run lexicons:validate`: all 25 valid.
- `npm run build`: passed.
- `npm run test:sql`: passed.
- `npm run atproto:audit`: passed. The standalone post-cleanup run has zero gathering records; the E2E suite separately runs this audit before cleaning its published fixtures.
- `python3 tests/backup-failure.py`: both one-shot and loop failure cases passed.
- `git diff --check`: passed.

The release is ready for deployment to the existing ATProto stack. Production activation and final
HTTP checks are recorded after deployment. The external account/recovery checks above remain
outstanding and must not be inferred from these local results.

## Reference contracts

- [AT Protocol OAuth](https://atproto.com/specs/oauth): HTTPS client metadata, confidential client signing and repository scopes.
- [Bluesky profile lexicon](https://github.com/bluesky-social/atproto/blob/main/lexicons/app/bsky/actor/profile.json): use its documented fields; public interests need their own record.
- [Stripe destination charges](https://docs.stripe.com/connect/destination-charges) and [webhooks](https://docs.stripe.com/webhooks): application fees, signed fulfillment, event ordering and refund behavior.
