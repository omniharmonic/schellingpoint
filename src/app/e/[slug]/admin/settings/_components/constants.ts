import type { VotingMechanism } from '@/types/event'

export const VOTING_MECHANISMS: { value: VotingMechanism; label: string; description: string }[] = [
  { value: 'quadratic', label: 'Quadratic', description: 'Cost grows with conviction: 1 vote = 1 credit, 2 votes = 4, 3 votes = 9. Rewards broad support.' },
  { value: 'linear', label: 'Linear', description: '1 vote = 1 credit. Simple and direct.' },
  { value: 'approval', label: 'Approval', description: 'One vote per session, one credit each. Support as many sessions as your budget allows.' },
]

export const SESSION_FORMATS: { value: string; label: string }[] = [
  { value: 'talk', label: 'Talk' },
  { value: 'workshop', label: 'Workshop' },
  { value: 'panel', label: 'Panel' },
  { value: 'discussion', label: 'Discussion' },
  { value: 'demo', label: 'Demo' },
  { value: 'fireside', label: 'Fireside chat' },
  { value: 'ceremony', label: 'Ceremony' },
]

export const SESSION_DURATIONS: number[] = [15, 30, 45, 60, 90, 120]

export const THEME_MODES: { value: 'light' | 'dark' | 'system'; label: string; description: string }[] = [
  { value: 'light', label: 'Light', description: 'Bright surfaces with dark text.' },
  { value: 'dark', label: 'Dark', description: 'Deep surfaces with light text.' },
  { value: 'system', label: 'Match device', description: 'Follow each visitor’s device preference.' },
]

export const DEFAULT_COLORS = { primary: '#246653', secondary: '#E8F1EB', accent: '#DCD5ED' }

export interface ThemePreset {
  name: string
  category: 'Earth' | 'Dark' | 'Cool' | 'Warm'
  primary: string
  secondary: string
  accent: string
  mode: 'light' | 'dark'
  description: string
}

export const THEME_PRESET_CATEGORIES = ['Cool', 'Earth', 'Dark', 'Warm'] as const

/**
 * Curated palettes shared by the creation wizard and organizer settings, so a preset chosen
 * at creation can be reselected later. Each has a clear identity and restrained saturation.
 */
export const THEME_PRESETS: ThemePreset[] = [
  { name: 'Commons', category: 'Cool', primary: '#246653', secondary: '#E8F1EB', accent: '#DCD5ED', mode: 'light', description: 'Spruce, mineral white, and lilac. Space for people and ideas.' },
  { name: 'Nordic', category: 'Cool', primary: '#5B7DB1', secondary: '#2C3E50', accent: '#A9BCD0', mode: 'light', description: 'Slate blue and fog. Understated and precise.' },
  { name: 'Harbor', category: 'Cool', primary: '#1F6E8C', secondary: '#0E4B5A', accent: '#E8C547', mode: 'light', description: 'Deep teal with a brass accent.' },
  { name: 'Terra', category: 'Earth', primary: '#B97F5A', secondary: '#6B5744', accent: '#D4A373', mode: 'light', description: 'Warm terracotta and oak. Grounded and human.' },
  { name: 'Parchment', category: 'Earth', primary: '#7D6B55', secondary: '#4A4238', accent: '#C9A87C', mode: 'light', description: 'Aged paper and honey. Quiet and considered.' },
  { name: 'Sage', category: 'Earth', primary: '#6B8E7F', secondary: '#3E5349', accent: '#C8B68B', mode: 'light', description: 'Moss and cream. Botanical and calm.' },
  { name: 'Midnight', category: 'Dark', primary: '#7C8BFF', secondary: '#1A2238', accent: '#F5C98F', mode: 'dark', description: 'Deep indigo with a warm highlight. Editorial dark mode.' },
  { name: 'Noir', category: 'Dark', primary: '#D4AF37', secondary: '#111827', accent: '#6B7280', mode: 'dark', description: 'Graphite and gold. Minimal and cinematic.' },
  { name: 'Rose', category: 'Warm', primary: '#B56576', secondary: '#6D4C5A', accent: '#EAAC8B', mode: 'light', description: 'Dusty rose and peach. Muted and warm.' },
  { name: 'Dusk', category: 'Warm', primary: '#8E7CC3', secondary: '#534678', accent: '#F4A261', mode: 'dark', description: 'Amethyst and amber. Reflective evening light.' },
]

