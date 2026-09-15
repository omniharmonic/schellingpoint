'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2, KeyRound, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { apiFetch, ApiError } from '@/lib/api/client'

/**
 * The single-use take-ownership reveal. Nothing is fetched until the member presses the
 * button: mail scanners open links, and this link works exactly once.
 */
function RevealContent() {
  const token = useSearchParams().get('token') ?? ''
  const [state, setState] = React.useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'shown'; handle: string; password: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [copied, setCopied] = React.useState(false)

  const reveal = async () => {
    setState({ kind: 'loading' })
    try {
      const data = await apiFetch<{ handle: string; password: string }>(`/api/me/reveal?token=${encodeURIComponent(token)}`)
      setState({ kind: 'shown', handle: data.handle, password: data.password })
    } catch (e) {
      setState({ kind: 'error', message: e instanceof ApiError ? e.message : 'Could not reveal the password.' })
    }
  }

  const copy = async () => {
    if (state.kind !== 'shown') return
    try {
      await navigator.clipboard.writeText(state.password)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-5">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold">Your identity, your password</h1>
          </div>
          <CardDescription>
            This page shows the new password for your ATProto account once. After that it is gone from our servers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {!token && <p className="text-destructive">This link is missing its token.</p>}

          {token && state.kind === 'idle' && (
            <>
              <p>Make sure you are somewhere private and ready to save the password in a password manager.</p>
              <Button onClick={reveal} className="w-full">Reveal my password</Button>
            </>
          )}

          {state.kind === 'loading' && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {state.kind === 'shown' && (
            <>
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
                <p className="text-xs text-muted-foreground">Handle</p>
                <p className="font-mono">@{state.handle}</p>
                <p className="text-xs text-muted-foreground pt-2">Password</p>
                <div className="flex items-center gap-2">
                  <code className="font-mono break-all flex-1" data-testid="revealed-password">{state.password}</code>
                  <Button type="button" variant="outline" size="sm" onClick={copy}>
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                <li>Save this password now. Reloading this page will not show it again.</li>
                <li>Sign in to your PDS with your handle and this password, and change it to one of your own.</li>
                <li>
                  You can export your whole repository at any time with <code>com.atproto.sync.getRepo</code> (a CAR
                  file): your records are yours, not ours.
                </li>
                <li>From now on, publishing here needs a real ATProto sign-in (&ldquo;Sign in with Bluesky / an existing ATProto account&rdquo;).</li>
              </ol>
            </>
          )}

          {state.kind === 'error' && <p className="text-destructive" role="alert">{state.message}</p>}

          <Link href="/" className="block text-center text-xs text-muted-foreground hover:text-foreground">
            Back to the app
          </Link>
        </CardContent>
      </Card>
    </div>
  )
}

export default function RevealPage() {
  return (
    <React.Suspense fallback={<div className="min-h-screen" />}>
      <RevealContent />
    </React.Suspense>
  )
}
