'use client'

import * as React from 'react'
import Link from 'next/link'
import { MailX, CheckCircle, XCircle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

interface UnsubscribeClientProps {
  token: string
  valid: boolean
  /** The gathering the email came from, when it came from one. */
  eventName: string | null
}

/**
 * The page behind the "Stop emails like this" link (inventory P2-7).
 *
 * Nothing happens until the button is pressed: a GET must never change a preference,
 * because link scanners and mail previewers follow every URL in an email. The one-click
 * header points at `POST /api/unsubscribe` instead, which mail clients call directly.
 */
export function UnsubscribeClient({ token, valid, eventName }: UnsubscribeClientProps) {
  const [state, setState] = React.useState<'idle' | 'working' | 'done' | 'error'>('idle')

  const unsubscribe = async () => {
    setState('working')
    try {
      const res = await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      setState(res.ok ? 'done' : 'error')
    } catch {
      setState('error')
    }
  }

  const scope = eventName ? `emails about ${eventName}` : 'notification emails'

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex flex-1 flex-col items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mb-4 flex justify-center">
              <div className={`rounded-full p-4 ${state === 'done' ? 'bg-success/10' : valid ? 'bg-muted' : 'bg-destructive/10'}`}>
                {state === 'done' ? (
                  <CheckCircle className="h-10 w-10 text-success" aria-hidden />
                ) : valid ? (
                  <MailX className="h-10 w-10 text-muted-foreground" aria-hidden />
                ) : (
                  <XCircle className="h-10 w-10 text-destructive" aria-hidden />
                )}
              </div>
            </div>
            <CardTitle className="text-2xl">
              {state === 'done' ? 'Email turned off' : valid ? 'Stop these emails?' : 'This link is not valid'}
            </CardTitle>
            <CardDescription>
              {state === 'done'
                ? `You will not get ${scope} any more. Your in-app notifications are unchanged, and you can turn email back on at any time from notification settings.`
                : valid
                  ? `We will turn off ${scope}. Your in-app notifications stay as they are, and nothing else about your account changes.`
                  : 'It may have been mistyped or truncated by a mail client. You can change every notification preference from your settings instead.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-center">
            {state === 'error' && (
              <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
                That did not work. Please try again, or change the preference from your settings.
              </p>
            )}
            {valid && state !== 'done' && (
              <Button className="w-full" size="lg" onClick={unsubscribe} loading={state === 'working'}>
                Turn these emails off
              </Button>
            )}
            <Button asChild variant="outline" className="w-full">
              <Link href="/">Go to unconference.events</Link>
            </Button>
          </CardContent>
        </Card>
      </main>
      <Footer variant="minimal" />
    </div>
  )
}
