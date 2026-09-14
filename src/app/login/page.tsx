'use client'

import * as React from 'react'
import { safeReturnPath } from '@/lib/auth-redirect'
import { GatheringArtwork, NetworkMark } from '@/components/GatheringArtwork'
import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Mail, CheckCircle, ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/hooks/useAuth'

function LoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, signIn, isLoading: authLoading } = useAuth()

  const [email, setEmail] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(false)
  const [emailSent, setEmailSent] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Redirect if already logged in
  React.useEffect(() => {
    if (user && !authLoading) {
      const redirect = searchParams.get('returnTo') || searchParams.get('redirect')
      router.push(safeReturnPath(redirect))
    }
  }, [user, authLoading, router, searchParams])

  const [loggedOutMessage, setLoggedOutMessage] = React.useState(false)

  // Check for auth errors or logged out state
  React.useEffect(() => {
    if (searchParams.get('error') === 'auth') {
      setError('Authentication failed. Please try again.')
    }
    if (searchParams.get('error') === 'atproto') {
      setError('Bluesky sign-in did not complete. Please try again.')
    }
    if (searchParams.get('logged_out') === 'true') {
      setLoggedOutMessage(true)
    }
  }, [searchParams])

  // Sign in with Bluesky (ATProto OAuth). Hidden until the server says it is configured.
  const [atConfigured, setAtConfigured] = React.useState(false)
  const [atHandle, setAtHandle] = React.useState('')
  const [atLoading, setAtLoading] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    fetch('/api/atproto/me', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data?.configured) setAtConfigured(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const handleBluesky = async (e: React.FormEvent) => {
    e.preventDefault()
    const handle = atHandle.trim().replace(/^@/, '')
    if (!handle) return
    setAtLoading(true)
    setError(null)
    try {
      const next = safeReturnPath(searchParams.get('returnTo') || searchParams.get('redirect'))
      const qs = new URLSearchParams({ handle, purpose: 'signin', next })
      const res = await fetch(`/api/atproto/auth/start?${qs}`, { headers: { Accept: 'application/json' } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data?.url) {
        setError(data?.detail || 'Could not start Bluesky sign-in. Check the handle and try again.')
        setAtLoading(false)
        return
      }
      window.location.assign(data.url)
    } catch {
      setError('Could not start Bluesky sign-in. Please try again.')
      setAtLoading(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return

    setIsLoading(true)
    setError(null)

    const { error } = await signIn(email.trim(), safeReturnPath(searchParams.get('returnTo') || searchParams.get('redirect')))

    if (error) {
      setError(error.message)
      setIsLoading(false)
    } else {
      setEmailSent(true)
      setIsLoading(false)
    }
  }

  if (emailSent) {
    return (
      <div className="min-h-screen grid lg:grid-cols-2 items-center gap-8 p-5 sm:p-12 lg:p-20">
      <div className="hidden lg:block max-w-xl"><Link href="/" className="flex items-center gap-3 font-semibold text-xl mb-10"><NetworkMark className="w-8 h-8 text-primary" />Schelling Point</Link><GatheringArtwork compact /><p className="text-3xl font-semibold tracking-tight mt-8 max-w-md">The most interesting person in the room might be someone you haven’t met yet.</p></div>
        <Card className="w-full max-w-md mx-auto border-0 bg-transparent shadow-none">
          <CardHeader className="text-left">
            <div className="flex justify-center mb-4">
              <div className="node-indicator w-4 h-4" />
            </div>
            <h1 className="text-3xl font-display leading-tight font-semibold">Check your inbox</h1>
            <CardDescription className="text-xs tracking-wider">
              We sent a sign-in link to
            </CardDescription>
            <p className="text-sm text-foreground mt-1">{email}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="protocol-box border-border text-sm text-center text-muted-foreground">
              <p>Open the link in your email to pick up where you left off.</p>
              <p className="mt-2 text-xs">Can’t find it? Check your spam folder, or try again.</p>
            </div>
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                setEmailSent(false)
                setEmail('')
              }}
            >
              Use a different email
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 items-center gap-8 p-5 sm:p-12 lg:p-20">
      <div className="hidden lg:block max-w-xl"><Link href="/" className="flex items-center gap-3 font-semibold text-xl mb-10"><NetworkMark className="w-8 h-8 text-primary" />Schelling Point</Link><GatheringArtwork compact /><p className="text-3xl font-semibold tracking-tight mt-8 max-w-md">The most interesting person in the room might be someone you haven’t met yet.</p></div>
      <Card className="w-full max-w-md mx-auto border-0 bg-transparent shadow-none">
        <CardHeader className="text-left">
          <Link
            href="/"
            className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-4 tracking-wider"
          >
            <ArrowLeft className="h-3.5 w-3.5 mr-1" strokeWidth={1.5} />
            Back
          </Link>
          <div className="flex justify-center mb-4">
            <div className="node-indicator-idle w-10 h-10 flex items-center justify-center">
              <Mail className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} />
            </div>
          </div>
          <h1 className="text-3xl font-display leading-tight font-semibold">Welcome to the gathering.</h1>
          <CardDescription>
            Sign in or create an account with your email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {loggedOutMessage && (
              <div className="protocol-box border-border text-sm text-center">
                You’re signed out. Sign in whenever you’re ready.
              </div>
            )}
            {error && (
              <div id="login-error" role="alert" className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive font-mono">
                {error}
              </div>
            )}
            <div className="space-y-2">
              <label htmlFor="email" className="block text-sm font-medium">Email address</label>
              <Input
                type="email"
                id="email"
                autoComplete="email"
                name="email"
                placeholder="you@example.com"
                aria-describedby={error ? "login-error" : undefined}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                required
                className="text-base"
              />
            </div>
            <Button type="submit" className="w-full" loading={isLoading}>
              Send sign-in link <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </form>
          {atConfigured && (
            <div className="mt-6 pt-6 border-t border-border" data-testid="bluesky-signin">
              <p className="text-xs tracking-wider text-muted-foreground mb-3">Or sign in with Bluesky</p>
              <form onSubmit={handleBluesky} className="space-y-3">
                <div className="space-y-2">
                  <label htmlFor="at-handle" className="block text-sm font-medium">Bluesky handle</label>
                  <Input
                    id="at-handle"
                    name="handle"
                    autoComplete="username"
                    placeholder="you.bsky.social"
                    value={atHandle}
                    onChange={(e) => setAtHandle(e.target.value)}
                    disabled={atLoading}
                    className="text-base"
                  />
                </div>
                <Button type="submit" variant="outline" className="w-full" loading={atLoading} disabled={!atHandle.trim()}>
                  Continue with Bluesky <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <p className="text-xs text-muted-foreground">
                  Your proposals and public actions will be attached to this identity on the open network.
                </p>
              </form>
            </div>
          )}
          <p className="text-xs text-center text-muted-foreground mt-4 font-mono">
            No password to remember.
            <br />
            <span className="text-foreground/60">New here? Your account is created when you sign in.</span>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  )
}
