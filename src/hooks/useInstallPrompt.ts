'use client'

/**
 * Whether, and how, to offer to put this app on someone's home screen.
 *
 * Three answers, and the hook's whole job is to tell them apart:
 *
 *  · `'prompt'` — a Chromium browser has fired `beforeinstallprompt`, so there is a real install
 *    dialog to open and `install()` opens it and reports what the person chose.
 *  · `'ios'` — Safari never fires that event and has no API for it. All anyone can do is say
 *    where the button is: Share, then Add to Home Screen.
 *  · `null` — nothing to offer. The app is already running from the home screen, or the person
 *    said no once, or the browser has neither the event nor an iOS share sheet.
 *
 * No nagging is the rule, not a preference: `dismiss()` writes one timestamp and the offer stays
 * gone for 30 days, on every surface at once. Storage can throw (private windows, blocked site
 * data) and a browser that cannot remember the dismissal must not therefore show the card
 * forever, so a failed read is treated as "dismissed" and a failed write still hides the offer
 * for this session.
 */

import * as React from 'react'

const DISMISSED_KEY = 'pwa-install-dismissed'
const DISMISSED_DAYS = 30

/** The event Chromium fires when the app is installable. Not in lib.dom yet. */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export type InstallKind = 'prompt' | 'ios'
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

export interface InstallPrompt {
  /** What to draw: a button, an instruction, or nothing. */
  kind: InstallKind | null
  /** Opens the browser's install dialog. Only meaningful when `kind === 'prompt'`. */
  install: () => Promise<InstallOutcome>
  /** The person's one "no". Hides every install surface for 30 days. */
  dismiss: () => void
  /** What came back from the last `install()`, for a line of feedback. */
  outcome: InstallOutcome | null
}

/** True once the app is running as an installed app rather than in a browser tab. */
function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true
  } catch {
    // A browser without matchMedia is a browser without installation.
  }
  // Safari's own, pre-standard flag, which is the only one iOS sets.
  return (window.navigator as Navigator & { standalone?: boolean }).standalone === true
}

/** Safari on iOS or iPadOS, where "install" means the share sheet and nothing else. */
function isIosSafari(): boolean {
  const ua = window.navigator.userAgent
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1)
  if (!ios) return false
  // Chrome and Firefox on iOS are Safari underneath but show a different share menu, and neither
  // offers Add to Home Screen in the place this copy points at.
  return !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)
}

function dismissedRecently(): boolean {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    if (!raw) return false
    const at = Number(raw)
    if (!Number.isFinite(at)) return true
    return Date.now() - at < DISMISSED_DAYS * 24 * 60 * 60 * 1000
  } catch {
    // Nowhere to remember a "no" is nowhere to be sure we may ask, so we do not.
    return true
  }
}

export function useInstallPrompt(): InstallPrompt {
  // Nothing is offered until the client has looked: the server cannot know whether this is a tab
  // or a home-screen app, and a card that appears and vanishes is worse than one that arrives late.
  const [kind, setKind] = React.useState<InstallKind | null>(null)
  const [outcome, setOutcome] = React.useState<InstallOutcome | null>(null)
  const deferred = React.useRef<BeforeInstallPromptEvent | null>(null)

  React.useEffect(() => {
    if (isStandalone() || dismissedRecently()) return

    const onBeforeInstallPrompt = (event: Event) => {
      // Keeping the event is the point: without `preventDefault` Chromium may show its own
      // mini-infobar and the event is spent before anyone taps our row.
      event.preventDefault()
      deferred.current = event as BeforeInstallPromptEvent
      setKind('prompt')
    }
    const onInstalled = () => {
      deferred.current = null
      setKind(null)
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)

    // Safari fires nothing, so the instruction is all there is.
    if (isIosSafari()) setKind('ios')

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const install = React.useCallback(async (): Promise<InstallOutcome> => {
    const event = deferred.current
    if (!event) {
      setOutcome('unavailable')
      return 'unavailable'
    }
    try {
      await event.prompt()
      const { outcome: chosen } = await event.userChoice
      setOutcome(chosen)
      // The event is single-use either way; a second tap would throw.
      deferred.current = null
      if (chosen === 'accepted') setKind(null)
      return chosen
    } catch {
      deferred.current = null
      setOutcome('unavailable')
      return 'unavailable'
    }
  }, [])

  const dismiss = React.useCallback(() => {
    setKind(null)
    try {
      window.localStorage.setItem(DISMISSED_KEY, String(Date.now()))
    } catch {
      // The offer is gone for this session regardless; it may come back on the next one.
    }
  }, [])

  return { kind, install, dismiss, outcome }
}
