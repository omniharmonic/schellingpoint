'use client'

import * as React from 'react'
import { useParams } from 'next/navigation'
import {
  Loader2,
  User,
  Building2,
  Rocket,
  Send,
  Hexagon,
  Hash,
  Save,
  X,
  Plus,
  Camera,
  AtSign,
  BadgeCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { useAuth } from '@/hooks/useAuth'
import { apiFetch, ApiError } from '@/lib/api/client'

interface SettingsModalProps {
  isOpen: boolean
  onClose: () => void
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
  ens: string | null
  ens_verified_at: string | null
  show_ens: boolean
  onboarding_completed: boolean
  publish_proposals: boolean
}

/** Limits enforced by PATCH /api/me/profile (src/app/api/me/profile/validate.ts). */
export const PROFILE_INPUT_LIMITS = {
  displayName: 80,
  bio: 1000,
  affiliation: 120,
  building: 500,
  telegram: 40,
  interests: 10,
  interestLength: 40,
} as const

const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/**
 * Upload a profile photo through the app's upload endpoint (package A: `POST /api/uploads`,
 * multipart, returns `{ url }`). Throws an Error with a message fit to show.
 */
export async function uploadAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.')
  if (file.size > AVATAR_MAX_BYTES) throw new Error('That image is larger than 2 MB.')
  const form = new FormData()
  form.append('file', file)
  form.append('purpose', 'avatar')
  try {
    const res = await apiFetch<{ url: string }>('/api/uploads', { method: 'POST', body: form })
    if (!res?.url) throw new Error('Upload did not return a URL.')
    return res.url
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 405)) {
      throw new Error('Photo uploads are not available yet.')
    }
    throw err instanceof Error ? err : new Error('Upload failed.')
  }
}

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

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const { user, refreshProfile } = useAuth()
  const userId = user?.id ?? null
  const params = useParams<{ slug?: string }>()
  const eventSlug = typeof params?.slug === 'string' ? params.slug : null
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const interestInputRef = React.useRef<HTMLInputElement>(null)

  const [profile, setProfile] = React.useState<OwnProfile | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [displayName, setDisplayName] = React.useState('')
  const [bio, setBio] = React.useState('')
  const [affiliation, setAffiliation] = React.useState('')
  const [building, setBuilding] = React.useState('')
  const [telegram, setTelegram] = React.useState('')
  const [avatarUrl, setAvatarUrl] = React.useState('')
  const [interests, setInterests] = React.useState<string[]>([])
  const [newInterest, setNewInterest] = React.useState('')

  const [isSaving, setIsSaving] = React.useState(false)
  const [isUploading, setIsUploading] = React.useState(false)
  const [saveMessage, setSaveMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const [showSuggestions, setShowSuggestions] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(-1)
  const allInterests = useInterestSuggestions(isOpen && Boolean(userId), eventSlug)

  const applyProfile = React.useCallback((p: OwnProfile) => {
    setProfile(p)
    setDisplayName(p.display_name || '')
    setBio(p.bio || '')
    setAffiliation(p.affiliation || '')
    setBuilding(p.building || '')
    setTelegram(p.telegram ? `@${p.telegram}` : '')
    setAvatarUrl(p.avatar_url || '')
    setInterests(p.interests || [])
  }, [])

  // Load the canonical profile each time the modal opens.
  React.useEffect(() => {
    if (!isOpen || !userId) return
    let cancelled = false
    setSaveMessage(null)
    setLoadError(null)
    setNewInterest('')
    setShowSuggestions(false)
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
  }, [isOpen, userId, applyProfile])

  // ATProto identity. Loaded from /api/atproto/me (session cookie) when the modal opens.
  const [atInfo, setAtInfo] = React.useState<AtIdentity | null>(null)
  const [atBusy, setAtBusy] = React.useState(false)
  const [atMessage, setAtMessage] = React.useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [revealUrl, setRevealUrl] = React.useState<string | null>(null)
  const [confirmOwnership, setConfirmOwnership] = React.useState(false)

  const loadAtIdentity = React.useCallback(async () => {
    try {
      setAtInfo(await apiFetch<AtIdentity>('/api/atproto/me'))
    } catch (err) {
      console.error('Error loading ATProto identity:', err)
    }
  }, [])

  React.useEffect(() => {
    if (isOpen) {
      setAtMessage(null)
      setRevealUrl(null)
      setConfirmOwnership(false)
      loadAtIdentity()
    }
  }, [isOpen, loadAtIdentity])

  const filteredSuggestions = React.useMemo(() => {
    const query = newInterest.trim().toLowerCase()
    if (!query) return []
    const chosen = new Set(interests.map((i) => i.toLowerCase()))
    return allInterests.filter((i) => i.toLowerCase().includes(query) && !chosen.has(i.toLowerCase())).slice(0, 8)
  }, [newInterest, allInterests, interests])

  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [isOpen, onClose])

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
    } else if (e.key === 'Escape') {
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
          telegram,
          avatar_url: avatarUrl || null,
          interests,
        },
      })
      applyProfile(res.profile)
      setSaveMessage({ type: 'success', text: 'Saved!' })
      await refreshProfile()
      setTimeout(() => onClose(), 1000)
    } catch (err) {
      setSaveMessage({ type: 'error', text: err instanceof Error ? err.message : 'Failed to save. Please try again.' })
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
          : 'Done. We emailed you a single-use link that shows your new password once.',
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
    } catch (err) {
      console.error('Error updating publish_proposals:', err)
      setAtInfo(previous)
      setAtMessage({ type: 'error', text: 'Could not save that setting. Please try again.' })
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto bg-card border border-border rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b bg-card/95 backdrop-blur-sm rounded-t-2xl">
          <h2 id="settings-modal-title" className="text-lg font-semibold">Edit Profile</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {loadError && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">{loadError}</div>
          )}
          {!profile && !loadError && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {profile && (
            <>
              {/* Avatar */}
              <div className="flex flex-col items-center gap-4">
                <div className="relative group">
                  <div className="h-24 w-24 rounded-full bg-muted flex items-center justify-center overflow-hidden border-2 border-border">
                    {avatarUrl ? (
                      <img
                        src={avatarUrl}
                        alt=""
                        className="h-full w-full object-cover"
                        referrerPolicy="no-referrer"
                        onError={() => setAvatarUrl('')}
                      />
                    ) : (
                      <User className="h-12 w-12 text-muted-foreground" />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    aria-label="Upload a profile photo"
                    className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity flex items-center justify-center"
                  >
                    {isUploading ? <Loader2 className="h-6 w-6 text-white animate-spin" /> : <Camera className="h-6 w-6 text-white" />}
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarUpload} className="hidden" />
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-xs text-muted-foreground">Click to upload a photo</p>
                  {avatarUrl && (
                    <button type="button" className="text-xs underline text-muted-foreground" onClick={() => setAvatarUrl('')}>
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {/* Display Name */}
              <div className="space-y-2">
                <label htmlFor="settings-display-name" className="text-sm font-medium flex items-center gap-2">
                  <User className="h-4 w-4 text-muted-foreground" />
                  Display Name
                </label>
                <Input
                  id="settings-display-name"
                  placeholder="Your name"
                  value={displayName}
                  maxLength={PROFILE_INPUT_LIMITS.displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              {/* Bio */}
              <div className="space-y-2">
                <label htmlFor="settings-bio" className="text-sm font-medium">Bio</label>
                <Textarea
                  id="settings-bio"
                  placeholder="Tell us about yourself..."
                  value={bio}
                  maxLength={PROFILE_INPUT_LIMITS.bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={2}
                />
              </div>

              {/* Affiliation */}
              <div className="space-y-2">
                <label htmlFor="settings-affiliation" className="text-sm font-medium flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  Organization
                </label>
                <Input
                  id="settings-affiliation"
                  placeholder="Your company or organization"
                  value={affiliation}
                  maxLength={PROFILE_INPUT_LIMITS.affiliation}
                  onChange={(e) => setAffiliation(e.target.value)}
                />
              </div>

              {/* Building */}
              <div className="space-y-2">
                <label htmlFor="settings-building" className="text-sm font-medium flex items-center gap-2">
                  <Rocket className="h-4 w-4 text-muted-foreground" />
                  What are you building?
                </label>
                <Textarea
                  id="settings-building"
                  placeholder="Describe your current project..."
                  value={building}
                  maxLength={PROFILE_INPUT_LIMITS.building}
                  onChange={(e) => setBuilding(e.target.value)}
                  rows={2}
                />
              </div>

              {/* Telegram */}
              <div className="space-y-2">
                <label htmlFor="settings-telegram" className="text-sm font-medium flex items-center gap-2">
                  <Send className="h-4 w-4 text-muted-foreground" />
                  Telegram
                </label>
                <Input
                  id="settings-telegram"
                  placeholder="@username"
                  value={telegram}
                  maxLength={PROFILE_INPUT_LIMITS.telegram}
                  onChange={(e) => setTelegram(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Shown only to fellow members of gatherings you join.</p>
              </div>

              {/* Interests */}
              <div className="space-y-2">
                <label htmlFor="settings-interest" className="text-sm font-medium flex items-center gap-2">
                  <Hash className="h-4 w-4 text-muted-foreground" />
                  Interests
                </label>
                <div className="relative">
                  <div className="flex gap-2">
                    <Input
                      id="settings-interest"
                      ref={interestInputRef}
                      placeholder="Type to search interests..."
                      value={newInterest}
                      maxLength={PROFILE_INPUT_LIMITS.interestLength}
                      role="combobox"
                      aria-expanded={showSuggestions && filteredSuggestions.length > 0}
                      aria-controls="settings-interest-suggestions"
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
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {showSuggestions && filteredSuggestions.length > 0 && (
                    <div
                      id="settings-interest-suggestions"
                      role="listbox"
                      className="absolute z-20 top-full left-0 right-12 mt-1 bg-card border rounded-lg shadow-lg overflow-hidden"
                    >
                      {filteredSuggestions.map((suggestion, index) => (
                        <button
                          key={suggestion}
                          type="button"
                          role="option"
                          aria-selected={index === highlightedIndex}
                          className={`w-full px-3 py-2 text-left text-sm hover:bg-muted transition-colors ${index === highlightedIndex ? 'bg-muted' : ''}`}
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
                {interests.length > 0 && (
                  <div className="flex flex-wrap gap-2 pt-2">
                    {interests.map((interest) => (
                      <Badge
                        key={interest}
                        variant="secondary"
                        className="cursor-pointer hover:bg-destructive/20 group"
                        onClick={() => handleRemoveInterest(interest)}
                      >
                        {interest}
                        <X className="h-3 w-3 ml-1 group-hover:text-destructive" />
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              {/* ENS saves on its own; setProfile (not applyProfile) keeps unsaved edits to the fields above. */}
              <EnsSection profile={profile} onProfile={setProfile} />
            </>
          )}

          {/* ATProto identity */}
          {atInfo?.linked && (
            <div className="space-y-3 pt-4 border-t border-border" data-testid="atproto-identity">
              <label className="text-sm font-medium flex items-center gap-2">
                <AtSign className="h-4 w-4 text-muted-foreground" />
                Your identity
              </label>
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 space-y-1">
                <p className="text-sm font-medium truncate">@{atInfo.handle || atInfo.did}</p>
                {atInfo.did && <p className="text-[11px] font-mono text-muted-foreground truncate">{atInfo.did}</p>}
                <p className="text-xs text-muted-foreground">
                  {atInfo.kind === 'oauth'
                    ? 'Your own ATProto account (signed in with Bluesky or another ATProto provider).'
                    : atInfo.owned
                      ? 'Created here, now owned by you. Publishing here needs an ATProto sign-in.'
                      : 'Created for you by this app, which holds its password on your behalf.'}
                </p>
              </div>

              <label className="flex items-start gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4"
                  checked={atInfo.publishProposals}
                  onChange={(e) => handleAtPublishToggle(e.target.checked)}
                  disabled={atBusy}
                />
                <span>
                  <span className="font-medium">Publish my proposals to my repo</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Proposals you submit are written to your own repository on the open network under this
                    identity. They are public and may be copied by other services even after you delete them.
                  </span>
                </span>
              </label>

              {atInfo.kind === 'custodial' && !atInfo.owned && (
                <div className="rounded-lg border border-border p-3 space-y-2" data-testid="take-ownership">
                  <p className="text-sm font-medium">Take ownership of this identity</p>
                  <p className="text-xs text-muted-foreground">
                    We will set a new password on your account and email you a link that shows it once. After that we
                    no longer hold your password: you can sign in to your PDS yourself, change the password, export your
                    repository, or move to another provider. Publishing from this app will then need you to sign in with
                    this account through &ldquo;an existing ATProto account&rdquo;. This cannot be undone.
                  </p>
                  <label className="flex items-start gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-4 w-4"
                      checked={confirmOwnership}
                      onChange={(e) => setConfirmOwnership(e.target.checked)}
                      disabled={atBusy}
                    />
                    <span>I understand, and I will save the password when it is shown.</span>
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleTakeOwnership}
                    disabled={atBusy || !confirmOwnership}
                  >
                    {atBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Take ownership'}
                  </Button>
                </div>
              )}

              {revealUrl && (
                <a href={revealUrl} className="block text-xs underline break-all">
                  Open the single-use reveal link
                </a>
              )}
              {atMessage && (
                <p className={`text-xs ${atMessage.type === 'success' ? 'text-green-500' : 'text-destructive'}`}>
                  {atMessage.text}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 flex items-center justify-between gap-4 p-4 border-t bg-card/95 backdrop-blur-sm rounded-b-2xl">
          <div className="flex-1">
            {saveMessage && (
              <p role="status" className={`text-sm ${saveMessage.type === 'success' ? 'text-green-500' : 'text-destructive'}`}>
                {saveMessage.text}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSaving || isUploading || !profile} className="btn-primary-glow">
              {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * ENS: self-written, verified by a wallet signature, shown to fellow members only when verified
 * and opted in (spec §7). Saves immediately, separately from the rest of the form.
 */
function EnsSection({ profile, onProfile }: { profile: OwnProfile; onProfile: (p: OwnProfile) => void }) {
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
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save that setting.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <label htmlFor="settings-ens" className="text-sm font-medium flex items-center gap-2">
        <Hexagon className="h-4 w-4 text-muted-foreground" />
        ENS Name
        {verified && (
          <Badge variant="outline" className="text-[10px] gap-1">
            <BadgeCheck className="h-3 w-3" /> verified
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
          <Button type="button" variant="outline" onClick={removeEns} disabled={busy}>
            Remove
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={startVerify} disabled={busy || !name.trim()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Verify'}
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
          <pre className="text-[11px] whitespace-pre-wrap bg-muted/40 rounded p-2 select-all">{manual.message}</pre>
          <Input placeholder="0x…" value={pasted} onChange={(e) => setPasted(e.target.value.trim())} />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy || !pasted}
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

      <label className="flex items-start gap-3 text-sm cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 h-4 w-4"
          checked={profile.show_ens}
          disabled={busy || !profile.ens_verified_at}
          onChange={(e) => toggleShow(e.target.checked)}
        />
        <span>
          <span className="font-medium">Show my verified ENS name to fellow members</span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Visible only in the member directory of gatherings you belong to. Never published to the network.
          </span>
        </span>
      </label>

      {message && (
        <p role="status" className={`text-xs ${message.type === 'success' ? 'text-green-500' : 'text-destructive'}`}>
          {message.text}
        </p>
      )}
    </div>
  )
}
