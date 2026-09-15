import 'server-only'

/**
 * Validation for organizer-edited ticket tiers. Returns the columns to write, or a field error.
 */

export interface TierInput {
  name: string
  description: string | null
  price_cents: number
  currency: string
  quantity_total: number | null
  sale_starts_at: string | null
  sale_ends_at: string | null
  is_active: boolean
  allows_proposals: boolean
  allows_voting: boolean
  vote_credits_override: number | null
  display_order: number
}

export type TierValidation =
  | { ok: true; value: Partial<TierInput> }
  | { ok: false; error: string; field: string }

const MAX_PRICE_CENTS = 100_000_00

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function isoOrNull(v: unknown): string | null | undefined {
  if (v === null || v === '') return null
  if (typeof v !== 'string') return undefined
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** `partial` for PATCH: only present keys are validated and returned. */
export function validateTier(raw: unknown, partial: boolean): TierValidation {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Invalid JSON body', field: 'body' }
  const b = raw as Record<string, unknown>
  const out: Partial<TierInput> = {}
  const has = (k: string) => b[k] !== undefined

  if (!partial || has('name')) {
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.trim().length > 120) {
      return { ok: false, error: 'Name is required (at most 120 characters)', field: 'name' }
    }
    out.name = b.name.trim()
  }
  if (has('description')) {
    if (b.description !== null && (typeof b.description !== 'string' || b.description.length > 2000)) {
      return { ok: false, error: 'Description must be at most 2000 characters', field: 'description' }
    }
    out.description = typeof b.description === 'string' && b.description.trim() ? b.description.trim() : null
  } else if (!partial) out.description = null
  if (!partial || has('price_cents')) {
    const price = b.price_cents ?? 0
    if (!isInt(price) || price < 0 || price > MAX_PRICE_CENTS) {
      return { ok: false, error: 'Price must be a whole number of cents between 0 and 10,000,000', field: 'price_cents' }
    }
    // Stripe's minimum charge is 50 cents in USD; anything between 0 and that cannot be paid.
    if (price > 0 && price < 50) return { ok: false, error: 'Paid tickets must cost at least 0.50', field: 'price_cents' }
    out.price_cents = price
  }
  if (has('currency')) {
    if (typeof b.currency !== 'string' || !/^[a-z]{3}$/i.test(b.currency)) {
      return { ok: false, error: 'Currency must be a 3-letter code', field: 'currency' }
    }
    out.currency = b.currency.toLowerCase()
  }
  if (!partial || has('quantity_total')) {
    const q = b.quantity_total ?? null
    if (q !== null && (!isInt(q) || q < 1 || q > 1_000_000)) {
      return { ok: false, error: 'Quantity must be empty (unlimited) or a positive whole number', field: 'quantity_total' }
    }
    out.quantity_total = q as number | null
  }
  for (const key of ['sale_starts_at', 'sale_ends_at'] as const) {
    if (!partial || has(key)) {
      const v = isoOrNull(b[key] ?? null)
      if (v === undefined) return { ok: false, error: 'Dates must be ISO 8601', field: key }
      out[key] = v
    }
  }
  if (out.sale_starts_at && out.sale_ends_at && out.sale_ends_at <= out.sale_starts_at) {
    return { ok: false, error: 'Sales must end after they start', field: 'sale_ends_at' }
  }
  for (const key of ['is_active', 'allows_proposals', 'allows_voting'] as const) {
    if (has(key)) {
      if (typeof b[key] !== 'boolean') return { ok: false, error: `${key} must be a boolean`, field: key }
      out[key] = b[key] as boolean
    }
  }
  if (has('vote_credits_override')) {
    const v = b.vote_credits_override
    if (v !== null && (!isInt(v) || v < 0 || v > 100_000)) {
      return { ok: false, error: 'Vote credits must be empty or a whole number', field: 'vote_credits_override' }
    }
    out.vote_credits_override = v as number | null
  }
  if (has('display_order')) {
    if (!isInt(b.display_order) || b.display_order < 0 || b.display_order > 10_000) {
      return { ok: false, error: 'display_order must be a whole number', field: 'display_order' }
    }
    out.display_order = b.display_order
  }
  return { ok: true, value: out }
}
