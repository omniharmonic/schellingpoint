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
