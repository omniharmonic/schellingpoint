'use client'

import * as React from 'react'
import { safeReturnPath } from '@/lib/auth-redirect'
import { GatheringArtwork, NetworkMark } from '@/components/GatheringArtwork'
import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Mail, ArrowLeft, ArrowRight, Loader2 } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { useAuth } from '@/hooks/useAuth'

/** Where the "Back" link goes and what it says, from the `returnTo` path alone (no fetch). */
function backLink(returnTo: string): { href: string; label: string } {
  const gathering = /^\/e\/[^/]+/.exec(returnTo)
  if (gathering) return { href: gathering[0], label: 'Back to the gathering' }
  return { href: returnTo === '/' ? '/' : returnTo, label: returnTo === '/' ? 'Back' : 'Back to where you were' }
}

function LoginContent({ atConfigured }: { atConfigured: boolean }) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { user, signIn, isLoading: authLoading } = useAuth()

  // `returnTo` is the only login return parameter (release design §2.7).
  const returnTo = safeReturnPath(searchParams.get('returnTo'))
  const back = backLink(returnTo)

  const [email, setEmail] = React.useState('')
  const [isLoading, setIsLoading] = React.useState(false)
  const [emailSent, setEmailSent] = React.useState(false)
  const [resent, setResent] = React.useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = React.useState<string | null>(null)

  // Redirect if already logged in
  React.useEffect(() => {
    if (user && !authLoading) {
      router.push(returnTo)
    }
  }, [user, authLoading, router, returnTo])

  const [loggedOutMessage, setLoggedOutMessage] = React.useState(false)

  // Check for auth errors or logged out state
  React.useEffect(() => {
    if (searchParams.get('error') === 'auth') {
      setError('Sign-in did not complete. Please try again.')
    }
    if (searchParams.get('error') === 'atproto') {
      setError('Bluesky sign-in did not complete. Please try again.')
    }
    if (searchParams.get('error') === 'link') {
      setError('That sign-in link has expired or was already used. Enter your email to get a new one.')
    }
    if (searchParams.get('logged_out') === 'true') {
      setLoggedOutMessage(true)
    }
  }, [searchParams])

  // Availability comes from the server-rendered page, without another network request.
  const [atHandle, setAtHandle] = React.useState('')
  const [atLoading, setAtLoading] = React.useState(false)
  const [atConfirmed, setAtConfirmed] = React.useState(false)
  const [devVerifyUrl, setDevVerifyUrl] = React.useState<string | null>(null)

  const handleBluesky = async (e: React.FormEvent) => {
    e.preventDefault()
    const handle = atHandle.trim().replace(/^@/, '')
    if (!handle || !atConfirmed) return
    setAtLoading(true)
    setError(null)
    try {
      const qs = new URLSearchParams({ handle, purpose: 'signin', next: returnTo, confirm: '1' })
      const res = await fetch(`/api/atproto/auth/start?${qs}`, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
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

  const sendLink = async (): Promise<boolean> => {
    const { error, devVerifyUrl: devUrl } = await signIn(email.trim(), returnTo)
    if (error) {
      setError(error.message)
      return false
    }
    setDevVerifyUrl(process.env.NODE_ENV === 'development' && devUrl ? devUrl : null)
    return true
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email) return
    setIsLoading(true)
    setError(null)
    const ok = await sendLink()
    if (ok) {
      setEmailSent(true)
      setResent('idle')
    }
    setIsLoading(false)
  }

  const handleResend = async () => {
    setResent('sending')
    setError(null)
    const ok = await sendLink()
    setResent(ok ? 'sent' : 'idle')
  }

  const aside = (
    <div className="hidden lg:block max-w-xl">
      <Link href="/" className="flex items-center gap-3 font-semibold text-xl mb-10"><NetworkMark className="w-8 h-8 text-primary" />unconference</Link>
      <GatheringArtwork compact />
      <p className="text-3xl font-semibold tracking-tight mt-8 max-w-md">The most interesting person in the room might be someone you haven’t met yet.</p>
    </div>
  )

  if (emailSent) {
    return (
      <div className="min-h-screen grid lg:grid-cols-2 items-center gap-8 p-5 sm:p-12 lg:p-20">
        {aside}
        <Card className="w-full max-w-md mx-auto border-0 bg-transparent shadow-none">
          <CardHeader className="text-left">
            <div className="flex justify-center mb-4">
              <div className="node-indicator w-4 h-4" aria-hidden="true" />
            </div>
            <h1 className="text-3xl font-display leading-tight font-semibold">Check your inbox</h1>
            <CardDescription className="text-xs tracking-wider">We sent a sign-in link to</CardDescription>
            <p className="text-sm text-foreground mt-1">{email}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="protocol-box border-border text-sm text-center text-muted-foreground" role="status">
              <p>Open the link in your email to pick up where you left off.</p>
              <p className="mt-2 text-xs">It works once and expires in 15 minutes. Can’t find it? Check your spam folder, or send it again.</p>
            </div>
            {error && (
              <div role="alert" className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                {error}
              </div>
            )}
            {devVerifyUrl && (
              <div className="rounded-md border border-dashed border-border p-3 text-xs" data-testid="dev-verify-url">
                <p className="text-muted-foreground mb-1">Development: mail is not configured.</p>
                <a href={devVerifyUrl} className="underline break-all">Open the sign-in link</a>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <Button variant="outline" className="w-full" onClick={handleResend} loading={resent === 'sending'} disabled={resent === 'sent'}>
                {resent === 'sent' ? 'Sent again' : 'Send it again'}
              </Button>
              <Button
                variant="ghost"
                className="w-full"
                onClick={() => {
                  setEmailSent(false)
                  setDevVerifyUrl(null)
                  setEmail('')
                  setError(null)
                }}
              >
                Use a different email
              </Button>
            </div>
            <p className="text-center">
              <Link href={back.href} className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground tracking-wider">
                <ArrowLeft className="h-3.5 w-3.5 mr-1" strokeWidth={1.5} aria-hidden="true" />
                {back.label}
              </Link>
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 items-center gap-8 p-5 sm:p-12 lg:p-20">
      {aside}
      <Card className="w-full max-w-md mx-auto border-0 bg-transparent shadow-none">
        <CardHeader className="text-left">
          <Link href={back.href} className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground mb-4 tracking-wider">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" strokeWidth={1.5} aria-hidden="true" />
            {back.label}
          </Link>
          <div className="flex justify-center mb-4">
            <div className="node-indicator-idle w-10 h-10 flex items-center justify-center">
              <Mail className="h-5 w-5 text-muted-foreground" strokeWidth={1.5} aria-hidden="true" />
            </div>
          </div>
          <h1 className="text-3xl font-display leading-tight font-semibold">Welcome to the gathering.</h1>
          <CardDescription>
            Sign in or create an account with your email. We’ll create your unconference identity if you don’t have
            one yet — your handle is generated, never derived from your email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {loggedOutMessage && (
              <div className="protocol-box border-border text-sm text-center" role="status">
                You’re signed out. Sign in whenever you’re ready.
              </div>
            )}
            {error && (
              <div id="login-error" role="alert" className="rounded-md bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
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
                aria-describedby={error ? 'login-error' : undefined}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
                required
                className="text-base"
              />
            </div>
            <Button type="submit" className="w-full" loading={isLoading}>
              Send sign-in link <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
            </Button>
          </form>
          {atConfigured && (
            <div className="mt-6 pt-6 border-t border-border" data-testid="bluesky-signin">
              <p className="text-xs tracking-wider text-muted-foreground mb-3">
                Or sign in with Bluesky / an existing ATProto account
              </p>
              <form onSubmit={handleBluesky} className="space-y-3">
                <div className="space-y-2">
                  <label htmlFor="at-handle" className="block text-sm font-medium">Handle</label>
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
                <div className="flex items-start gap-3 text-sm">
                  <Checkbox
                    id="at-confirm"
                    className="mt-0.5"
                    checked={atConfirmed}
                    onCheckedChange={(checked) => setAtConfirmed(checked === true)}
                    disabled={atLoading}
                    data-testid="bluesky-confirm"
                  />
                  <label htmlFor="at-confirm" className="cursor-pointer">
                    Your proposals and public actions will be permanently attached to this identity.
                    <span className="block text-xs text-muted-foreground mt-0.5">
                      Records written to an existing account are public on the open network and can be copied by other
                      services. Signing in also imports your public profile (name, photo, bio); you can edit it here or
                      re-sync it later from Account → Identity. If you would rather keep this gathering separate, use
                      email above instead.
                    </span>
                  </label>
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  className="w-full"
                  loading={atLoading}
                  disabled={!atHandle.trim() || !atConfirmed}
                >
                  Continue with this account <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                </Button>
              </form>
            </div>
          )}
          <p className="text-xs text-center text-muted-foreground mt-4">
            No password to remember.
            <br />
            <span className="text-foreground/60">New here? Your identity is created when you sign in.</span>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

export default function LoginClient({ atConfigured }: { atConfigured: boolean }) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4" role="status" aria-label="Loading">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
        </div>
      }
    >
      <LoginContent atConfigured={atConfigured} />
    </Suspense>
  )
}
