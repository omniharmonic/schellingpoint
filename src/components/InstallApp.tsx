'use client'

/**
 * The offer to put unconference on someone's home screen, in the two shapes the app needs:
 * a card at the end of onboarding and a row in a list (the More sheet, Account → Profile).
 *
 * Both draw from `useInstallPrompt`, so both disappear together: once the app is installed, or
 * once the person has said no, there is nothing here on any surface for 30 days. Neither shape
 * renders anything at all when there is nothing to offer — no empty box, no disabled button.
 *
 * On iOS there is no install API, only a place to point at, so the offer becomes an instruction
 * the person opens and closes themselves. That is deliberately not a button that looks like it
 * installs something and then does not.
 */

import * as React from 'react'
import { Share, Smartphone, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useInstallPrompt } from '@/hooks/useInstallPrompt'
import { cn } from '@/lib/utils'

/** "Tap Share, then Add to Home Screen" — the only thing anyone can do about it on iOS. */
function IosInstructions({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-start gap-2 text-xs text-muted-foreground', className)} data-testid="install-ios-steps">
      <Share className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <p>
        Tap Share, then Add to Home Screen.
        <span className="block">It opens full screen, without the browser bars.</span>
      </p>
    </div>
  )
}

/**
 * The onboarding card (design §3.6 — the last step is optional and skippable, and so is this).
 * One line that says what happens, one button, and one dismiss that never comes back.
 */
export function InstallAppCard({ className }: { className?: string }) {
  const { kind, install, dismiss, outcome } = useInstallPrompt()
  if (!kind) return null

  return (
    <div className={cn('rounded-lg border p-3', className)} data-testid="install-card">
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Smartphone className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          Add to your home screen
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Not now"
          onClick={dismiss}
          className="-mr-1 -mt-1 shrink-0 text-muted-foreground"
          data-testid="install-dismiss"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {kind === 'ios' ? (
        <IosInstructions className="mt-2" />
      ) : (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            The schedule opens in one tap, and what you have already loaded still reads with no signal.
          </p>
          <Button variant="outline" size="sm" className="mt-3" onClick={install} data-testid="install-button">
            Add to home screen
          </Button>
          {outcome === 'dismissed' && (
            <p className="mt-2 text-xs text-muted-foreground">Not added. You can add it later from More.</p>
          )}
          {outcome === 'unavailable' && (
            <p className="mt-2 text-xs text-muted-foreground">
              Your browser would not open the dialog. Look for “Install” in its own menu.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/**
 * One row for a list of rows. `className` carries the list's own row styling so this matches its
 * neighbours exactly rather than approximating them.
 */
export function InstallAppRow({ className, onInstalled }: { className?: string; onInstalled?: () => void }) {
  const { kind, install, outcome } = useInstallPrompt()
  const [showSteps, setShowSteps] = React.useState(false)
  if (!kind) return null

  return (
    <div data-testid="install-row-wrap">
      <button
        type="button"
        data-testid="install-row"
        aria-expanded={kind === 'ios' ? showSteps : undefined}
        onClick={async () => {
          if (kind === 'ios') {
            setShowSteps((open) => !open)
            return
          }
          if ((await install()) === 'accepted') onInstalled?.()
        }}
        className={className}
      >
        <Smartphone className="h-[18px] w-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
        Install the app
      </button>
      {kind === 'ios' && showSteps && <IosInstructions className="px-3 pb-2" />}
      {outcome === 'unavailable' && (
        <p className="px-3 pb-2 text-xs text-muted-foreground">
          Your browser would not open the dialog. Look for “Install” in its own menu.
        </p>
      )}
    </div>
  )
}
