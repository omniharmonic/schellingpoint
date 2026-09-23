# Stripe activation

Status, 23 September 2026: **the direct-charge model is implemented and tested; payments are
still not activated.** No Stripe key exists in this repository, in the local stack or in
production. Nothing in this document claims that money has moved, that Connect settings were
inspected, or that a real account was verified — none of that has happened.

What changed: the code no longer creates Express accounts or destination charges. It creates
merchant accounts through Accounts v2 with Stripe collecting fees and losses, and it charges
tickets **directly on the organizer's own account** with the contribution as an application
fee. Every path is covered by tests that substitute Stripe at the application's own seams, so
the behaviour below is verified logic rather than intention — but Stripe itself has never
answered any of it. `scripts/stripe-sandbox-verify.mjs` is the script that will close that gap
the moment a test key exists.

## The fee model

The organizer is the **merchant of record**. A Checkout Session is created in their account's
API context (`{ stripeAccount }`), with `payment_intent_data.application_fee_amount` set to
`round(price × contribution%)` — exactly that, with no minimum, so a ticket too small to round
up to a whole cent contributes nothing rather than being charged a cent the organizer never
chose — and **no `transfer_data`**. Stripe therefore collects its
processing fees from the organizer's balance, and unconference receives the contribution and
nothing else. A 1% contribution on a $25 ticket is 25 cents of platform revenue, and cannot be
a platform loss — which was the defect in the destination-charge implementation this replaces.

There is no fixed surcharge and nothing is added to the buyer's price. Organizer-facing copy
says plainly that the contribution is separate from Stripe's processing fees.

## Implemented

1. **Merchant accounts.** `stripeMerchantGateway()` (`src/lib/payments/stripe.ts`) creates
   accounts with `POST /v2/core/accounts`: a merchant configuration requesting `card_payments`,
   `dashboard: 'full'`, and `defaults.responsibilities` of `fees_collector: 'stripe'` /
   `losses_collector: 'stripe'`. Onboarding is `POST /v2/core/account_links` with
   `use_case.type: 'account_onboarding'` and `configurations: ['merchant']` — Stripe collects
   country, legal identity and payout details itself; the application attests to nothing.
   If v2 is not enabled for the platform (the create call fails with an invalid-request or
   permission error), it falls back to the v1 equivalent, `POST /v1/accounts` with
   `controller: { fees: { payer: 'account' }, losses: { payments: 'stripe' },
   stripe_dashboard: { type: 'full' }, requirement_collection: 'stripe' }`, and logs which API
   was used. `STRIPE_ACCOUNTS_API=v1` forces the fallback. Readiness reads `charges_enabled`
   and `payouts_enabled` (v1) or the merchant/recipient configuration statuses (v2).
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

`tests/payments-direct.spec.ts` (13 cases) and the payment cases in `tests/ticket-audit.spec.ts`
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
at every stage; and the 90-day holder anonymisation. Database-boundary rules are in
`tests/sql/db-rules.sql`.

## Still pending — needs a human

These cannot be done from the repository and have **not** been done:

- **Keys.** No `STRIPE_SECRET_KEY` exists anywhere. Create a restricted key in the sandbox, run
  the sandbox verification below, then create a separate restricted key for live.
- **Connect configuration.** Nobody has inspected the platform's Connect settings, confirmed
  whether Accounts v2 is enabled for it, or confirmed the platform's own fee and loss
  responsibility settings. The v1 fallback exists precisely because that is unknown.
- **Sandbox verification.** `STRIPE_SECRET_KEY=sk_test_… node scripts/stripe-sandbox-verify.mjs`
  walks: create merchant → print the hosted onboarding link → poll readiness → create a $25
  Checkout Session at 3% in the merchant's context → print the payment URL → after you pay with
  a test card, verify the session, the 75-cent application fee, the absence of `transfer_data`,
  and that Stripe's processing fee came off the *merchant's* balance transaction. It refuses to
  run with a live key. Nothing in the database is touched.
- **Webhook destinations.** Separate sandbox and live Connect destinations must be created,
  listening for `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
  `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` and
  `account.updated`. Confirm the restricted keys' permissions against this implementation,
  including connected-account access. Do not deploy short-lived CLI credentials.
- **Currency minimums and the contribution ceiling.** Supported currencies' minimum charge
  amounts, and the behaviour at a 100% contribution, have not been checked against Stripe.
- **A live test purchase.** Not authorized and not performed. A real-money test needs explicit
  authorization for that transaction.

## Primary references

- [Charge types and fee responsibility](https://docs.stripe.com/connect/charges)
- [Connect pricing](https://stripe.com/connect/pricing)
- [Direct charges](https://docs.stripe.com/connect/direct-charges)
- [Accounts v2 merchant creation](https://docs.stripe.com/connect/saas/tasks/create)
- [Hosted onboarding and readiness](https://docs.stripe.com/connect/saas/tasks/onboard)
