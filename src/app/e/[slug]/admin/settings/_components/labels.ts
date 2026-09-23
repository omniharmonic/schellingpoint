/**
 * Constants that belong to the organizer settings page only (constants.ts is shared with
 * the creation wizard and `src/lib/sessions/constants.ts`, so additions go here).
 */

/** Anchor pills, in the order the sections render (spec §6). The danger zone is not navigation. */
export const SETTINGS_SECTIONS = [
  { id: 'basics', label: 'Basics' },
  { id: 'dates', label: 'Dates' },
  { id: 'venues', label: 'Venues & map' },
  { id: 'participation', label: 'Participation' },
  { id: 'voting', label: 'Voting' },
  { id: 'safeguards', label: 'Safeguards' },
  { id: 'branding', label: 'Branding' },
  { id: 'feed-network', label: 'Feed & network' },
  { id: 'lifecycle', label: 'Lifecycle' },
  { id: 'clone', label: 'Copy' },
] as const

/** Social links: storage keeps the four legacy keys plus `links` (preamble contract). */
export const LEGACY_SOCIAL_KEYS = ['twitter', 'telegram', 'discord', 'website'] as const
export type LegacySocialKey = (typeof LEGACY_SOCIAL_KEYS)[number]

/** Display label for each legacy key when it is shown in the single "Links" list. */
export const LEGACY_SOCIAL_LABELS: Record<LegacySocialKey, string> = {
  twitter: 'X',
  telegram: 'Telegram',
  discord: 'Discord',
  website: 'Website',
}

/** Typed labels (lower-cased) that map back onto a legacy key on save. */
export const LEGACY_SOCIAL_ALIASES: Record<string, LegacySocialKey> = {
  twitter: 'twitter',
  x: 'twitter',
  'x / twitter': 'twitter',
  'x/twitter': 'twitter',
  telegram: 'telegram',
  discord: 'discord',
  website: 'website',
  web: 'website',
  site: 'website',
}

export const MAX_SOCIAL_LINKS = 8
export const SOCIAL_LABEL_MAX = 40
export const SOCIAL_URL_MAX = 300
