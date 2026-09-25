/** Price formatting shared by server and browser (no Stripe import). */
export function formatPrice(cents: number, currency: string = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/**
 * The ceiling on the organizer's voluntary contribution.
 *
 * Stripe accepts an `application_fee_amount` equal to the charge, and even one larger than it,
 * without complaint at session-create time — the only guard is ours. Above 50% the organizer is
 * giving away more than they keep, and at 100% they owe Stripe's processing fee out of pocket on
 * every ticket they sell. So 50 is where the form, the route and the charge itself stop.
 */
export const MAX_CONTRIBUTION_PERCENT = 50

/**
 * The range the column accepts (`events.platform_fee_percent`, 0014): 1–100 with up to two
 * decimal places. Rows written before the ceiling existed can still hold more than
 * `MAX_CONTRIBUTION_PERCENT`, which is why this is not the same question as
 * `validContributionPercent` below — `calculatePlatformFee` must keep working on them.
 */
export function validPlatformFeePercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100
    && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001
}

/** What an organizer may *choose* today: 1% to `MAX_CONTRIBUTION_PERCENT`. Validated at every write. */
export function validContributionPercent(value: unknown): value is number {
  return validPlatformFeePercent(value) && value <= MAX_CONTRIBUTION_PERCENT
}

/**
 * The most the platform may ever take from one ticket: half the price, rounded *down* so the
 * share can never tip past 50% on an odd number of cents. This is the clamp of last resort — it
 * holds whatever a stored percentage says, so a row written before the ceiling existed cannot
 * take more than half, and no arithmetic here can leave the merchant owing money on the price.
 */
export function maxPlatformFeeCents(amountCents: number): number {
  return Math.floor((amountCents * MAX_CONTRIBUTION_PERCENT) / 100)
}

/**
 * The contribution on one ticket: `round(price x percent / 100)`, clamped to
 * `maxPlatformFeeCents`.
 *
 * There is no minimum. A ticket small enough that the rounded contribution is zero contributes
 * zero — rounding a sub-half-cent share up to a whole cent would be a surcharge the organizer
 * did not choose, which is precisely what this fee model promises not to do.
 *
 * A percentage above the ceiling is not an error here: the column still permits one (0014) and a
 * gathering may hold such a row from before the ceiling existed. It is charged as 50%, and the
 * admin page asks the organizer to lower it.
 */
export function calculatePlatformFee(amountCents: number, percent: number = 1): number {
  if (!validPlatformFeePercent(percent)) throw new Error('Choose a platform contribution from 1% to 100%, with up to two decimal places')
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('Ticket amount must be a non-negative whole number')
  if (amountCents === 0) return 0
  return Math.min(maxPlatformFeeCents(amountCents), Math.round(amountCents * percent / 100))
}
