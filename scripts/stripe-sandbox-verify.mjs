#!/usr/bin/env node
/**
 * Sandbox verification for the direct-charge model.
 *
 * This deployment holds no Stripe key, so nothing in the application has ever spoken to
 * Stripe. This script is what proves the model end to end the moment a **test** key exists.
 * It talks to Stripe only; it does not touch the database, the AppView or production.
 *
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/stripe-sandbox-verify.mjs
 *
 * Walk:
 *   1. create a merchant account — Accounts v2 with a merchant configuration, a full Stripe
 *      dashboard and fees/losses collected by Stripe (falling back to the v1 `controller`
 *      equivalent if v2 is not enabled for this platform, and saying so);
 *   2. print the Stripe-hosted onboarding link and wait while you complete it;
 *   3. poll readiness until charges and payouts are both enabled;
 *   4. create a $25 Checkout Session in that account's context at a 3% contribution —
 *      `application_fee_amount` 75, no `transfer_data`;
 *   5. print the payment URL and wait while you pay it with a test card (4242…);
 *   6. verify what actually happened: the session is complete and lives on the connected
 *      account, the charge's application fee is exactly 75 cents, and Stripe's own processing
 *      fee came off the *merchant's* balance transaction, not the platform's.
 *
 * Flags:
 *   --account acct_...   reuse a merchant created by an earlier run (skips step 1)
 *   --session cs_...     verify a session from an earlier run (skips to step 6)
 *   --amount 2500        ticket price in the smallest currency unit (default 2500)
 *   --percent 3          contribution percentage (default 3)
 *   --yes                do not wait for confirmation between steps
 *
 * It refuses to run with a live key. Nothing is printed that could expose a secret.
 */
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, argv, env, exit } from 'node:process'
import Stripe from 'stripe'

const API_VERSION = '2026-01-28.clover'

function flag(name, fallback = null) {
  const at = argv.indexOf(`--${name}`)
  if (at === -1) return fallback
  const value = argv[at + 1]
  return value && !value.startsWith('--') ? value : true
}

const key = env.STRIPE_SECRET_KEY
if (!key) {
  console.error('STRIPE_SECRET_KEY is not set. Export a *test* key (sk_test_… or rk_test_…) and run again.')
  exit(2)
}
if (/^(sk|rk)_live_/.test(key)) {
  console.error('This is a live key. Sandbox verification refuses to move real money; export a test key instead.')
  exit(2)
}
if (!/^(sk|rk)_test_/.test(key)) {
  console.error('That does not look like a Stripe secret key. Expected sk_test_… or rk_test_…')
  exit(2)
}

const stripe = new Stripe(key, { apiVersion: API_VERSION, maxNetworkRetries: 2, timeout: 20000 })
const amount = Number(flag('amount', '2500'))
const percent = Number(flag('percent', '3'))
const assumeYes = flag('yes', false) === true
const rl = createInterface({ input: stdin, output: stdout })

const money = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)

/** The application's own fee rule (src/lib/payments/format.ts), restated so the two can be compared. */
function contribution(cents, pct) {
  if (cents === 0) return 0
  return Math.min(cents, Math.max(1, Math.round((cents * pct) / 100)))
}

async function pause(question) {
  if (assumeYes) return
  await rl.question(`\n${question}\nPress Enter when done… `)
}

function ok(line) { console.log(`  ✓ ${line}`) }
function bad(line) { console.log(`  ✗ ${line}`) }

let failures = 0
function check(condition, line) {
  if (condition) ok(line)
  else { bad(line); failures += 1 }
}

// ---------------------------------------------------------------------------
// 1. Merchant account
// ---------------------------------------------------------------------------

async function createMerchant() {
  try {
    const account = await stripe.v2.core.accounts.create({
      display_name: 'unconference sandbox merchant',
      dashboard: 'full',
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      metadata: { purpose: 'unconference sandbox verification' },
    })
    console.log(`  created via Accounts v2: ${account.id}`)
    return { accountId: account.id, api: 'v2' }
  } catch (err) {
    console.log(`  Accounts v2 was not usable (${err?.code ?? err?.type ?? 'error'}); falling back to v1 controller accounts.`)
    const account = await stripe.accounts.create({
      controller: {
        fees: { payer: 'account' },
        losses: { payments: 'stripe' },
        stripe_dashboard: { type: 'full' },
        requirement_collection: 'stripe',
      },
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { purpose: 'unconference sandbox verification' },
    })
    console.log(`  created via Accounts v1: ${account.id}`)
    return { accountId: account.id, api: 'v1' }
  }
}

async function onboardingLink(accountId, api) {
  const returnUrl = 'https://unconference.events/e/sandbox/admin/tickets?stripe=return'
  const refreshUrl = 'https://unconference.events/e/sandbox/admin/tickets?stripe=refresh'
  if (api === 'v2') {
    try {
      const link = await stripe.v2.core.accountLinks.create({
        account: accountId,
        use_case: {
          type: 'account_onboarding',
          account_onboarding: { configurations: ['merchant'], refresh_url: refreshUrl, return_url: returnUrl },
        },
      })
      return link.url
    } catch {
      // fall through to v1
    }
  }
  const link = await stripe.accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: refreshUrl,
    return_url: returnUrl,
  })
  return link.url
}

