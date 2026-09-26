'use client'

import * as React from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  Loader2,
  User,
  Building2,
  Rocket,
  Send,
  Hexagon,
  Hash,
  Plus,
  Camera,
  AtSign,
  BadgeCheck,
  RefreshCw,
  Compass,
  Bell,
  Bot,
  Copy,
  Check,
  CalendarClock,
  Download,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { RemovableChip } from '@/components/ui/removable-chip'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { WarningBox } from '@/components/WarningBox'
import { InstallAppRow } from '@/components/InstallApp'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch, ApiError } from '@/lib/api/client'
import { HELP_PRIVACY, LEARN_MORE } from '@/lib/labels'
import { cn } from '@/lib/utils'
import { uploadAvatar } from '@/lib/storage/upload'

/**
 * Account: the one place a person edits their profile, identity and notification settings
 * (release design §3 "Account"). Rendered as a dialog from the workspace shells and as the
 * `/account` page; both use `AccountPanel`.
 *
 * Tabs
 *   Profile        name, photo, bio, organization, "What are you building?", "What I'm looking
 *                  for" (§6), messaging handle (§4 generic naming), interests, and what the
 *                  viewer shares in the gathering in view — directory listing, messaging handle
 *                  and email address, each the viewer's own per-gathering switch (design §3.3).
 *   Identity       handle/DID, "Re-sync from my Bluesky profile" (OAuth accounts), publish
 *                  proposals to my repo, take ownership (custodial), ENS.
 *   Notifications  a link to the per-gathering preferences page.
 *
 * Nothing auto-closes on save; dismissing with unsaved profile edits asks first.
 */

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
  /** The gathering the dialog is opened inside; falls back to the `[slug]` route param. */
  gathering?: { slug: string; name: string | null } | null
}

/** Shape of GET /api/atproto/me. */
interface AtIdentity {
  configured: boolean
  oauthMode: 'confidential' | 'loopback'
  linked: boolean
  did: string | null
  handle: string | null
  kind: 'custodial' | 'oauth' | null
  owned: boolean
  publishProposals: boolean
  /** Custodial opt-in: an `app.bsky.actor.profile` record in the person's own repo (design §5.5). */
  publishProfile: boolean
  profileRecordUri: string | null
}

/** Shape of GET/PATCH /api/me/profile → profile. */
export interface OwnProfile {
  id: string
  did: string
  handle: string | null
  email: string | null
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  affiliation: string | null
  building: string | null
  telegram: string | null
  interests: string[] | null
  /** "What I'm looking for" (release design §6). Optional: older API builds omit it. */
  looking_for?: string | null
  ens: string | null
  ens_verified_at: string | null
  show_ens: boolean
  onboarding_completed: boolean
  publish_proposals: boolean
  synced_fields?: string[]
  profile_synced_at?: string | null
}

/** Limits enforced by PATCH /api/me/profile (src/app/api/me/profile/validate.ts). */
export const PROFILE_INPUT_LIMITS = {
  displayName: 80,
  bio: 1000,
  affiliation: 120,
  building: 500,
  lookingFor: 200,
  telegram: 120,
  interests: 15,
  interestLength: 40,
} as const

/**
 * Profile photos go through the one image-upload path (`src/lib/storage/upload.ts`), re-exported
 * here because the profile editors import it from this module.
 */
export { uploadAvatar }

/** Interest suggestions for the profile editors: GET /api/me/profile/interests. */
export function useInterestSuggestions(enabled: boolean, eventSlug: string | null): string[] {
  const [list, setList] = React.useState<string[]>([])
  React.useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const qs = eventSlug ? `?event=${encodeURIComponent(eventSlug)}` : ''
    apiFetch<{ suggested: string[]; existing: string[] }>(`/api/me/profile/interests${qs}`, { cache: 'no-store' })
      .then((res) => {
        if (!cancelled) setList([...res.suggested, ...res.existing])
      })
      .catch((err) => console.error('Could not load interest suggestions:', err instanceof Error ? err.message : err))
    return () => {
      cancelled = true
    }
  }, [enabled, eventSlug])
  return list
}

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

function injectedWallet(): EthereumProvider | null {
  if (typeof window === 'undefined') return null
  const eth = (window as unknown as { ethereum?: EthereumProvider }).ethereum
  return eth && typeof eth.request === 'function' ? eth : null
}