/** True when the three colors match a preset (case-insensitive). */
export function matchingThemePreset(theme: { primary: string; secondary: string; accent: string }): ThemePreset | undefined {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  return THEME_PRESETS.find(p => same(p.primary, theme.primary) && same(p.secondary, theme.secondary) && same(p.accent, theme.accent))
}

/** Black or white text for a hex background (used by color previews). */
export function contrastingTextColor(hexColor: string): string {
  const hex = hexColor.replace('#', '')
  const full = hex.length === 3 ? hex.split('').map(c => c + c).join('') : hex
  const r = parseInt(full.substring(0, 2), 16), g = parseInt(full.substring(2, 4), 16), b = parseInt(full.substring(4, 6), 16)
  if ([r, g, b].some(Number.isNaN)) return '#FFFFFF'
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5 ? '#000000' : '#FFFFFF'
}

/** The social-links contract shared by the wizard, organizer settings and the footer. */
export const SOCIAL_LINKS_MAX = 8
export const LEGACY_SOCIAL_KEYS = ['twitter', 'telegram', 'discord', 'website'] as const
export type LegacySocialKey = (typeof LEGACY_SOCIAL_KEYS)[number]

/** Map a typed label to a legacy `theme.social` key ("X" and "Twitter" both mean `twitter`). */
export function legacySocialKey(label: string): LegacySocialKey | null {
  const key = label.trim().toLowerCase()
  if (key === 'x' || key === 'twitter' || key === 'x / twitter' || key === 'twitter / x') return 'twitter'
  if (key === 'telegram') return 'telegram'
  if (key === 'discord') return 'discord'
  if (key === 'website' || key === 'web' || key === 'site') return 'website'
  return null
}

const LEGACY_SOCIAL_LABELS: Record<LegacySocialKey, string> = { twitter: 'X', telegram: 'Telegram', discord: 'Discord', website: 'Website' }

export interface SocialLinkEntry { label: string; url: string }

/** Merge the legacy keys and `links` into the one list the UI edits and renders. */
export function socialToList(social: { twitter?: string; telegram?: string; discord?: string; website?: string; links?: SocialLinkEntry[] } | null | undefined): SocialLinkEntry[] {
  if (!social) return []
  const list: SocialLinkEntry[] = []
  for (const key of LEGACY_SOCIAL_KEYS) {
    const url = social[key]
    if (url && url.trim()) list.push({ label: LEGACY_SOCIAL_LABELS[key], url: url.trim() })
  }
  for (const entry of social.links ?? []) {
    if (entry && entry.url && entry.url.trim()) list.push({ label: (entry.label || '').trim() || 'Link', url: entry.url.trim() })
  }
  return list
}

/** Split the edited list back into storage: legacy keys when the label matches, `links` otherwise. */
export function listToSocial(list: SocialLinkEntry[]): { twitter: string; telegram: string; discord: string; website: string; links: SocialLinkEntry[] } {
  const out = { twitter: '', telegram: '', discord: '', website: '', links: [] as SocialLinkEntry[] }
  for (const entry of list) {
    const url = (entry.url || '').trim()
    const label = (entry.label || '').trim()
    if (!url) continue
    const key = legacySocialKey(label)
    if (key && !out[key]) out[key] = url
    else if (out.links.length < SOCIAL_LINKS_MAX) out.links.push({ label: label || 'Link', url })
  }
  return out
}
