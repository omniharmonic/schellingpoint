'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2, KeyRound, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'
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
  const [copied, setCopied] = React.useState<'idle' | 'copied' | 'failed'>('idle')

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
      setCopied('copied')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <main className="container mx-auto flex flex-1 items-center justify-center px-5 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            Your identity, your password
          </CardTitle>
          <CardDescription>
            This page shows the new password for your ATProto account once. After that it is gone from our servers.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {!token && (
            <p className="text-destructive" role="alert">
              This link is missing its token. Open the link from your email, or request a new one from Account → Identity.
            </p>
          )}

          {token && state.kind === 'idle' && (
            <>
              <p>Make sure you are somewhere private and ready to save the password in a password manager.</p>
              <Button onClick={reveal} className="w-full">Reveal my password</Button>
            </>
          )}

          {state.kind === 'loading' && (
            <div className="flex justify-center py-6" role="status" aria-label="Revealing">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
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
                    {copied === 'copied' ? <Check className="h-4 w-4 mr-2" aria-hidden="true" /> : <Copy className="h-4 w-4 mr-2" aria-hidden="true" />}
                    {copied === 'copied' ? 'Copied' : 'Copy password'}
                  </Button>
                </div>
                <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
                  {copied === 'copied' ? 'Password copied to your clipboard.' : copied === 'failed' ? 'Copying failed — select the password and copy it by hand.' : ''}
                </p>
              </div>
              <ol className="list-decimal pl-5 space-y-1 text-muted-foreground">
                <li>Save this password now. Reloading this page will not show it again.</li>
                <li>Sign in to your PDS with your handle and this password, and change it to one of your own.</li>
                <li>You can export your whole repository at any time from your PDS. Your records are yours, not ours.</li>
                <li>From now on, publishing here needs an ATProto sign-in (“Sign in with Bluesky / an existing ATProto account”).</li>
              </ol>
            </>
          )}

          {state.kind === 'error' && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 space-y-2" role="alert">
              <p className="text-destructive">{state.message}</p>
              <p className="text-xs text-muted-foreground">
                Reveal links work once and expire. To get a new one, open Account → Identity and take ownership again; if
                that is no longer offered, contact the operator of this instance.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href="/account">Open Account</Link>
              </Button>
            </div>
          )}

          <Link href="/" className="block text-center text-sm text-muted-foreground hover:text-foreground">
            Back to unconference
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}

export default function RevealPage() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <React.Suspense fallback={<div className="flex-1" />}>
        <RevealContent />
      </React.Suspense>
      <Footer variant="minimal" />
    </div>
  )
}