function utf8Hex(text: string): string {
  return `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

type AccountTab = 'profile' | 'identity' | 'notifications'

const TABS: ReadonlyArray<{ value: AccountTab; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { value: 'profile', label: 'Profile', icon: User },
  { value: 'identity', label: 'Identity', icon: AtSign },
  { value: 'notifications', label: 'Notifications', icon: Bell },
]

function Field({
  id,
  label,
  optional,
  hint,
  icon: Icon,
  children,
}: {
  id: string
  label: string
  optional?: boolean
  hint?: React.ReactNode
  icon?: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-sm font-medium flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
        {label}
        {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * One line says what happens now; whatever a curious person wants next sits behind this (design
 * §6). Never the only place a fact people must act on appears — those stay in the visible line.
 */
function Details({ label = 'Details', children }: { label?: string; children: React.ReactNode }) {
  return (
    <details className="text-xs text-muted-foreground">
      <summary className="cursor-pointer font-medium text-foreground/80 marker:text-muted-foreground hover:text-foreground">
        {label}
      </summary>
      <div className="mt-1.5 space-y-1.5 leading-relaxed">{children}</div>
    </details>
  )
}

function StatusLine({ message }: { message: { type: 'success' | 'error'; text: string } | null }) {
  if (!message) return null
  return (
    <p role={message.type === 'error' ? 'alert' : 'status'} className={cn('text-sm', message.type === 'success' ? 'text-success' : 'text-destructive')}>
      {message.text}
    </p>
  )
}

export interface AccountPanelProps {
  /** The gathering the panel is opened from, if any (notification preferences are per gathering). */
  gathering?: { slug: string; name: string | null } | null
  /** Reports whether the profile form has unsaved edits (used by the dialog's dismiss guard). */
  onDirtyChange?: (dirty: boolean) => void
  /** Called after Cancel in the profile footer (dialog closes; page resets). */
  onCancel?: () => void
  /** Reloads happen whenever the panel mounts and `active` flips to true. */
  active?: boolean
  initialTab?: AccountTab
  cancelLabel?: string
}

export function AccountPanel({ gathering, onDirtyChange, onCancel, active = true, initialTab = 'profile', cancelLabel = 'Cancel' }: AccountPanelProps) {
  const { user, refreshProfile } = useAuth()
  const { toast } = useToast()
  const userId = user?.id ?? null
  const eventSlug = gathering?.slug ?? null
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const tabId = React.useId()
  const [tab, setTab] = React.useState<AccountTab>(initialTab)

  const [profile, setProfile] = React.useState<OwnProfile | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [displayName, setDisplayName] = React.useState('')
  const [bio, setBio] = React.useState('')
  const [affiliation, setAffiliation] = React.useState('')
  const [building, setBuilding] = React.useState('')
  const [lookingFor, setLookingFor] = React.useState('')
  const [telegram, setTelegram] = React.useState('')
  const [avatarUrl, setAvatarUrl] = React.useState('')
  const [interests, setInterests] = React.useState<string[]>([])
  const [newInterest, setNewInterest] = React.useState('')

  const [isSaving, setIsSaving] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const [saveMessage, setSaveMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [showSuggestions, setShowSuggestions] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(-1)
  const allInterests = useInterestSuggestions(active && Boolean(userId), eventSlug)

  const applyProfile = React.useCallback((p: OwnProfile) => {
    setProfile(p)
    setDisplayName(p.display_name || '')
    setBio(p.bio || '')
    setAffiliation(p.affiliation || '')
    setBuilding(p.building || '')
    setLookingFor(p.looking_for || '')
    setTelegram(p.telegram || '')
    setAvatarUrl(p.avatar_url || '')
    setInterests(p.interests || [])
  }, [])

  // Load the canonical profile each time the panel becomes active.
  React.useEffect(() => {
    if (!active || !userId) return
    let cancelled = false
    setSaveMessage(null)
    setLoadError(null)
    setNewInterest('')
    setShowSuggestions(false)
    setTab(initialTab)
    apiFetch<{ profile: OwnProfile }>('/api/me/profile', { cache: 'no-store' })
      .then((res) => {
        if (!cancelled) applyProfile(res.profile)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load your profile')
      })
    return () => {
      cancelled = true
    }
  }, [active, userId, applyProfile, initialTab])

  // Unsaved-changes tracking: compare the form with what was loaded (or last saved).
  const dirty = React.useMemo(() => {
    if (!profile) return false
    const same = (a: string, b: string | null | undefined) => a.trim() === (b || '').trim()
    return !(
      same(displayName, profile.display_name) &&
      same(bio, profile.bio) &&
      same(affiliation, profile.affiliation) &&
      same(building, profile.building) &&
      same(lookingFor, profile.looking_for) &&
      same(telegram, profile.telegram) &&
      same(avatarUrl, profile.avatar_url) &&
      interests.join(' ') === (profile.interests || []).join(' ')
    )
  }, [profile, displayName, bio, affiliation, building, lookingFor, telegram, avatarUrl, interests])

  React.useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  // ATProto identity. Loaded from /api/atproto/me (session cookie) when the panel becomes active.
  const [atInfo, setAtInfo] = React.useState<AtIdentity | null>(null)
  const [atBusy, setAtBusy] = React.useState(false)
  const [atMessage, setAtMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [revealUrl, setRevealUrl] = React.useState<string | null>(null)
  const [confirmOwnership, setConfirmOwnership] = React.useState(false)
  const [resyncBusy, setResyncBusy] = React.useState(false)
  const [resyncMessage, setResyncMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [profileRecordBusy, setProfileRecordBusy] = React.useState(false)
  const [profileRecordMessage, setProfileRecordMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const loadAtIdentity = React.useCallback(async () => {
    try {
      setAtInfo(await apiFetch<AtIdentity>('/api/atproto/me'))
    } catch (err) {
      console.error('Error loading ATProto identity:', err)
    }
  }, [])

  React.useEffect(() => {
    if (active) {
      setAtMessage(null)
      setResyncMessage(null)
      setRevealUrl(null)
      setConfirmOwnership(false)
      loadAtIdentity()
    }
  }, [active, loadAtIdentity])

  const filteredSuggestions = React.useMemo(() => {
    const query = newInterest.trim().toLowerCase()
    if (!query) return []
    const chosen = new Set(interests.map((i) => i.toLowerCase()))
    return allInterests.filter((i) => i.toLowerCase().includes(query) && !chosen.has(i.toLowerCase())).slice(0, 8)
  }, [newInterest, allInterests, interests])

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setIsUploading(true)
    setSaveMessage(null)
    try {
      setAvatarUrl(await uploadAvatar(file))
    } catch (err) {
      setSaveMessage({ type: 'error', text: err instanceof Error ? err.message : 'Upload failed.' })
    } finally {
      setIsUploading(false)
    }
  }

  const handleAddInterest = (interest?: string) => {
    const toAdd = (interest || newInterest).trim().slice(0, PROFILE_INPUT_LIMITS.interestLength)
    if (!toAdd || interests.some((i) => i.toLowerCase() === toAdd.toLowerCase())) return
    if (interests.length >= PROFILE_INPUT_LIMITS.interests) {
      setSaveMessage({ type: 'error', text: `Choose at most ${PROFILE_INPUT_LIMITS.interests} interests.` })
      return
    }
    setInterests([...interests, toAdd])
    setNewInterest('')
    setShowSuggestions(false)
    setHighlightedIndex(-1)
  }

  const handleRemoveInterest = (interest: string) => {
    setInterests(interests.filter((i) => i !== interest))
  }

  const handleInterestKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev < filteredSuggestions.length - 1 ? prev + 1 : prev))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (highlightedIndex >= 0 && filteredSuggestions[highlightedIndex]) {
        handleAddInterest(filteredSuggestions[highlightedIndex])
      } else {
        handleAddInterest()
      }
    } else if (e.key === 'Escape' && showSuggestions) {
      e.stopPropagation()
      setShowSuggestions(false)
      setHighlightedIndex(-1)
    }
  }

  const handleSave = async () => {
    if (!userId || !profile) return
    if (displayName.trim().length === 0) {
      setSaveMessage({ type: 'error', text: 'Display name cannot be empty.' })
      return
    }
    setIsSaving(true)
    setSaveMessage(null)
    try {
      const res = await apiFetch<{ profile: OwnProfile }>('/api/me/profile', {
        method: 'PATCH',
        json: {
          display_name: displayName,
          bio,
          affiliation,
          building,
          looking_for: lookingFor,
          telegram,
          avatar_url: avatarUrl || null,
          interests,
        },
      })
      applyProfile(res.profile)
      toast({ title: 'Profile saved', variant: 'success' })
      await refreshProfile()
    } catch (err) {
      setSaveMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save your profile. Please try again.' })
    } finally {
      setIsSaving(false)
    }
  }

  const handleTakeOwnership = async () => {
    if (!atInfo || atInfo.kind !== 'custodial' || atInfo.owned || !confirmOwnership) return
    setAtBusy(true)
    setAtMessage(null)
    try {
      const res = await apiFetch<{ ok: true; handle: string; revealUrl?: string }>('/api/me/take-ownership', { method: 'POST' })
      setRevealUrl(res.revealUrl ?? null)
      setAtMessage({
        type: 'success',
        text: res.revealUrl
          ? 'Done. Open the reveal link below to see your new password once.'
          : 'Done. A single-use link that shows your new password once is on its way to your inbox.',
      })
      await loadAtIdentity()
    } catch (err) {
      setAtMessage({ type: 'error', text: err instanceof ApiError ? err.message : 'Could not take ownership. Please try again.' })
    } finally {
      setAtBusy(false)
    }
  }

  const handleAtPublishToggle = async (publish: boolean) => {
    if (!atInfo) return
    const previous = atInfo
    setAtInfo({ ...atInfo, publishProposals: publish })
    setAtMessage(null)
    try {
      setAtInfo(await apiFetch<AtIdentity>('/api/atproto/me', { method: 'PATCH', json: { publish_proposals: publish } }))
      toast({ title: publish ? 'Proposals will be published to your repo' : 'Proposals stay app-side', variant: 'success' })
    } catch (err) {
      console.error('Error updating publish_proposals:', err)
      setAtInfo(previous)
      setAtMessage({ type: 'error', text: 'Could not save that setting. Please try again.' })
    }
  }

  const handlePublishProfileToggle = async (publish: boolean) => {
    if (!atInfo) return
    const previous = atInfo
    setAtInfo({ ...atInfo, publishProfile: publish })
    setProfileRecordMessage(null)
    setProfileRecordBusy(true)
    try {
      setAtInfo(await apiFetch<AtIdentity>('/api/atproto/me', { method: 'PATCH', json: { publish_profile: publish } }))
      toast({ title: publish ? 'Your profile is now published to the network' : 'Your profile record was deleted', variant: 'success' })
    } catch (err) {
      console.error('Error updating publish_profile:', err)
      setAtInfo(previous)
      const code = err instanceof ApiError ? err.code : undefined
      setProfileRecordMessage({
        type: 'error',
        text:
          code === 'pds_unavailable'
            ? (publish ? 'Your repository couldn’t be written right now. Nothing was published; try again in a moment.' : 'Your repository couldn’t be reached right now. Your profile is still published; try again in a moment.')
            : err instanceof Error ? err.message : 'Could not save that setting. Please try again.',
      })
    } finally {
      setProfileRecordBusy(false)
    }
  }

  const handleResync = async () => {
    setResyncBusy(true)
    setResyncMessage(null)
    try {
      const res = await apiFetch<{ updated?: string[]; synced?: string[]; fetched?: boolean }>('/api/atproto/me/resync', { method: 'POST' })
      const changed = res.updated?.length ?? 0
      const [fresh] = await Promise.all([apiFetch<{ profile: OwnProfile }>('/api/me/profile', { cache: 'no-store' }), refreshProfile()])
      applyProfile(fresh.profile)
      setResyncMessage({ type: 'success', text: changed ? `Re-synced. ${changed} ${changed === 1 ? 'field' : 'fields'} updated from your network profile.` : 'Re-synced. Your profile already matched the network.' })
      toast({ title: 'Profile re-synced', variant: 'success' })
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setResyncMessage({ type: 'error', text: 'Re-sync isn’t available on this instance yet.' })
      } else if (err instanceof ApiError && err.status === 502) {
        setResyncMessage({ type: 'error', text: 'Your network profile couldn’t be read right now. Nothing was changed; try again in a moment.' })
      } else {
        setResyncMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not re-sync your profile.' })
      }
    } finally {
      setResyncBusy(false)
    }
  }

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((t) => t.value === tab)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const next = (index + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length
      setTab(TABS[next].value)
      document.getElementById(`${tabId}-tab-${TABS[next].value}`)?.focus()
    }
  }

  return (
    <div className="space-y-5">
      <div role="tablist" aria-label="Account sections" className="flex gap-1 rounded-xl bg-muted/50 p-1" onKeyDown={onTabKeyDown}>
        {TABS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            id={`${tabId}-tab-${value}`}
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`${tabId}-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            className={cn(
              'flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tab === value ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* ── Profile ── */}
      <div id={`${tabId}-panel-profile`} role="tabpanel" aria-labelledby={`${tabId}-tab-profile`} hidden={tab !== 'profile'} className="space-y-6">
        {loadError && (
          <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">{loadError}</div>
        )}
        {!profile && !loadError && (
          <div className="flex justify-center py-6" role="status" aria-label="Loading your profile">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        )}

        {profile && (
          <>
            {/* Avatar */}
            <div className="flex items-center gap-4">
              <div className="relative group">
                <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center overflow-hidden border-2 border-border">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" onError={() => setAvatarUrl('')} />
                  ) : (
                    <User className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isUploading}
                  aria-label="Upload a profile photo"
                  className="absolute inset-0 rounded-full bg-foreground/50 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center justify-center"
                >
                  {isUploading ? <Loader2 className="h-6 w-6 text-background animate-spin" aria-hidden="true" /> : <Camera className="h-6 w-6 text-background" aria-hidden="true" />}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} loading={isUploading}>
                  {avatarUrl ? 'Change photo' : 'Upload a photo'}
                </Button>
                {avatarUrl && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setAvatarUrl('')}>
                    Remove
                  </Button>
                )}
              </div>
            </div>

            <Field id="settings-display-name" label="Display name" icon={User}>
              <Input id="settings-display-name" placeholder="Your name" value={displayName} maxLength={PROFILE_INPUT_LIMITS.displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>

            <Field id="settings-bio" label="Bio" optional>
              <Textarea id="settings-bio" placeholder="A few lines about you" value={bio} maxLength={PROFILE_INPUT_LIMITS.bio} onChange={(e) => setBio(e.target.value)} rows={2} />
            </Field>

            <Field id="settings-affiliation" label="Organization" optional icon={Building2}>
              <Input id="settings-affiliation" placeholder="Your company, collective or project" value={affiliation} maxLength={PROFILE_INPUT_LIMITS.affiliation} onChange={(e) => setAffiliation(e.target.value)} />
            </Field>

            <Field id="settings-building" label="What are you building?" optional icon={Rocket}>
              <Textarea id="settings-building" placeholder="Describe your current project" value={building} maxLength={PROFILE_INPUT_LIMITS.building} onChange={(e) => setBuilding(e.target.value)} rows={2} />
            </Field>

            <Field
              id="settings-looking-for"
              label="What I’m looking for"
              optional
              icon={Compass}
              hint={`Who you’d like to meet or what you hope to find. Members only. ${lookingFor.length}/${PROFILE_INPUT_LIMITS.lookingFor}`}
            >
              <Input id="settings-looking-for" placeholder="Collaborators for a local energy co-op" value={lookingFor} maxLength={PROFILE_INPUT_LIMITS.lookingFor} onChange={(e) => setLookingFor(e.target.value)} />
            </Field>

            <Field id="settings-telegram" label="Messaging handle" optional icon={Send} hint="Telegram, Signal, Matrix — whatever you use. Members only.">
              <Input id="settings-telegram" placeholder="@name or a link" value={telegram} maxLength={PROFILE_INPUT_LIMITS.telegram} onChange={(e) => setTelegram(e.target.value)} />
            </Field>

            {/* Interests */}
            <div className="space-y-2">
              <label htmlFor="settings-interest" className="text-sm font-medium flex items-center gap-2">
                <Hash className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                Interests
                <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <div className="relative">
                <div className="flex gap-2">
                  <Input
                    id="settings-interest"
                    placeholder="Type to search interests"
                    value={newInterest}
                    maxLength={PROFILE_INPUT_LIMITS.interestLength}
                    role="combobox"
                    aria-expanded={showSuggestions && filteredSuggestions.length > 0}
                    aria-controls="settings-interest-suggestions"
                    aria-autocomplete="list"
                    onChange={(e) => {
                      setNewInterest(e.target.value)
                      setShowSuggestions(true)
                      setHighlightedIndex(-1)
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    onKeyDown={handleInterestKeyDown}
                  />
                  <Button type="button" variant="outline" size="icon" onClick={() => handleAddInterest()} aria-label="Add interest">
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
                {showSuggestions && filteredSuggestions.length > 0 && (
                  <div id="settings-interest-suggestions" role="listbox" className="absolute z-20 top-full left-0 right-[3.25rem] mt-1 bg-card border rounded-lg shadow-lg overflow-hidden">
                    {filteredSuggestions.map((suggestion, index) => (
                      <button
                        key={suggestion}
                        type="button"
                        role="option"
                        aria-selected={index === highlightedIndex}
                        className={cn('w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors', index === highlightedIndex && 'bg-muted')}
                        onMouseDown={(e) => {
                          e.preventDefault()
                          handleAddInterest(suggestion)
                        }}
                        onMouseEnter={() => setHighlightedIndex(index)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Up to {PROFILE_INPUT_LIMITS.interests}. Fellow members can find you by these, and the People page suggests people who share them.
              </p>
              {interests.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {interests.map((interest) => (
                    <RemovableChip key={interest} label={interest} onRemove={() => handleRemoveInterest(interest)} />
                  ))}
                </div>
              )}
            </div>

            {gathering && <GatheringSharingSection slug={gathering.slug} name={gathering.name} />}

            {/* One row, and only on a browser that has an install to offer. */}
            <InstallAppRow className="flex min-h-11 w-full items-center gap-3 rounded-xl border-t px-3 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />

            <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 flex-1">
                <StatusLine message={saveMessage} />
                {!saveMessage && dirty && <p className="text-sm text-muted-foreground">You have unsaved changes.</p>}
              </div>
              <div className="flex gap-2 sm:justify-end">
                <Button type="button" variant="outline" onClick={() => { if (dirty) applyProfile(profile); onCancel?.() }}>
                  {cancelLabel}
                </Button>
                <Button type="button" onClick={handleSave} loading={isSaving} disabled={isUploading || !dirty}>
                  Save changes
                </Button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ── Identity ── */}
      <div id={`${tabId}-panel-identity`} role="tabpanel" aria-labelledby={`${tabId}-tab-identity`} hidden={tab !== 'identity'} className="space-y-6">
        {!atInfo && (
          <div className="flex justify-center py-6" role="status" aria-label="Loading your identity">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        )}
        {atInfo && !atInfo.linked && (
          <p className="text-sm text-muted-foreground">This account has no network identity yet.</p>
        )}
        {atInfo?.linked && (
          <section className="space-y-4" data-testid="atproto-identity" aria-labelledby={`${tabId}-identity-heading`}>
            <h3 id={`${tabId}-identity-heading`} className="text-sm font-medium flex items-center gap-2">
              <AtSign className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Your identity
            </h3>
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-1">
              <p className="text-sm font-medium truncate">@{atInfo.handle || atInfo.did}</p>
              {atInfo.did && <p className="text-xs font-mono text-muted-foreground truncate">{atInfo.did}</p>}
              <p className="text-xs text-muted-foreground">
                {atInfo.kind === 'oauth'
                  ? 'Your own ATProto account (signed in with Bluesky or another ATProto provider).'
                  : atInfo.owned
                    ? 'Created here, now owned by you. Publishing here needs an ATProto sign-in.'
                    : 'Created for you by this app, which holds its password on your behalf.'}
              </p>
            </div>

            {atInfo.kind === 'oauth' && (
              <div className="space-y-2">
                <Button type="button" variant="outline" onClick={handleResync} loading={resyncBusy}>
                  <RefreshCw className="h-4 w-4 mr-2" aria-hidden="true" />
                  Re-sync from my Bluesky profile
                </Button>
                <p className="text-xs text-muted-foreground">
                  Re-imports your name, photo and bio from your network profile, replacing edits made here.
                  {profile?.profile_synced_at && ` Last synced ${new Date(profile.profile_synced_at).toLocaleString()}.`}
                </p>
                <StatusLine message={resyncMessage} />
              </div>
            )}

            <div className="flex items-start gap-3 text-sm">
              <Checkbox
                id={`${tabId}-publish-proposals`}
                className="mt-0.5"
                checked={atInfo.publishProposals}
                onCheckedChange={(checked) => handleAtPublishToggle(checked === true)}
                disabled={atBusy}
              />
              <div>
                <label htmlFor={`${tabId}-publish-proposals`} className="cursor-pointer">
                  <span className="font-medium">Publish my proposals to the open network</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Anyone can then read a proposal you write, under this identity.
                  </span>
                </label>
                <Details>
                  <p>
                    Deleting a proposal takes it off the network, but copies other services already took can outlive
                    it.{' '}
                    <Link href={HELP_PRIVACY.public} className="underline">
                      {LEARN_MORE}
                    </Link>
                  </p>
                </Details>
              </div>
            </div>

            {atInfo.kind === 'custodial' && !atInfo.owned && (
              <WarningBox title="Publish my profile to the network" data-testid="publish-profile">
                <p className="text-xs text-muted-foreground">
                  Off by default. Switching it on makes your display name and bio readable by anyone; your photo,
                  email and everything else stay here.
                </p>
                <Details>
                  <p>
                    Switching it off removes them from the network again, though copies other services already took
                    can remain.{' '}
                    <Link href={HELP_PRIVACY.public} className="underline">
                      {LEARN_MORE}
                    </Link>
                  </p>
                </Details>
                <div className="mt-3 flex items-start justify-between gap-4">
                  <label htmlFor={`${tabId}-publish-profile`} className="text-xs cursor-pointer">
                    <span className="font-medium text-foreground">
                      {atInfo.publishProfile ? 'Published: your name and bio are world-readable.' : 'Not published.'}
                    </span>
                    {atInfo.publishProfile && atInfo.profileRecordUri && (
                      <span className="block font-mono text-muted-foreground break-all mt-0.5">{atInfo.profileRecordUri}</span>
                    )}
                  </label>
                  <Switch
                    id={`${tabId}-publish-profile`}
                    checked={atInfo.publishProfile}
                    onCheckedChange={handlePublishProfileToggle}
                    disabled={profileRecordBusy}
                    aria-label="Publish my profile to the network"
                  />
                </div>
                <StatusLine message={profileRecordMessage} />
              </WarningBox>
            )}

            {atInfo.kind === 'custodial' && atInfo.owned && atInfo.publishProfile && (
              <p className="text-xs text-muted-foreground">
                You own this identity now, so manage your published profile from your own data server.
              </p>
            )}

            {atInfo.kind === 'custodial' && !atInfo.owned && (
              <WarningBox title="Take ownership of this identity" data-testid="take-ownership">
                <p className="text-xs text-muted-foreground">
                  You get a new password for this identity, emailed as a link that shows it once, and this app stops
                  holding it. You cannot undo this.
                </p>
                <Details>
                  <p>
                    From then on the identity is yours to run: change the password, export everything you have
                    written, or move to another provider. Publishing from this app will ask you to sign in with the
                    account through “an existing ATProto account”.{' '}
                    <Link href={HELP_PRIVACY.identity} className="underline">
                      {LEARN_MORE}
                    </Link>
                  </p>
                </Details>
                <div className="mt-3 flex items-start gap-3 text-sm">
                  <Checkbox
                    id={`${tabId}-confirm-ownership`}
                    className="mt-0.5"
                    checked={confirmOwnership}
                    onCheckedChange={(checked) => setConfirmOwnership(checked === true)}
                    disabled={atBusy}
                  />
                  <label htmlFor={`${tabId}-confirm-ownership`} className="cursor-pointer text-xs">
                    I understand, and I will save the password when it is shown.
                  </label>
                </div>
                <Button type="button" variant="destructive" className="mt-3" onClick={handleTakeOwnership} loading={atBusy} disabled={!confirmOwnership}>
                  Take ownership
                </Button>
              </WarningBox>
            )}

            {revealUrl && (
              <a href={revealUrl} className="block text-sm underline break-all">
                Open the single-use reveal link
              </a>
            )}
            <StatusLine message={atMessage} />
          </section>
        )}

        {/* ENS saves on its own; setProfile (not applyProfile) keeps unsaved edits to the profile tab. */}
        {profile && <EnsSection profile={profile} onProfile={setProfile} />}

        <AssistantConnections active={active} />

        <SubjectRights active={active} />
      </div>

      {/* ── Notifications ── */}
      <div id={`${tabId}-panel-notifications`} role="tabpanel" aria-labelledby={`${tabId}-tab-notifications`} hidden={tab !== 'notifications'} className="space-y-4">
        {gathering ? (
          <>
            <p className="text-sm text-muted-foreground">
              Notification preferences are set per gathering: which emails you get, and what shows up in the app.
            </p>
            <Button asChild variant="outline">
              <Link href={`/e/${gathering.slug}/settings/notifications`}>
                <Bell className="h-4 w-4 mr-2" aria-hidden="true" />
                Notification preferences for {gathering.name || 'this gathering'}
              </Link>
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Notification preferences are set per gathering. Open a gathering and choose “Notification preferences”
            from your account menu, or the bell in its sidebar.
          </p>
        )}

        <CalendarSubscriptions active={active} />
      </div>
    </div>
  )
}

/** Shape of GET /api/me/assistant-tokens. */
interface AssistantToken {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
}

/**
 * "Connect an AI assistant" (Account → Identity): mint, list and revoke the personal tokens that
 * let a member's own assistant read their gatherings through the MCP server at `/api/mcp`.
 *
 * The secret is shown exactly once, right after minting: the server stores only its hash. Nothing
 * here grants an assistant more than the member already has — the block says so in as many words,
 * because that is the question a person actually has when they see this.
 */
function AssistantConnections({ active }: { active: boolean }) {
  const id = React.useId()
  const { toast } = useToast()
  const [tokens, setTokens] = React.useState<AssistantToken[] | null>(null)
  const [limit, setLimit] = React.useState(5)
  const [mcpUrl, setMcpUrl] = React.useState('/api/mcp')
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await apiFetch<{ tokens: AssistantToken[]; limit: number; mcp_url: string }>('/api/me/assistant-tokens', {
        cache: 'no-store',
      })
      setTokens(res.tokens)
      setLimit(res.limit)
      setMcpUrl(res.mcp_url)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your connected assistants')
      setTokens([])
    }
  }, [])

  React.useEffect(() => {
    if (!active) return
    setSecret(null)
    setError(null)
    setConfirming(null)
    load()
  }, [active, load])

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000)
    } catch {
      toast({ title: 'Could not copy', description: 'Select the text and copy it by hand.', variant: 'destructive' })
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch<{ token: string; assistant_token: AssistantToken }>('/api/me/assistant-tokens', {
        method: 'POST',
        json: { name: trimmed },
      })
      setSecret(res.token)
      setName('')
      setTokens((list) => [res.assistant_token, ...(list ?? [])])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a token')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (tokenId: string) => {
    setBusy(true)
    setError(null)
    try {
      await apiFetch(`/api/me/assistant-tokens?id=${encodeURIComponent(tokenId)}`, { method: 'DELETE' })
      setTokens((list) => (list ?? []).filter((t) => t.id !== tokenId))
      setConfirming(null)
      toast({ title: 'Token revoked', description: 'That assistant can no longer read anything.' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke that token')
    } finally {
      setBusy(false)
    }
  }

  const full = (tokens?.length ?? 0) >= limit

  return (
    <section className="space-y-4" data-testid="assistant-connections" aria-labelledby={`${id}-assistants-heading`}>
      <h3 id={`${id}-assistants-heading`} className="text-sm font-medium flex items-center gap-2">
        <Bot className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Connect an AI assistant
      </h3>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Ask your own assistant about the schedule, who is hosting what, or a session you missed. It sees exactly what
        you see, and can change nothing.
      </p>
      <Details>
        <p>
          It reads the sessions and schedules of gatherings you belong to and the transcripts you are allowed to read.
          It cannot see votes, other people&apos;s messages or anyone&apos;s email address. Your questions and the
          excerpts it reads go to whoever runs that assistant.
        </p>
        <p>
          <Link href="/help/assistants" className="underline">
            How to connect one
          </Link>
          {' · '}
          <Link href={HELP_PRIVACY.assistants} className="underline">
            {LEARN_MORE}
          </Link>
        </p>
      </Details>

      <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
        <p className="text-xs text-muted-foreground">Server URL</p>
        <div className="flex items-center gap-2">
          <code className="text-xs font-mono break-all flex-1" data-testid="mcp-url">
            {mcpUrl}
          </code>
          <Button type="button" variant="ghost" size="sm" onClick={() => copy(mcpUrl, 'url')} aria-label="Copy the server URL">
            {copied === 'url' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          </Button>
        </div>
      </div>

      {secret && (
        <WarningBox title="Copy this token now — it is shown once" data-testid="assistant-token-secret">
          <p className="text-xs text-muted-foreground">
            Paste it into your assistant as the bearer token for the server URL above. Lose it and you revoke it here
            and make another — it cannot be shown twice.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <code className="text-xs font-mono break-all flex-1 rounded bg-background px-2 py-1">{secret}</code>
            <Button type="button" variant="outline" size="sm" onClick={() => copy(secret, 'secret')}>
              {copied === 'secret' ? <Check className="h-4 w-4 mr-1" aria-hidden="true" /> : <Copy className="h-4 w-4 mr-1" aria-hidden="true" />}
              Copy
            </Button>
          </div>
          <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setSecret(null)}>
            I have saved it
          </Button>
        </WarningBox>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor={`${id}-assistant-name`} className="text-xs text-muted-foreground">
            Name this assistant
          </label>
          <Input
            id={`${id}-assistant-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy && name.trim() && !full) {
                e.preventDefault()
                create()
              }
            }}
            placeholder="Claude on my laptop"
            maxLength={60}
            disabled={busy || full}
          />
        </div>
        <Button type="button" onClick={create} loading={busy} disabled={!name.trim() || full}>
          Create token
        </Button>
      </div>
      {full && (
        <p className="text-xs text-muted-foreground">
          You have {limit} connected assistants, the limit. Revoke one to add another.
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}

      {tokens === null ? (
        <div className="flex justify-center py-4" role="status" aria-label="Loading your connected assistants">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      ) : tokens.length === 0 ? (
        <p className="text-xs text-muted-foreground">No assistant is connected.</p>
      ) : (
        <ul className="space-y-2" data-testid="assistant-token-list">
          {tokens.map((t) => (
            <li key={t.id} className="rounded-lg border border-border px-3 py-2">
              {confirming === t.id ? (
                <ConfirmInline
                  message={`Revoke “${t.name}”? That assistant stops being able to read anything, immediately.`}
                  confirmLabel="Revoke"
                  destructive
                  loading={busy}
                  onConfirm={() => revoke(t.id)}
                  onCancel={() => setConfirming(null)}
                />
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(t.created_at).toLocaleDateString()}
                      {' · '}
                      {t.last_used_at ? `last used ${new Date(t.last_used_at).toLocaleString()}` : 'never used'}
                    </p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(t.id)} disabled={busy}>
                    Revoke
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * What the viewer shares in ONE gathering (`event_members`): the directory listing, the messaging
 * handle and the email address (design §3.3). Three switches, saved one at a time, each the
 * viewer's own — an organizer can never set them, and none of them reaches a record.
 *
 * Renders nothing when the viewer is not a member of the gathering in view.
 */
interface GatheringSharing {
  directory_listing: boolean
  share_contact: boolean
  share_email: boolean
  has_telegram: boolean
  has_email: boolean
}

type SharingField = keyof Pick<GatheringSharing, 'directory_listing' | 'share_contact' | 'share_email'>

function GatheringSharingSection({ slug, name }: { slug: string; name: string | null }) {
  const id = React.useId()
  const { toast } = useToast()
  const [settings, setSettings] = React.useState<GatheringSharing | null>(null)
  const [busy, setBusy] = React.useState<SharingField | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const where = name || 'this gathering'

  React.useEffect(() => {
    let cancelled = false
    apiFetch<GatheringSharing>(`/api/v1/events/${encodeURIComponent(slug)}/participants/me`, { cache: 'no-store' })
      .then((res) => {
        if (!cancelled) setSettings(res)
      })
      .catch(() => {
        // Not a member of this gathering (or signed out): nothing to show.
        if (!cancelled) setSettings(null)
      })
    return () => {
      cancelled = true
    }
  }, [slug])

  if (!settings) return null

  const update = async (field: SharingField, value: boolean) => {
    setBusy(field)
    setError(null)
    const previous = settings
    setSettings({ ...settings, [field]: value })
    try {
      const res = await apiFetch<GatheringSharing>(`/api/v1/events/${encodeURIComponent(slug)}/participants/me`, {
        method: 'PATCH',
        json: { [field]: value },
      })
      setSettings(res)
      const titles: Record<SharingField, [string, string]> = {
        directory_listing: ['You are listed in the directory', 'You are hidden from the directory'],
        share_contact: ['Members here can see your messaging handle', 'Your messaging handle is hidden here'],
        share_email: ['Members here can see your email address', 'Your email address is hidden here'],
      }
      toast({ title: titles[field][res[field] ? 0 : 1], variant: 'success' })
    } catch (err) {
      setSettings(previous)
      setError(err instanceof Error ? err.message : 'Could not save that setting.')
    } finally {
      setBusy(null)
    }
  }

  const row = (field: SharingField, label: string, hint: React.ReactNode, disabled = false) => (
    <div className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
      <label htmlFor={`${id}-${field}`} className="text-sm cursor-pointer">
        <span className="font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground mt-0.5">{hint}</span>
      </label>
      <Switch
        id={`${id}-${field}`}
        checked={settings[field]}
        onCheckedChange={(value) => update(field, value)}
        disabled={busy !== null || disabled}
      />
    </div>
  )

  return (
    <section className="rounded-lg border border-border p-3" aria-labelledby={`${id}-heading`} data-testid="gathering-sharing">
      <h3 id={`${id}-heading`} className="text-sm font-medium">
        What you share at {where}
      </h3>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Each gathering is separate. Nothing here is ever published on the network.
      </p>
      <div className="mt-2 divide-y divide-border">
        {row(
          'directory_listing',
          'Show me in the directory',
          <>Other members of {where} can see your profile on the People page.</>,
        )}
        {row(
          'share_contact',
          'Show my messaging handle',
          settings.has_telegram
            ? <>Members of {where} can see the handle on your profile and message you there.</>
            : <>Add a messaging handle above and members of {where} will be able to see it.</>,
          !settings.has_telegram,
        )}
        {row(
          'share_email',
          'Show my email address',
          settings.has_email
            ? <>Off by default. Members of {where} can email you directly. Turning it off hides it again.</>
            : <>This account has no email address, so there is nothing to share.</>,
          !settings.has_email,
        )}
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  )
}

export function SettingsModal({ isOpen, onClose, gathering: gatheringProp }: SettingsModalProps) {
  const params = useParams<{ slug?: string }>()
  const eventSlug = typeof params?.slug === 'string' ? params.slug : null
  const gathering = gatheringProp ?? (eventSlug ? { slug: eventSlug, name: null } : null)
  const [dirty, setDirty] = React.useState(false)
  const [confirmDiscard, setConfirmDiscard] = React.useState(false)

  React.useEffect(() => {
    if (!isOpen) setConfirmDiscard(false)
  }, [isOpen])

  const requestClose = () => {
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => { if (!open) requestClose() }}>
      <DialogContent size="lg" className="max-h-[calc(100dvh-2rem)]">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>Your profile, your identity on the network, and how you hear from gatherings.</DialogDescription>
        </DialogHeader>
        {confirmDiscard && (
          <ConfirmInline
            message="You have unsaved profile changes. Discard them?"
            confirmLabel="Discard"
            destructive
            onConfirm={() => { setConfirmDiscard(false); onClose() }}
            onCancel={() => setConfirmDiscard(false)}
          />
        )}
        <AccountPanel
          active={isOpen}
          gathering={gathering}
          onDirtyChange={setDirty}
          onCancel={onClose}
          cancelLabel="Close"
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * ENS: self-written, verified by a wallet signature, shown to fellow members only when verified
 * and opted in (spec §7). Saves immediately, separately from the rest of the form.
 */
function EnsSection({ profile, onProfile }: { profile: OwnProfile; onProfile: (p: OwnProfile) => void }) {
  const id = React.useId()
  const { toast } = useToast()
  const [name, setName] = React.useState(profile.ens || '')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [manual, setManual] = React.useState<{ name: string; message: string } | null>(null)
  const [pasted, setPasted] = React.useState('')

  React.useEffect(() => {
    setName(profile.ens || '')
  }, [profile.ens])

  const verified = Boolean(profile.ens && profile.ens_verified_at && profile.ens === name.trim().toLowerCase())

  const reload = async () => {
    const res = await apiFetch<{ profile: OwnProfile }>('/api/me/profile', { cache: 'no-store' })
    onProfile(res.profile)
  }

  const submitSignature = async (ensName: string, signature: string) => {
    await apiFetch('/api/me/ens/verify', { method: 'POST', json: { name: ensName, signature } })
    setManual(null)
    setPasted('')
    await reload()
    setMessage({ type: 'success', text: `${ensName} is verified.` })
    toast({ title: `${ensName} verified`, variant: 'success' })
  }

  const startVerify = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const challenge = await apiFetch<{ name: string; message: string }>('/api/me/ens/challenge', {
        method: 'POST',
        json: { name },
      })
      const wallet = injectedWallet()
      if (!wallet) {
        setManual({ name: challenge.name, message: challenge.message })
        return
      }
      const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[]
      if (!accounts?.[0]) throw new Error('No wallet account selected.')
      const signature = (await wallet.request({
        method: 'personal_sign',
        params: [utf8Hex(challenge.message), accounts[0]],
      })) as string
      await submitSignature(challenge.name, signature)
    } catch (err) {
      const text = err instanceof Error ? err.message : 'Verification failed.'
      setMessage({ type: 'error', text: /user rejected|denied/i.test(text) ? 'Signature request was declined.' : text })
    } finally {
      setBusy(false)
    }
  }

  const removeEns = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await apiFetch<{ profile: OwnProfile }>('/api/me/profile', { method: 'PATCH', json: { ens: null, show_ens: false } })
      onProfile(res.profile)
      setName('')
      toast({ title: 'ENS name removed', variant: 'success' })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not remove the name.' })
    } finally {
      setBusy(false)
    }
  }

  const toggleShow = async (show: boolean) => {
    setBusy(true)
    setMessage(null)
    try {
      const res = await apiFetch<{ profile: OwnProfile }>('/api/me/profile', { method: 'PATCH', json: { show_ens: show } })
      onProfile(res.profile)
      toast({ title: show ? 'ENS name shown to fellow members' : 'ENS name hidden', variant: 'success' })
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save that setting.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2 border-t pt-5" aria-labelledby={`${id}-heading`}>
      <label id={`${id}-heading`} htmlFor="settings-ens" className="text-sm font-medium flex items-center gap-2">
        <Hexagon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        ENS name
        <span className="font-normal text-muted-foreground">(optional)</span>
        {verified && (
          <Badge variant="success" className="gap-1">
            <BadgeCheck className="h-3 w-3" aria-hidden="true" /> Verified
          </Badge>
        )}
      </label>
      <div className="flex gap-2">
        <Input
          id="settings-ens"
          placeholder="yourname.eth"
          value={name}
          maxLength={255}
          onChange={(e) => {
            setName(e.target.value)
            setManual(null)
          }}
          disabled={busy}
        />
        {verified ? (
          <Button type="button" variant="outline" onClick={removeEns} loading={busy}>
            Remove
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={startVerify} loading={busy} disabled={!name.trim()}>
            Verify
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Verify by signing a message with the wallet your name resolves to. No transaction, no cost. Your address is not stored.
      </p>

      {manual && (
        <div className="rounded-lg border border-border p-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            No browser wallet found. Sign this exact message with <code>personal_sign</code> from the wallet{' '}
            <strong>{manual.name}</strong> resolves to, then paste the signature.
          </p>
          <pre className="text-xs whitespace-pre-wrap bg-muted/40 rounded p-2 select-all">{manual.message}</pre>
          <Input placeholder="0x…" aria-label="Signature" value={pasted} onChange={(e) => setPasted(e.target.value.trim())} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!pasted}
            loading={busy}
            onClick={async () => {
              setBusy(true)
              setMessage(null)
              try {
                await submitSignature(manual.name, pasted)
              } catch (err) {
                setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Verification failed.' })
              } finally {
                setBusy(false)
              }
            }}
          >
            Submit signature
          </Button>
        </div>
      )}

      <div className="flex items-start gap-3 text-sm pt-1">
        <Checkbox
          id={`${id}-show-ens`}
          className="mt-0.5"
          checked={profile.show_ens}
          disabled={busy || !profile.ens_verified_at}
          onCheckedChange={(checked) => toggleShow(checked === true)}
        />
        <label htmlFor={`${id}-show-ens`} className="cursor-pointer">
          <span className="font-medium">Show my verified ENS name to fellow members</span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Visible only in the member directory of gatherings you belong to. Never published to the network.
          </span>
        </label>
      </div>

      <StatusLine message={message} />
    </section>
  )
}

/* ────────────────────────── Account → Identity: subject rights ────────────────────────── */

interface DeletionPreview {
  handle: string | null
  did: string
  kind: 'custodial' | 'oauth'
  blockingGatherings: Array<{ slug: string; name: string }>
  pds: 'deactivated' | 'not-ours' | 'owned-by-you' | 'failed' | 'none'
  pdsSentence: string
}

/**
 * "Download my data" and "Delete my account" (MT §12.6, spec §9).
 *
 * The copy here is the point of the feature as much as the buttons are. Two things a person
 * deserves to be told before they act, not after:
 *
 *   · the export does not contain their votes, and cannot, because the link between a person
 *     and their ballot is destroyed when a round closes;
 *   · deleting the account deactivates their repository on our PDS rather than deleting it,
 *     because a DID's history in the PLC directory is permanent by design — it is public,
 *     append-only and mirrored, and no button anywhere can withdraw it.
 */
function SubjectRights({ active }: { active: boolean }) {
  const id = React.useId()
  const [preview, setPreview] = React.useState<DeletionPreview | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [done, setDone] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!active) return
    let cancelled = false
    apiFetch<DeletionPreview>('/api/me/delete')
      .then((p) => { if (!cancelled) setPreview(p) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [active])

  const expected = preview?.handle || preview?.did || ''
  const matches = typed.trim().replace(/^@/, '').toLowerCase() === expected.toLowerCase() && expected.length > 0

  const remove = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await apiFetch<{ deleted: boolean; pdsSentence: string }>('/api/me/delete', { method: 'POST', json: { confirm: typed.trim() } })
      setDone(result.pdsSentence)
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof ApiError ? e.message : 'Your account could not be deleted. Try again.' })
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  if (done) {
    return (
      <section className="space-y-3 border-t pt-6" aria-labelledby={`${id}-gone`}>
        <h3 id={`${id}-gone`} className="text-sm font-medium">Your account is deleted</h3>
        <p className="text-xs text-muted-foreground">{done}</p>
        <Button type="button" onClick={() => { window.location.href = '/' }}>Done</Button>
      </section>
    )
  }

  return (
    <section className="space-y-6 border-t pt-6" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-medium">Your data</h3>

      <div className="space-y-2">
        <Button asChild variant="outline">
          <a href="/api/me/export" download>
            <Download className="h-4 w-4 mr-2" aria-hidden="true" />
            Download my data
          </a>
        </Button>
        <p className="text-xs text-muted-foreground">
          One file with what this app holds about you: profile, memberships, proposals, RSVPs, saved sessions,
          tickets and transcripts. Your <em>votes cannot be in it</em>.
        </p>
        <Details>
          <p>
            Once a voting round closes, nothing left anywhere says which votes were yours — not to you, not to the
            organizers.{' '}
            <Link href={HELP_PRIVACY.never} className="underline">
              {LEARN_MORE}
            </Link>
          </p>
          <p>
            What you published on the open network is already yours. The file tells you how to download all of it in
            one archive.
          </p>
        </Details>
      </div>

      <WarningBox title="Delete my account" data-testid="delete-account">
        <p className="text-xs text-muted-foreground">
          This removes your profile, memberships, RSVPs, saved sessions and notifications, and signs you out
          everywhere. You cannot undo it.
        </p>
        <Details>
          <p>
            Sessions you proposed stay on the schedules they are on: they are yours, and the gatherings have no
            authority over them. Paid tickets keep their amount and lose your name, so a gathering&apos;s books do not
            change because you left.{' '}
            <Link href={HELP_PRIVACY.identity} className="underline">
              {LEARN_MORE}
            </Link>
          </p>
        </Details>
        {preview ? <p className="mt-2 text-xs text-muted-foreground">{preview.pdsSentence}</p> : null}

        {preview && preview.blockingGatherings.length > 0 ? (
          <p className="mt-3 text-xs text-destructive" role="alert">
            You are the only owner of {preview.blockingGatherings.map((g) => g.name).join(', ')}. Make someone
            else an owner there first, then come back.
          </p>
        ) : confirming ? (
          <div className="mt-3 space-y-3">
            <label htmlFor={`${id}-confirm`} className="block text-xs">
              Type <span className="font-mono">{expected}</span> to confirm.
            </label>
            <Input id={`${id}-confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            <ConfirmInline
              message="Delete this account? Everything above happens now, and it cannot be undone."
              confirmLabel="Delete my account"
              destructive
              loading={busy}
              onConfirm={() => { if (matches) void remove() }}
              onCancel={() => { setConfirming(false); setTyped('') }}
            />
            {!matches && typed ? <p className="text-xs text-destructive" role="alert">That is not your handle.</p> : null}
          </div>
        ) : (
          <Button type="button" variant="destructive" className="mt-3" onClick={() => setConfirming(true)} disabled={!preview}>
            <Trash2 className="h-4 w-4 mr-2" aria-hidden="true" />
            Delete my account
          </Button>
        )}
        <StatusLine message={message} />
      </WarningBox>
    </section>
  )
}

/* ──────────────────── Account → Notifications: calendar subscriptions ──────────────────── */

interface CalendarFeed {
  id: string
  created_at: string
  last_used_at: string | null
}

/**
 * A subscribable calendar URL for the sessions this person has saved (MT §12.8).
 *
 * The URL carries its own credential, because a calendar client holds no cookie — so it is
 * shown once, it is read-only, and it is revocable from here, which is why it lives next to
 * the other things that reach a person without them opening the app.
 */
function CalendarSubscriptions({ active }: { active: boolean }) {
  const id = React.useId()
  const { toast } = useToast()
  const [feeds, setFeeds] = React.useState<CalendarFeed[] | null>(null)
  const [limit, setLimit] = React.useState(3)
  const [fresh, setFresh] = React.useState<{ url: string; webcalUrl: string } | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ feeds: CalendarFeed[]; limit: number }>('/api/me/calendar-feed')
      setFeeds(data.feeds)
      setLimit(data.limit)
    } catch {
      setFeeds([])
    }
  }, [])

  React.useEffect(() => { if (active) void load() }, [active, load])

  const create = async () => {
    setBusy(true)
    setMessage(null)
    try {
      const data = await apiFetch<{ url: string; webcalUrl: string }>('/api/me/calendar-feed', { method: 'POST', json: {} })
      setFresh({ url: data.url, webcalUrl: data.webcalUrl })
      await load()
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof ApiError ? e.message : 'The subscription could not be created.' })
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (feedId: string) => {
    setBusy(true)
    try {
      await apiFetch(`/api/me/calendar-feed?id=${encodeURIComponent(feedId)}`, { method: 'DELETE' })
      setFresh(null)
      setMessage({ type: 'success', text: 'That subscription stops working now.' })
      await load()
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof ApiError ? e.message : 'It could not be revoked.' })
    } finally {
      setBusy(false)
    }
  }

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast({ title: 'Copied', description: 'Paste it into your calendar app.' })
    } catch {
      setMessage({ type: 'error', text: 'Copying failed. Select the link and copy it by hand.' })
    }
  }

  return (
    <section className="space-y-4 border-t pt-4" aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`} className="text-sm font-medium flex items-center gap-2">
        <CalendarClock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        Subscribe to your schedule
      </h3>
      <p className="text-xs text-muted-foreground">
        One calendar address for every session you saved, with a reminder 15 minutes before each. Treat it as a key:
        anyone who has it can read your saved sessions.
      </p>
      <Details>
        <p>
          Your calendar re-checks the address on its own, so schedule changes arrive without you doing anything.
          Revoke it here if it gets out.
        </p>
      </Details>

      {fresh ? (
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
          <p className="text-xs font-medium">Copy this now — it is shown once.</p>
          <code className="block break-all text-xs font-mono">{fresh.url}</code>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => void copy(fresh.url)}>
              <Copy className="h-4 w-4 mr-2" aria-hidden="true" />Copy the address
            </Button>
            <Button asChild size="sm" variant="outline"><a href={fresh.webcalUrl}>Open in my calendar app</a></Button>
          </div>
        </div>
      ) : null}

      {feeds === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : feeds.length === 0 ? (
        <p className="text-xs text-muted-foreground">No calendar is subscribed yet.</p>
      ) : (
        <ul className="space-y-2">
          {feeds.map((feed) => (
            <li key={feed.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <span className="min-w-0 text-xs text-muted-foreground">
                Created {new Date(feed.created_at).toLocaleDateString()}
                {feed.last_used_at ? ` · last fetched ${new Date(feed.last_used_at).toLocaleString()}` : ' · never fetched'}
              </span>
              <Button type="button" size="sm" variant="ghost" className="text-destructive" loading={busy} onClick={() => void revoke(feed.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button type="button" variant="outline" loading={busy} disabled={(feeds?.length ?? 0) >= limit} onClick={() => void create()}>
        <CalendarClock className="h-4 w-4 mr-2" aria-hidden="true" />
        Create a subscription address
      </Button>
      <StatusLine message={message} />
    </section>
  )
}
