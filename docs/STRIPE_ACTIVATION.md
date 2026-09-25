# Stripe activation

Status, 25 September 2026: **the direct-charge model is now proven end to end against the
Stripe sandbox — real money moved in test mode, through the real product.** A sandbox test key
lives in `.env.local` on a developer machine (never in the repository); production still holds
no Stripe key, no live key exists anywhere, and no real money has moved.

The owner enabled Connect on the sandbox during the session, choosing the "customers buy from
the seller" option. That is our model, and Stripe's own records confirm it: the merchant account
carries `controller: { fees: { payer: "account" }, losses: { payments: "stripe" },
stripe_dashboard: { type: "full" }, requirement_collection: "stripe" }`.

**The charge type is direct, confirmed from both sides of the ledger.** A $25 ticket at a 3%
contribution, paid with 4242:

| | |
|---|---|
| Where the charge lives | the **connected account** — `charges.retrieve` platform-scoped answers `resource_missing` |
| `transfer_data` / `destination` | `null` — not a destination charge |
| Merchant balance transaction | gross $25.00, fee $1.78, **net $23.22** |
| Platform balance transaction | type `application_fee`, gross **$0.75**, Stripe fee **$0.00**, net **$0.75** |

The platform receives the contribution and bears no processing cost; Stripe's $1.03 comes off
the merchant. A 1% contribution cannot become a platform loss, which was the defect in the
destination-charge implementation this replaces.

### Verified against the sandbox on 25 September 2026

*Standalone script* (`scripts/stripe-sandbox-verify.mjs`, merchant `acct_1UJhawHEEMVg1VvT`,
session `cs_test_a18Nqo8AR76eZMovWIT7HyOKtW7jNbJvzvNNHgSLf1UZAypFsjmUSFNhhc`): merchant created
→ Stripe-hosted onboarding completed in a browser with Stripe's test data (`address_full_match`,
dob 1901-01-01, test bank `110000000` / `000123456789`) → readiness true → $25 session at 3% →
paid with 4242 → **all nine checks passed**, including the 75-cent application fee, the absence
of `transfer_data`, and Stripe's fee on the merchant's balance transaction.

*The product itself* (local stack, a throwaway gathering, two throwaway accounts, real routes,
real Stripe, `stripe listen` forwarding real deliveries):

- **Connect from the admin tickets page** creates the merchant through the audited port, returns
  Stripe-hosted onboarding, and reflects readiness on return (`chargesEnabled`, `payoutsEnabled`,
  `detailsSubmitted`, `api: "v1"`).
- **`account.updated` arrived five times** as real Connect deliveries and did exactly what it
  claims: recorded the capabilities on the gathering, **paused** paid sales while `card_payments`
  was not yet active with **one** `payments_paused` notification to the owners, and **resumed**
  when it went active. No duplicate notification.
- **The readiness gate** refused paid sales (409 / 503 `NO_MERCHANT_ACCOUNT`) before the merchant
  existed, creating neither a ticket nor a checkout reference, and opened (`payments_ready: true`)
  once charges and payouts were both live.
