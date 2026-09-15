/**
 * Gathering policy thresholds (spec §8; `freeschool.draft.policy#thresholds`).
 *
 * Client-safe: the creation wizard, Event settings and the API routes share these
 * bounds, which mirror `lexicons/vendor/freeschool/policy.json` and the
 * `events_policy_thresholds_check` constraint in `db/migrations/0007_gathering_policy.sql`.
 */

export interface GatheringPolicyThresholds {
  /** Organizers who must approve moving or cancelling a published session (1..5). */
  destructiveActionStewards: number
  /** Fewest distinct voters before a count is shown for anything (2..10). */
  feedbackK: number
  /** Let qualifying members' roles reach the network as claims (their own opt-in still applies). */
  publishRoles: boolean
}

export const POLICY_THRESHOLD_BOUNDS = {
  destructiveActionStewards: { min: 1, max: 5 },
  feedbackK: { min: 2, max: 10 },
} as const

export const DEFAULT_POLICY_THRESHOLDS: Readonly<GatheringPolicyThresholds> = Object.freeze({
  destructiveActionStewards: 2,
  feedbackK: 3,
  publishRoles: false,
})

export type PolicyThresholdField = keyof GatheringPolicyThresholds

export type PolicyThresholdResult =
  | { ok: true; value: GatheringPolicyThresholds }
  | { ok: false; error: string; field: PolicyThresholdField | 'policy_thresholds' }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

/**
 * Validate a (possibly partial) thresholds object merged over `base`. Unknown keys are
 * refused rather than silently dropped, so a typo never looks like a saved setting.
 */
export function validatePolicyThresholds(
  input: unknown,
  base: GatheringPolicyThresholds = DEFAULT_POLICY_THRESHOLDS,
): PolicyThresholdResult {
  if (!isRecord(input)) return { ok: false, error: 'Policy thresholds must be an object.', field: 'policy_thresholds' }
  for (const key of Object.keys(input)) {
    if (!['destructiveActionStewards', 'feedbackK', 'publishRoles'].includes(key)) {
      return { ok: false, error: `Unknown policy setting: ${key}.`, field: 'policy_thresholds' }
    }
  }
  const merged = { ...base, ...input } as Record<string, unknown>
  const { destructiveActionStewards: s, feedbackK: k } = POLICY_THRESHOLD_BOUNDS
  if (!intInRange(merged.destructiveActionStewards, s.min, s.max)) {
    return {
      ok: false,
      error: `Approvals needed must be a whole number from ${s.min} to ${s.max}.`,
      field: 'destructiveActionStewards',
    }
  }
  if (!intInRange(merged.feedbackK, k.min, k.max)) {
    return {
      ok: false,
      error: `The privacy threshold must be a whole number from ${k.min} to ${k.max}.`,
      field: 'feedbackK',
    }
  }
  if (typeof merged.publishRoles !== 'boolean') {
    return { ok: false, error: 'Publishing roles must be on or off.', field: 'publishRoles' }
  }
  return {
    ok: true,
    value: {
      destructiveActionStewards: merged.destructiveActionStewards,
      feedbackK: merged.feedbackK,
      publishRoles: merged.publishRoles,
    },
  }
}

/** Read thresholds from a stored row, falling back to defaults for anything malformed. */
export function readPolicyThresholds(stored: unknown): GatheringPolicyThresholds {
  const result = validatePolicyThresholds(isRecord(stored) ? stored : {}, DEFAULT_POLICY_THRESHOLDS)
  return result.ok ? result.value : { ...DEFAULT_POLICY_THRESHOLDS }
}
