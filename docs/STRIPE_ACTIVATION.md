# Stripe activation requirements

Status, 15 September 2026: **not activated**. The operator has selected the platform account.
The browser is signed in,
but CLI pairing has not stored credentials; Stripe is requesting identity verification.
No production keys, webhook destinations, Connect settings or financial transactions were
changed during this activation attempt.

## Fee model must be corrected before live sales

The deployed code creates Express accounts and destination charges. Stripe debits processing
fees from the platform for destination charges. The application fee is the organizer's chosen
percentage only, so a 1% contribution can produce negative platform revenue. The existing
revenue screen reports application fees, not platform profit.

The intended implementation is direct charges on the organizer's merchant account, with
Stripe collecting processing fees from that account and unconference receiving the selected
application fee. Organizer copy must distinguish the contribution from processing fees;
do not silently add a fixed surcharge or increase the selected percentage.

## Implementation and verification scope

1. Inspect the selected platform's Connect configuration and sandbox availability after
   authentication. Verify the actual fee and loss responsibility settings. New merchant
   accounts should use Accounts v2 and hosted onboarding with a full Stripe dashboard,
   `fees_collector: stripe` and `losses_collector: stripe`. Let onboarding collect country,
   legal identity and payout information; do not invent or attest to business details.
2. Create Checkout sessions in the connected account's API context, using an application fee
   without `transfer_data`. Retrieve and expire each session in its original account context.
   Preserve compatibility for pre-existing platform-scoped sessions if any exist.
3. Store an immutable, private checkout reference binding session, connected account, event,
   tier, holder, price, currency and contribution. A mutable event payout account is not a
   sufficient reference. Connect webhook signatures authenticate Stripe delivery, but a
   connected merchant can create its own payments and metadata: never grant admission from
   metadata alone. Verify both the event account and session against the application-created
   reference before settlement, expiry or refund processing.
4. Reconcile reference retention with the existing sweep that deletes expired ticket holds.
   Delayed payment settlement must still verify its original quote and connected account.
   Preserve privacy requirements at archival; do not create an indefinite identity-linked
   payment ledger. Existing refund fingerprints must continue to prevent completion replays
   after a full refund.
5. Configure separate sandbox/live Connect webhook destinations and dedicated restricted
   server keys. Do not deploy short-lived CLI credentials. Confirm exact API permissions
   against the implementation, including connected-account access. Keep secrets out of logs,
   source, browser JavaScript and chat.
6. Verify organizer onboarding and capability readiness, successful and declined Checkout,
   delayed payment, duplicate/out-of-order delivery, expiry/replacement, cross-account
   rejection, full refund and fee refund behavior. Direct-charge refunds require the original
   connected-account context; application fees are not automatically refunded. Verify supported
   currencies' minimum charge amounts and the upper contribution boundary against Stripe.
7. Verify actual sandbox balances: a $25 sale at 1% must credit $0.25 to the platform, while
   processing fees are deducted from the organizer. Compare ticket admission and organizer
   revenue with Stripe. Run the repository verification gate, deploy on `atproto`, then check
   production health and configuration. Do not make a real-money test purchase without
   authorization for that transaction.

## Primary references

- [Charge types and fee responsibility](https://docs.stripe.com/connect/charges)
- [Connect pricing](https://stripe.com/connect/pricing)
- [Direct charges](https://docs.stripe.com/connect/direct-charges)
- [Accounts v2 merchant creation](https://docs.stripe.com/connect/saas/tasks/create)
- [Hosted onboarding and readiness](https://docs.stripe.com/connect/saas/tasks/onboard)

These are pending requirements, not a claim that direct charges, Accounts v2 or provider-level
verification have shipped.
