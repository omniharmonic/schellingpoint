/** Price formatting shared by server and browser (no Stripe import). */
export function formatPrice(cents: number, currency: string = 'usd'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency.toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

/** Organizer-selected percentage; no fixed surcharge. Values are validated at every write. */
export function validPlatformFeePercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 100
    && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001
}

export function calculatePlatformFee(amountCents: number, percent: number = 1): number {
  if (!validPlatformFeePercent(percent)) throw new Error('Choose a platform contribution from 1% to 100%, with up to two decimal places')
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error('Ticket amount must be a non-negative whole number')
  if (amountCents === 0) return 0
  return Math.min(amountCents, Math.max(1, Math.round(amountCents * percent / 100)))
}