async function readiness(accountId) {
  const account = await stripe.accounts.retrieve(accountId)
  return {
    chargesEnabled: Boolean(account.charges_enabled),
    payoutsEnabled: Boolean(account.payouts_enabled),
    due: [...(account.requirements?.currently_due ?? []), ...(account.requirements?.past_due ?? [])],
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Stripe sandbox verification — direct charges, test mode only\n')

  let accountId = typeof flag('account') === 'string' ? flag('account') : null
  let api = 'v1'
  let sessionId = typeof flag('session') === 'string' ? flag('session') : null

  if (!sessionId) {
    if (!accountId) {
      console.log('1. Creating a merchant account')
      const created = await createMerchant()
      accountId = created.accountId
      api = created.api
      console.log(`\n   Reuse it with:  --account ${accountId}`)
    } else {
      console.log(`1. Reusing merchant account ${accountId}`)
    }

    const before = await readiness(accountId)
    if (!before.chargesEnabled || !before.payoutsEnabled) {
      console.log('\n2. Stripe-hosted onboarding. Open this link and complete it as the organizer would:\n')
      console.log(`   ${await onboardingLink(accountId, api)}\n`)
      console.log('   Stripe collects country, legal identity and payout details itself.')
      console.log('   This application attests to nothing on the merchant\'s behalf.')
      await pause('Complete onboarding in the browser.')
    }

    console.log('\n3. Readiness')
    let ready = await readiness(accountId)
    for (let attempt = 0; attempt < 10 && (!ready.chargesEnabled || !ready.payoutsEnabled); attempt++) {
      await new Promise((r) => setTimeout(r, 3000))
      ready = await readiness(accountId)
    }
    check(ready.chargesEnabled, 'charges_enabled')
    check(ready.payoutsEnabled, 'payouts_enabled')
    if (ready.due.length) console.log(`  still due: ${ready.due.slice(0, 8).join(', ')}`)
    if (!ready.chargesEnabled) {
      console.log('\nThe merchant cannot take charges yet, so the app would refuse paid sales here too. Stopping.')
      rl.close()
      exit(1)
    }

    console.log(`\n4. Checkout Session: ${money(amount)} at ${percent}%`)
    const fee = contribution(amount, percent)
    console.log(`   application_fee_amount = ${fee} (${money(fee)}), no transfer_data`)
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'usd',
              product_data: { name: 'Sandbox admission', description: 'unconference sandbox verification' },
              unit_amount: amount,
            },
            quantity: 1,
          },
        ],
        success_url: 'https://unconference.events/e/sandbox/tickets/success',
        cancel_url: 'https://unconference.events/e/sandbox/tickets?cancelled=true',
        payment_intent_data: { application_fee_amount: fee },
      },
      { stripeAccount: accountId },
    )
    sessionId = session.id
    console.log('\n5. Pay it with a test card (4242 4242 4242 4242, any future expiry, any CVC):\n')
    console.log(`   ${session.url}\n`)
    console.log(`   Verify later with:  --account ${accountId} --session ${sessionId}`)
    await pause('Complete the payment in the browser.')
  } else {
    if (!accountId) {
      console.error('--session needs --account too: a direct-charge session only exists in its own account context.')
      rl.close()
      exit(2)
    }
    console.log(`Verifying session ${sessionId} on ${accountId}`)
  }

  console.log('\n6. What actually happened')
  const paid = await stripe.checkout.sessions.retrieve(
    sessionId,
    { expand: ['payment_intent.latest_charge.balance_transaction', 'payment_intent.latest_charge.application_fee'] },
    { stripeAccount: accountId },
  )
  check(paid.status === 'complete', `session status = ${paid.status}`)
  check(paid.payment_status === 'paid', `payment_status = ${paid.payment_status}`)
  check(paid.amount_total === amount, `amount_total = ${money(paid.amount_total ?? 0)} (expected ${money(amount)})`)

  const intent = paid.payment_intent
  const charge = intent && typeof intent !== 'string' ? intent.latest_charge : null
  if (!charge || typeof charge === 'string') {
    bad('the charge could not be expanded; re-run with --session once the payment has settled')
    failures += 1
  } else {
    const expectedFee = contribution(amount, percent)
    check(charge.application_fee_amount === expectedFee,
      `application_fee_amount = ${money(charge.application_fee_amount ?? 0)} (expected ${money(expectedFee)})`)
    check(!charge.transfer_data, 'no transfer_data: this is a direct charge, not a destination charge')
    check(charge.on_behalf_of === null || charge.on_behalf_of === undefined || charge.on_behalf_of === accountId,
      'the merchant is the merchant of record')

    const bt = charge.balance_transaction
    if (bt && typeof bt !== 'string') {
      // The processing fee sits on the *merchant's* balance transaction. That is the whole
      // point of the model: a 1% contribution can never cost the platform money.
      console.log(`  merchant balance transaction: gross ${money(bt.amount)}, Stripe fee ${money(bt.fee)}, net ${money(bt.net)}`)
      check(bt.fee > 0, 'Stripe processing fees were charged to the merchant account')
      const feeDetail = (bt.fee_details ?? []).find((d) => d.type === 'application_fee')
      check(Boolean(feeDetail), 'the platform contribution appears as an application fee on the merchant ledger')
      if (feeDetail) {
        check(feeDetail.amount === contribution(amount, percent),
          `application fee on the ledger = ${money(feeDetail.amount)}`)
      }
    } else {
      console.log('  (balance transaction not expanded; re-run in a moment for the fee breakdown)')
    }
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`)
  console.log('Nothing in the database was touched: this script verifies Stripe only.')
  rl.close()
  exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(`\nFailed: ${err?.type ?? ''} ${err?.code ?? ''} ${err?.message ?? err}`)
  rl.close()
  exit(1)
})
