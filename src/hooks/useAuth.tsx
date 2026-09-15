'use client'

import * as React from 'react'
import { safeReturnPath } from '@/lib/auth-redirect'
import { apiFetch, ApiError } from '@/lib/api/client'

/**
 * Who is signed in, from the server's point of view.
 *
 * The session is the HttpOnly `sp_at_session` cookie; the browser never sees a token.
 * On mount we ask `GET /api/auth/me`. Signing in sends a magic link
 * (`POST /api/auth/email`); the link itself (`/auth/verify`) sets the cookie.
 */

export interface AuthUser {
  /** `accounts.id` (also `profiles.id`). */
  id: string
  /** NULL for accounts that came through the Bluesky door. */
  email: string | null
  did: string
  handle: string | null
  kind: 'custodial' | 'oauth'
}

export interface Profile {
  id: string
  email: string | null
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  affiliation: string | null
  building: string | null
  telegram: string | null
  ens: string | null
  interests: string[] | null
  onboarding_completed: boolean
  did?: string | null
  atproto_handle?: string | null
  publish_proposals?: boolean | null
}

export interface SignInResult {
  error: Error | null
  /** Development only, when mail is not configured: the link that would have been emailed. */
  devVerifyUrl?: string
}

interface AuthContextValue {
  user: AuthUser | null
  profile: Profile | null
  isLoading: boolean
  needsOnboarding: boolean
  signIn: (email: string, returnTo?: string) => Promise<SignInResult>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

interface MeResponse {
  user: AuthUser | null
  profile: Profile | null
}

const AuthContext = React.createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<AuthUser | null>(null)
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const load = React.useCallback(async () => {
    try {
      const me = await apiFetch<MeResponse>('/api/auth/me', { cache: 'no-store' })
      setUser(me.user)
      setProfile(me.profile)
    } catch (err) {
      // A network failure is not a sign-out; keep whatever we had.
      if (err instanceof ApiError && err.status === 401) {
        setUser(null)
        setProfile(null)
      } else {
        console.error('Could not load the signed-in account:', err instanceof Error ? err.message : err)
      }
    }
  }, [])

  React.useEffect(() => {
    let mounted = true
    load().finally(() => {
      if (mounted) setIsLoading(false)
    })
    return () => {
      mounted = false
    }
  }, [load])

  const signIn = React.useCallback(async (email: string, returnTo?: string): Promise<SignInResult> => {
    try {
      const result = await apiFetch<{ ok: true; devVerifyUrl?: string }>('/api/auth/email', {
        method: 'POST',
        json: { email, next: safeReturnPath(returnTo) },
      })
      return { error: null, ...(result.devVerifyUrl ? { devVerifyUrl: result.devVerifyUrl } : {}) }
    } catch (err) {
      return { error: err instanceof Error ? err : new Error('Failed to send sign-in link') }
    }
  }, [])

  const signOut = React.useCallback(async () => {
    try {
      await apiFetch('/api/auth/signout', { method: 'POST' })
    } catch (err) {
      console.error('Sign-out failed:', err instanceof Error ? err.message : err)
    }
    setUser(null)
    setProfile(null)
    window.location.assign('/')
  }, [])

  const refreshProfile = React.useCallback(async () => {
    await load()
  }, [load])

  const value = React.useMemo<AuthContextValue>(() => ({
    user,
    profile,
    isLoading,
    needsOnboarding: Boolean(user && profile && profile.onboarding_completed === false),
    signIn,
    signOut,
    refreshProfile,
  }), [user, profile, isLoading, signIn, signOut, refreshProfile])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = React.useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}