- **An attendee bought the $25 ticket through the app.** The reference was written before the
  redirect (`model: direct`, `application_fee_amount: 75`, the merchant's account id), the real
  `checkout.session.completed` arrived on the connected account and settled it
  (`settled (confirmed)`), `stripe_events` claimed the delivery against the resolved gathering
  with no rejection, the ticket became `confirmed`, the buyer became a member, and the sale
  appeared on the organizer's Paid sales card as refundable.
- **Refunds, both kinds, issued in the merchant's context.** A $5 partial returned $5, returned
  **no** contribution, and left admission alone. The full refund then returned the remaining $20
  **with** the 75-cent contribution, cancelled the ticket and sent the holder a `ticket_refunded`
  notification. The matching `charge.refunded` deliveries were handled convergently — the partial
  one `ignored (partial refund recorded)`, the full one `refunded (cancelled=1)`. The revenue page
  then read $0 revenue, $0 platform fees, 0 confirmed tickets.
- **Replay is dropped, not re-processed.** The settled `checkout.session.completed` was
  re-delivered twice with valid signatures: both answered `{"outcome":"duplicate"}`, `stripe_events`
  still held one row with its original `received_at`, and the cancelled ticket was **not**
  re-confirmed. A platform-scoped delivery naming a session we never opened was refused and
  recorded (`rejection = NO_REFERENCE`) rather than silently dropped.
- **Signature and livemode.** Deliveries signed by the `stripe listen` secret verify; test-mode
  events pass the livemode check against a test key. The live half cannot be tested without a
  live key.
- **usd minimum is $0.50.** 50 cents is accepted, 49 cents and 1 cent are refused with
  `amount_too_small` — "The Checkout Session's total amount due must add up to at least $0.50 USD".
  Other currencies remain unchecked.
- **A 100% contribution is accepted by Stripe at session-create time — and so is a fee *larger*
  than the charge** (2501 on a 2500 session). Stripe does not enforce the ceiling at create; the
  application's own clamp is what does. Neither was paid, so what happens at capture is still
  unverified — and now cannot be reached from the product: **the contribution is capped at 50%**
  (see "The fee model"), so the merchant always keeps at least half of every ticket.

### Two defects found and fixed while doing this

1. **The Accounts v2 → v1 fallback never ran.** Stripe's v2 error envelope carries no `type`, so
   the SDK reports `StripeUnknownError`; `isV2Unavailable()` matched on type and rethrew.
   The sandbox produced three different codes in one afternoon —
   `non_connect_platform_accounts_v2_access_blocked` (platform not enabled for v2),
   `identity_country_required` (v2 wants a country the organizer never gave us), and
   `account_not_yet_compatible_with_v2` (a fresh v1 account is not yet addressable through the v2
   account-links API, which broke the *onboarding link* after the account was already created).
   Matching code-by-code was whack-a-mole and each miss left the organizer with a raw Stripe
   message and no way to connect. The rule is now: an answer from v2 that the SDK cannot classify
   means "use v1", because v1 is the equivalent path and always safe, while real failures
   (`StripeConnectionError`, `StripeAPIError`, `StripeRateLimitError`, `StripeAuthenticationError`)
   keep their own types and still reach the organizer. Covered by a test built from the real error
   shapes.
2. **A failed merchant creation locked the organizer out for 24 hours.** `createMerchantAccountV1`
   keyed its idempotency on the event id alone (`unconference-merchant-v1-<eventId>`). When the
   first attempt failed for an environmental reason — Connect not yet enabled — Stripe cached that
   400 and replayed it verbatim for every retry, so the organizer could not connect even after the
   platform was fixed. Verified directly: the same key still replays the stale error while a fresh
   key creates an account immediately. **Fixed**, without giving up the property the key existed
   for. `events.stripe_connect_attempts` (migration 0040) counts *failed* creates and is the last
   component of the key — `unconference-merchant-v1-<eventId>-<attempts>`. A create that Stripe
   refuses increments it in the same request, so the organizer's next click is a fresh request;
   a success leaves it alone; and two clicks inside one attempt still send the same key, so they
   still collapse to one account rather than orphaning a second. The rule lives in
   `src/lib/payments/connect.ts` (`connectMerchantAccount`), apart from the route so it can be
   tested against the real database with no Stripe key.

The code no longer creates Express accounts or destination charges. It creates merchant accounts
through Accounts v2 where available, falling back to the v1 `controller` equivalent, and charges
tickets **directly on the organizer's own account** with the contribution as an application fee.

## The fee model

The organizer is the **merchant of record**. A Checkout Session is created in their account's
API context (`{ stripeAccount }`), with `payment_intent_data.application_fee_amount` set to
`round(price × contribution%)` — exactly that, with no minimum, so a ticket too small to round
up to a whole cent contributes nothing rather than being charged a cent the organizer never
chose — and **no `transfer_data`**. Stripe therefore collects its
processing fees from the organizer's balance, and unconference receives the contribution and
nothing else. A 1% contribution on a $25 ticket is 25 cents of platform revenue, and cannot be
a platform loss — which was the defect in the destination-charge implementation this replaces.

**The contribution is 1% to 50%, and 50% is enforced three times over.** Stripe accepts an
application fee equal to the charge and even one larger than it (confirmed against the sandbox:
2501 on a 2500 session), so the ceiling is entirely ours to keep. The ticketing-settings route
refuses anything above 50 with a 400, the admin form offers no more than 50, and
`calculatePlatformFee` clamps to `maxPlatformFeeCents` — half the price, rounded *down*, so the
share cannot tip past half on an odd number of cents — with `buildCheckoutSessionParams` clamping
again on the way out. A row stored above the ceiling (the column still permits 1–100, migration
0014) is charged as 50% and the admin page asks the organizer to lower it; nothing about it is
an error at charge time. The organizer therefore always keeps at least half of every ticket
before Stripe's processing fee, and never owes money on the price alone.

There is no fixed surcharge and nothing is added to the buyer's price. Organizer-facing copy
says plainly that the contribution is separate from Stripe's processing fees: the form reads
"Up to 50%. This is separate from Stripe's processing fees."

## Implemented

1. **Merchant accounts.** `stripeMerchantGateway()` (`src/lib/payments/stripe.ts`) creates
   accounts with `POST /v2/core/accounts`: a merchant configuration requesting `card_payments`,
   `dashboard: 'full'`, and `defaults.responsibilities` of `fees_collector: 'stripe'` /
   `losses_collector: 'stripe'`. Onboarding is `POST /v2/core/account_links` with
   `use_case.type: 'account_onboarding'` and `configurations: ['merchant']` — Stripe collects
   country, legal identity and payout details itself; the application attests to nothing.
   If v2 is not enabled for the platform, it falls back to the v1 equivalent,
   `POST /v1/accounts` with
   `controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' },
   stripe_dashboard: { type: 'full' }, requirement_collection: 'stripe' }`, and logs which API
   was used. The fallback triggers on any answer from v2 that the SDK cannot classify (the v2
   error envelope carries no `type`, so it arrives as `StripeUnknownError`), or on a documented
   invalid-request/permission code; a typed failure — outage, throttle, bad key — is rethrown so
   it reaches the organizer instead of being retried pointlessly against v1. Against the sandbox
   this fired three times on 25 September 2026, with a different code each time.
   `STRIPE_ACCOUNTS_API=v1` forces the fallback. Readiness reads `charges_enabled`
   and `payouts_enabled` (v1) or the merchant/recipient configuration statuses (v2).
   The create call's idempotency key is `unconference-merchant-<api>-<eventId>-<attempts>`, where
   `attempts` is `events.stripe_connect_attempts`: incremented only by a failed create, so a
   retry is a fresh request while a double-click is still the same one.
2. **Direct charges.** Sessions are created, retrieved and expired in the connected account's
   context. Refunds too. Sessions written by an older release carry `model: 'destination'` on
   their reference and are still settled under their original, platform-scoped rules — there
   are none in production, but the code does not pretend they cannot exist.
3. **Immutable checkout references** (migration `0029_checkout_references.sql`). Before the
   buyer is redirected, the application records the session id, connected account, gathering,
   tier, hold, holder, price, currency, contribution percentage, application fee and charge
   model. A database trigger refuses to rewrite any of it. Every webhook resolves this row by
   session id and requires that the reference's account equals **both** the delivered account
   (`event.account`) and the gathering's current `stripe_account_id`; settlement then uses the
   recorded price and fee, never the delivery's metadata. The expired-hold sweep clears the
   hold and leaves the money facts; 90 days after a reference reaches a terminal state, the
   retention rule `checkout_references_holder_90d` nulls the holder, so this never becomes an
   identity-linked payment ledger. Existing refund fingerprints still stop completion replays.
4. **Idempotency by event id.** `stripe_events` claims each delivery before it is processed
   (`src/lib/payments/deliveries.ts`), so a redelivery is dropped rather than re-run — which
   matters now that a delivery can issue a refund or send a notification. The claim is a row
   lock held across the whole handler, not a read followed by a hopeful write, so two
   simultaneous deliveries of one event cannot both dispatch. Every refund also carries a
   Stripe idempotency key (`refund-<session>-<amount>`), so a retried refund returns the same
   refund instead of sending the money twice. Each individual effect remains convergent, so a
   retry after a crash is still safe. Swept after 30 days.
   The row is claimed before the payload is resolved, so its `event_id` is filled in whenever
   the delivery resolves to exactly one gathering and left null when it genuinely belongs to
   none; `stripe_events` is therefore on the privacy audit's platform-scoped allowlist.
5. **`account.updated`.** Capability changes are recorded on the gathering
   (`events.stripe_charges_enabled` / `stripe_payouts_enabled`), and a lost capability sets
   `paid_sales_paused_at`, notifies the owners and admins once, and makes the readiness gate
   refuse new paid checkouts. It never flips `ticketing_enabled` and never revokes admission
   anyone already paid for. The v2 event shape (`v2.core.account.updated`) is handled too.
6. **Refunds in the product.** Organizers refund from the admin tickets page (a "Paid sales"
   card, backed by `…/ticketing-settings/sales` and
   `…/ticketing-settings/sales/[ticketId]/refund`). A full refund returns the whole remaining
   amount, returns the contribution with it by default, cancels the ticket and notifies the
   holder; a partial refund records the amount and leaves admission alone. Every refund is
   issued in the connected account's context, with `refund_application_fee` stated explicitly
   rather than left to a default. Stripe's processing fees are never returned by a refund, and
   the copy says so.
7. **Refused payments are recorded and given back, not dropped.** A paid delivery that cannot
   be matched to a checkout this application opened used to answer 2xx and write a log line —
   a buyer charged with nothing to show for it and nobody told. Now the refusal and its reason
   are written to `stripe_events` and listed on the revenue page next to the refund-needed
   payments. Where the payment is *provably ours* — the session is in our references and the
   refusal is that the gathering changed its Stripe account, or that the amount did not match
   the quote — it is refunded automatically in the merchant's own context and the buyer is
   told. A delivery that arrived on the wrong account, or names a session we never opened, is
   only recorded: it is not provably ours, and the merchant may be selling other things on the
   same account.
8. **Seatless payments are returned, not stranded.** When a delayed payment arrives after the
   hold lapsed and the tier filled, settlement no longer manufactures a ticket from metadata:
   it resolves the reference, re-creates the seat from the reference's own tier and holder if
   capacity allows, and otherwise refunds the buyer automatically in the merchant's context and
   tells them. Without a refund gateway it falls back to `refund_needed`, which the revenue
   page already surfaces. A settlement that rebuilds a swept seat also re-links
   `checkout_references.ticket_id` to whichever ticket the payment ended up owning (the only
   change the immutability trigger permits, and only into an empty link), so the sale stays
   visible to the organizer's sales list and refundable instead of becoming money with no sale.
9. **Readiness gate.** `paidSalesBlock()` (`src/lib/payments/merchant.ts`) is the single rule
   used by the ticketing-settings route (which refuses the write, 409, with a reason), the
   checkout route (which refuses the charge) and the admin page (which explains before either
   is attempted). It refuses when keys are missing, when no merchant is connected, when
   onboarding is incomplete, when payouts are disabled, when sales are paused, and when
   readiness cannot be read at all — it never assumes an unreadable account is healthy.
10. **Revenue reporting.** Platform revenue is the application fee actually collected, summed
   from settled, unrefunded references — net of nothing else. Organizer net is gross minus the
   contribution and is labelled "before Stripe processing fees", because Stripe reports those
   on the organizer's own account and this application does not read them. Refunded amounts
   are scoped to *settled* references, so the superseded references a restarted checkout leaves
   behind are never counted as money that went back, and Stripe's cumulative application-fee
   reversal is stored as a high-water mark rather than accumulated.
11. **Webhook separation.** The route verifies the signature against `STRIPE_WEBHOOK_SECRET`
    and, if present, `STRIPE_WEBHOOK_SECRET_CONNECT`, then refuses any delivery whose
    `livemode` disagrees with the configured key's mode. Sandbox and live can never settle each
    other's tickets. No secret, signature or payload is logged.

## Tests

`tests/payments-direct.spec.ts` (20 cases) and the payment cases in `tests/ticket-audit.spec.ts`
run against the real local database with Stripe substituted only at the application's own seams
(`CheckoutGateway`, `MerchantGateway`, `RefundGateway` — the fakes live in `tests/helpers/payments.ts`,
so no pretend-Stripe code ships). They cover: $25 at 1% producing a 25-cent application fee with
no `transfer_data`; a session opened in the merchant's context; the immutable reference and its
database-level refusal to be rewritten; cross-account, platform-scoped, unknown-session and
account-changed deliveries all refused; a forged delivery naming a real ticket in its metadata
refused; replay and out-of-order deliveries; duplicate event ids dropped; a legacy
destination-model reference still settling; a swept hold settled from its reference *and its
reference re-linked so the sale stays refundable*; a refused payment recorded on the revenue
page and refunded automatically when it is provably ours; two simultaneous deliveries of one
event id dispatching exactly once; automatic
refund of a seatless payment in the merchant context; organizer full and partial refunds;
`account.updated` pausing and resuming paid sales with a single notification; the readiness gate
at every stage; the Accounts v2 → v1 fallback firing on every unclassifiable v2 answer the
sandbox actually returned while outages, throttles and bad keys are still rethrown; a failed
merchant create incrementing `stripe_connect_attempts` and the next click succeeding on a fresh
idempotency key while the stale key still replays Stripe's cached error, a success leaving the
counter alone, and two clicks inside one attempt collapsing to one account; the 50% contribution
ceiling in validation, in `calculatePlatformFee` and in `buildCheckoutSessionParams`, including a
stored percentage above it being charged as 50%; and the 90-day holder anonymisation.
Database-boundary rules are in `tests/sql/db-rules.sql`.

## Still pending — needs a human

Sandbox verification is **done** (see the status section). What remains cannot be done from the
repository and has **not** been done:

- **Live keys.** Only a sandbox key exists, and only in `.env.local` on a developer machine;
  production holds none. Create a separate restricted key for live and confirm its permissions
  against this implementation, including connected-account access.
- **Live Connect configuration.** Connect is enabled on the *sandbox* only. The live platform
  still needs the same setup, with the same "customers buy from the seller" (direct charge)
  choice, and its own agreement to the Connected Account Agreement flow.
- **Webhook destinations.** Everything about the route was verified on 25 September 2026 against
  real deliveries forwarded by `stripe listen --forward-to … --forward-connect-to …` — signature,
  livemode, settlement, refunds, `account.updated`, refusal recording and duplicate dropping. What
  remains is infrastructure: create the persistent **sandbox** and **live** Connect destinations
  listening for `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` and
  `account.updated`, and put their signing secrets in the deployment's environment as
  `STRIPE_WEBHOOK_SECRET` / `STRIPE_WEBHOOK_SECRET_CONNECT`. Do not deploy short-lived CLI
  credentials. The livemode *refusal* path (a live delivery hitting a test deployment) cannot be
  exercised without a live key.
- ~~**A decision on the merchant-creation idempotency key.**~~ Taken: the key carries a
  failed-attempt counter (defect 2 above). A retry after a failure goes through, and a
  double-click still produces one account.
- ~~**A decision on the contribution ceiling.**~~ Taken: 50%, enforced in the route, the form and
  the fee arithmetic (see "The fee model"). What Stripe does at *capture* with a fee at or above
  the charge is still unverified, and is now unreachable from the product.
- **Currency minimums beyond usd.** usd is confirmed at $0.50; no other currency has been checked.
- **A live test purchase.** Not authorized and not performed. A real-money test needs explicit
  authorization for that transaction.

## Primary references

- [Charge types and fee responsibility](https://docs.stripe.com/connect/charges)
- [Connect pricing](https://stripe.com/connect/pricing)
- [Direct charges](https://docs.stripe.com/connect/direct-charges)
- [Accounts v2 merchant creation](https://docs.stripe.com/connect/saas/tasks/create)
- [Hosted onboarding and readiness](https://docs.stripe.com/connect/saas/tasks/onboard)
