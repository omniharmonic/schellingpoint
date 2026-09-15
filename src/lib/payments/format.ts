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
 * Platform application fee: 5% of the ticket price + 50 cents, in cents.
 * Used as `application_fee_amount` on destination charges to connected accounts, and by the
 * revenue dashboard to show net amounts.
 */
export function calculatePlatformFee(amountCents: number): number {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return 0
  return Math.round(amountCents * 0.05) + 50
}
