'use client'

import * as React from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useParams } from 'next/navigation'
import {
  User,
  Building2,
  Rocket,
  Hash,
  Send,
  Mail,
  Plus,
  Upload,
  ChevronRight,
  ChevronLeft,
  Users,
  Vote,
  Heart,
  Mic,
  Calendar,
  Check,
} from 'lucide-react'
import type { Profile } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FilterChip } from '@/components/ui/filter-chip'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api/client'
import { PROFILE_INPUT_LIMITS, uploadAvatar, useInterestSuggestions } from '@/components/SettingsModal'

interface OnboardingModalProps {
  /** Kept for callers; the server identifies the account from the session cookie. */
  userId: string
  /** Shown for reference; empty for accounts that signed in with Bluesky. */
  email: string
  initialProfile?: Profile | null
  onComplete: () => void
  /** Event-specific suggested topics (optional, falls back to defaults) */
  suggestedTopics?: string[]
  voteCredits?: number
  votingMechanism?: string
  requireProposalApproval?: boolean
}

// Onboarding asks for a handful; the profile editor allows up to PROFILE_INPUT_LIMITS.interests.
const ONBOARDING_MAX_INTERESTS = 5
const SUGGESTION_CHIPS = 12

// Intro slides explaining the app. Colours are tokens (primary, favorite, signal-cyan).
const introSlides = [
  {
    icon: Users,
    iconBg: 'bg-primary/15',
    iconColor: 'text-primary',
    title: 'You belong in the conversation.',
    description: 'A gathering where everyone helps shape the program. Let’s show you how it works.',
  },
  {
    icon: Vote,
    iconBg: 'bg-primary/15',
    iconColor: 'text-primary',
    title: 'Vote on sessions',
    description: 'Use your credits to support the sessions you want to attend.',
    tip: 'Votes save automatically — there is no submit button.',
  },
  {
    icon: Heart,
    iconBg: 'bg-favorite/15',
    iconColor: 'text-favorite',
    title: 'Save your favorites',
    description: 'Tap the heart to save sessions to “My schedule”. This is separate from voting — it’s your personal bookmark for sessions you plan to attend.',
    tip: 'Favorites don’t cost credits and don’t affect voting.',
  },
  {
    icon: Mic,
    iconBg: 'bg-signal-cyan/15',
    iconColor: 'text-signal-cyan',
    title: 'Propose a session',
    description: 'Have something to share? Propose your own session: choose a format (talk, workshop, discussion, panel or demo) and submit it.',
    tip: 'Organizers review proposals before opening them for voting.',
  },
]

export function OnboardingModal({ email, initialProfile, onComplete, suggestedTopics, voteCredits = 100, votingMechanism = 'quadratic', requireProposalApproval = true }: OnboardingModalProps) {
  const slides = introSlides.map((slide, index) => index === 1 ? {
    ...slide,
    description: votingMechanism === 'quadratic'
      ? `You have ${voteCredits} credits to support the sessions you care about. One vote costs 1 credit, two votes cost 4, and three cost 9. Spread them around or back a favorite.`
      : votingMechanism === 'linear'
      ? `You have ${voteCredits} credits. Each vote costs one credit. Support the sessions you want to see.`
      : `You have ${voteCredits} credits. Give one vote to each session you want to support.`,
  } : index === 3 ? { ...slide, tip: requireProposalApproval ? 'Organizers review proposals before opening them for voting.' : 'Your proposal will be available for the community to discover and support.' } : slide)

  // Organizer topics for this gathering first, then interests fellow members already use.
  const params = useParams<{ slug?: string }>()
  const eventSlug = typeof params?.slug === 'string' ? params.slug : null
  const fetchedInterests = useInterestSuggestions(true, eventSlug)
  const suggestedInterests = React.useMemo(() => {
    const seen = new Set<string>()
    return [...(suggestedTopics ?? []), ...fetchedInterests]
      .filter((t) => {
        const key = t.trim().toLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
      .slice(0, SUGGESTION_CHIPS)
  }, [suggestedTopics, fetchedInterests])
  const [step, setStep] = React.useState(1)
  const [isUploading, setIsUploading] = React.useState(false)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Form state
  const [displayName, setDisplayName] = React.useState(initialProfile?.display_name ?? '')
  const [bio, setBio] = React.useState(initialProfile?.bio ?? '')
  const [avatarUrl, setAvatarUrl] = React.useState(initialProfile?.avatar_url ?? '')
  const [affiliation, setAffiliation] = React.useState(initialProfile?.affiliation ?? '')
  const [building, setBuilding] = React.useState(initialProfile?.building ?? '')
  const [telegram, setTelegram] = React.useState(initialProfile?.telegram ?? '')
  const [interests, setInterests] = React.useState<string[]>(initialProfile?.interests ?? [])
  const [customInterest, setCustomInterest] = React.useState('')

  // Total steps: 4 intro slides + 3 profile steps = 7
  const introStepCount = slides.length
  const profileStepCount = 3
  const totalSteps = introStepCount + profileStepCount

  const isIntroStep = step <= introStepCount
  const profileStep = step - introStepCount // 1, 2, or 3 for profile steps

  const hasInterest = (interest: string) => interests.some((i) => i.toLowerCase() === interest.toLowerCase())

  const toggleInterest = (interest: string) => {
    if (hasInterest(interest)) {
      setInterests(interests.filter((i) => i.toLowerCase() !== interest.toLowerCase()))
    } else if (interests.length < ONBOARDING_MAX_INTERESTS) {
      setInterests([...interests, interest])
    }
  }

  const addCustomInterest = () => {
    const value = customInterest.trim().slice(0, PROFILE_INPUT_LIMITS.interestLength)
    if (value && !hasInterest(value) && interests.length < ONBOARDING_MAX_INTERESTS) {
      setInterests([...interests, value])
      setCustomInterest('')
    }
  }

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setIsUploading(true)
    setError(null)
    try {
      setAvatarUrl(await uploadAvatar(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.')
    } finally {
      setIsUploading(false)
    }
  }

  const handleSubmit = async () => {
    setIsSubmitting(true)
    setError(null)
    try {
      await apiFetch('/api/me/profile', {
        method: 'PATCH',
        json: {
          display_name: displayName,
          bio,
          avatar_url: avatarUrl || null,
          affiliation,
          building,
          telegram,
          interests,
          onboarding_completed: true,
        },
      })
      onComplete()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your profile. Please try again.')
    } finally {
      setIsSubmitting(false)
    }
  }

  const canProceed = () => {
    if (isIntroStep) return true
    switch (profileStep) {
      case 1:
        return displayName.trim().length >= 2
      case 2:
        return true // All optional
      case 3:
        return true // All optional
      default:
        return false
    }
  }

  const Optional = () => <span className="text-muted-foreground font-normal">(optional)</span>

  // Render intro slide
  const renderIntroSlide = () => {
    const slide = slides[step - 1]
    const IconComponent = slide.icon

    return (
      <div className="text-center py-2 sm:py-4">
        <div className={cn('inline-flex p-3 sm:p-4 rounded-full mb-3 sm:mb-4', slide.iconBg)}>
          <IconComponent className={cn('h-8 w-8 sm:h-10 sm:w-10', slide.iconColor)} aria-hidden="true" />
        </div>
        <h3 className="text-lg sm:text-xl font-bold mb-2 sm:mb-3">{slide.title}</h3>
        <p className="text-muted-foreground text-sm sm:text-base mb-3 sm:mb-4">{slide.description}</p>
        {slide.tip && (
          <div className="bg-muted/50 rounded-lg p-3 text-sm">
            <span className="font-medium">Tip:</span> {slide.tip}
          </div>
        )}
      </div>
    )
  }

  // Render profile step
  const renderProfileStep = () => {
    switch (profileStep) {
      case 1:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm font-medium flex items-center gap-2" id="onboarding-photo-label">
                <User className="h-4 w-4" aria-hidden="true" />
                Photo <Optional />
              </p>
              <div className="flex items-center gap-4">
                <div className="h-20 w-20 rounded-full bg-muted flex items-center justify-center overflow-hidden border-2 border-dashed border-border">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                  ) : (
                    <User className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
                  )}
                </div>
                <div>
                  <Button type="button" variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} loading={isUploading} aria-describedby="onboarding-photo-label">
                    {!isUploading && <Upload className="h-4 w-4 mr-2" aria-hidden="true" />}
                    {avatarUrl ? 'Change photo' : 'Upload a photo'}
                  </Button>
                  <input
                    ref={fileInputRef}
                    id="photo-upload"
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoUpload}
                    disabled={isUploading}
                    className="hidden"
                    aria-label="Profile photo"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label htmlFor="onboarding-display-name" className="text-sm font-medium flex items-center gap-2">
                <User className="h-4 w-4" aria-hidden="true" />
                Display name
              </label>
              <Input
                id="onboarding-display-name"
                placeholder="What should people call you?"
                value={displayName}
                maxLength={PROFILE_INPUT_LIMITS.displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="onboarding-affiliation" className="text-sm font-medium flex items-center gap-2">
                <Building2 className="h-4 w-4" aria-hidden="true" />
                Affiliation <Optional />
              </label>
              <Input
                id="onboarding-affiliation"
                placeholder="Company, collective or project"
                value={affiliation}
                maxLength={PROFILE_INPUT_LIMITS.affiliation}
                onChange={(e) => setAffiliation(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="onboarding-bio" className="text-sm font-medium">
                Bio <Optional />
              </label>
              <Input
                id="onboarding-bio"
                placeholder="One line about yourself"
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                maxLength={200}
              />
            </div>
          </div>
        )
      case 2:
        return (
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="onboarding-building" className="text-sm font-medium flex items-center gap-2">
                <Rocket className="h-4 w-4" aria-hidden="true" />
                What are you building? <Optional />
              </label>
              <Input
                id="onboarding-building"
                placeholder="Describe your project or work"
                value={building}
                maxLength={PROFILE_INPUT_LIMITS.building}
                onChange={(e) => setBuilding(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Help others understand what you’re working on.
              </p>
            </div>

            <div className="space-y-2">
              <label htmlFor="onboarding-telegram" className="text-sm font-medium flex items-center gap-2">
                <Send className="h-4 w-4" aria-hidden="true" />
                Messaging handle <Optional />
              </label>
              <Input
                id="onboarding-telegram"
                placeholder="@name or a link"
                value={telegram}
                maxLength={PROFILE_INPUT_LIMITS.telegram}
                onChange={(e) => setTelegram(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Telegram, Signal, Matrix — whatever you use. Members only. You can verify an ENS name later from your account.
              </p>
            </div>

            {email && (
              <div className="p-4 rounded-lg bg-muted/30 border">
                <div className="flex items-center gap-2 text-sm">
                  <Mail className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span className="text-muted-foreground">Email:</span>
                  <span className="font-medium">{email}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">Never shown to other people.</p>
              </div>
            )}
          </div>
        )
      case 3:
        return (
          <fieldset className="space-y-4">
            <legend className="space-y-1">
              <span className="text-sm font-medium flex items-center gap-2">
                <Hash className="h-4 w-4" aria-hidden="true" />
                Topics you’re interested in <Optional />
              </span>
              <span className="block text-xs text-muted-foreground">
                Choose up to {ONBOARDING_MAX_INTERESTS} to help fellow members find you.
              </span>
            </legend>

            {interests.length > 0 && (
              <div className="flex flex-wrap gap-2" aria-label="Your topics">
                {interests.map((interest) => (
                  <FilterChip key={interest} pressed onClick={() => toggleInterest(interest)} icon={<Check className="h-3.5 w-3.5" aria-hidden="true" />}>
                    {interest}
                  </FilterChip>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2" aria-label="Suggested topics">
              {suggestedInterests
                .filter((i) => !hasInterest(i))
                .map((interest) => (
                  <FilterChip
                    key={interest}
                    pressed={false}
                    onClick={() => toggleInterest(interest)}
                    disabled={interests.length >= ONBOARDING_MAX_INTERESTS}
                    icon={<Plus className="h-3.5 w-3.5" aria-hidden="true" />}
                  >
                    {interest}
                  </FilterChip>
                ))}
            </div>

            <div className="flex gap-2">
              <Input
                aria-label="Add your own topic"
                placeholder="Add your own topic"
                value={customInterest}
                maxLength={PROFILE_INPUT_LIMITS.interestLength}
                onChange={(e) => setCustomInterest(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addCustomInterest()
                  }
                }}
                className="flex-1"
                disabled={interests.length >= ONBOARDING_MAX_INTERESTS}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label="Add topic"
                onClick={addCustomInterest}
                disabled={!customInterest.trim() || interests.length >= ONBOARDING_MAX_INTERESTS}
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            {interests.length >= ONBOARDING_MAX_INTERESTS && (
              <p className="text-xs text-muted-foreground">That’s {ONBOARDING_MAX_INTERESTS} topics — you can add more later from your account.</p>
            )}
          </fieldset>
        )
      default:
        return null
    }
  }

  const getStepTitle = () => {
    if (isIntroStep) {
      return `How it works (${step}/${introStepCount})`
    }
    const titles = ['Your profile', 'Contact & projects', 'Your interests']
    return titles[profileStep - 1]
  }

  return (
    <Dialog.Root open><Dialog.Portal><Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/20 backdrop-blur-sm"/><Dialog.Content aria-describedby="onboarding-description" onEscapeKeyDown={e => e.preventDefault()} onPointerDownOutside={e => e.preventDefault()} className="fixed inset-0 z-50 flex items-end sm:items-center justify-center overflow-y-auto outline-none">
      <div className="w-full max-w-lg sm:mx-4 bg-card border rounded-t-xl sm:rounded-xl shadow-xl overflow-hidden max-h-[100dvh] sm:max-h-[90dvh] flex flex-col">
        {/* Header */}
        <div className="p-4 sm:p-6 border-b bg-secondary/60 flex-shrink-0">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-lg bg-primary/20">
              {isIntroStep ? (
                <Calendar className="h-5 w-5 text-primary" aria-hidden="true" />
              ) : (
                <Users className="h-5 w-5 text-primary" aria-hidden="true" />
              )}
            </div>
            <Dialog.Title className="text-lg sm:text-xl font-semibold">{getStepTitle()}</Dialog.Title>
          </div>
          <Dialog.Description id="onboarding-description" className="text-muted-foreground text-sm">
            {isIntroStep
              ? 'A quick overview of how unconference works'
              : 'Set up your profile so others can find and connect with you'
            }
          </Dialog.Description>
          {/* Progress */}
          <div className="flex gap-1 mt-4" aria-hidden="true">
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'h-1 flex-1 rounded-full transition-colors',
                  i < step ? 'bg-primary' : 'bg-muted'
                )}
              />
            ))}
          </div>
        </div>

        {/* Content */}
        <div className="p-4 sm:p-6 space-y-6 min-h-0 flex-1 overflow-y-auto">
          {isIntroStep ? renderIntroSlide() : renderProfileStep()}
        </div>

        {/* Footer */}
        <div className="p-4 sm:p-6 border-t bg-muted/20 space-y-3 flex-shrink-0">
          {error && (
            <div role="alert" className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <div className="flex justify-between">
            <Button
              variant="ghost"
              onClick={() => step > 1 && setStep(step - 1)}
              disabled={step === 1}
            >
              <ChevronLeft className="h-4 w-4 mr-1" aria-hidden="true" />
              Back
            </Button>

            {step < totalSteps ? (
              <Button onClick={() => setStep(step + 1)} disabled={!canProceed()}>
                {isIntroStep ? 'Next' : 'Continue'}
                <ChevronRight className="h-4 w-4 ml-1" aria-hidden="true" />
              </Button>
            ) : (
              <Button onClick={handleSubmit} loading={isSubmitting} disabled={isUploading}>
                Save profile
              </Button>
            )}
          </div>

          {/* Skip intro option */}
          {isIntroStep && step < introStepCount && (
            <div className="text-center">
              <Button variant="link" size="sm" className="text-muted-foreground" onClick={() => setStep(introStepCount + 1)}>
                Skip to your profile
              </Button>
            </div>
          )}
        </div>
      </div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
  )
}
