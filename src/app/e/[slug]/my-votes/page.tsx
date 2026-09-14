'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, ClipboardList, Plus, Minus } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { votesToCredits, nextVoteCost } from '@/lib/utils'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

function getAccessToken(): string | null {
  const storageKey = `sb-${new URL(SUPABASE_URL).hostname.split('.')[0]}-auth-token`
  const stored = localStorage.getItem(storageKey)
  if (stored) {
    try {
      const session = JSON.parse(stored)
      return session?.access_token || null
    } catch {
      return null
    }
  }
  return null
}

interface Vote {
  session_id: string
  vote_count: number
  credits_spent: number
  session: {
    id: string
    title: string
    format: string
    host_name: string | null
  }
}

export default function MyVotesPage() {
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const votingClosed = !isParticipationOpen(event, 'vote')
  const { voteCredits } = useEventRole()

  // Use event's vote credits
  const totalCredits = voteCredits

  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [votes, setVotes] = React.useState<Vote[]>([])
  const [isLoading, setIsLoading] = React.useState(true)

  React.useEffect(() => {
    if (!authLoading && !user) {
      router.push(`/login?returnTo=${encodeURIComponent(`/e/${event.slug}/my-votes`)}`)
    }
  }, [user, authLoading, router, event.slug])

  const fetchVotes = React.useCallback(async () => {
    if (!user) { setIsLoading(false); return }

    const token = getAccessToken()
    if (!token) { setSaveError('Sign in again to load your votes.'); setIsLoading(false); return }

    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/votes?user_id=eq.${user.id}&event_id=eq.${event.id}&select=session_id,vote_count,credits_spent,session:sessions(id,title,format,host_name)`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${token}`,
          },
        }
      )

      if (!response.ok) throw new Error('Could not load your votes. Refresh the page to try again.')
      const data = await response.json()
      setVotes(data.filter((v: Vote) => v.session))
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Could not load your votes.')
    } finally {
      setIsLoading(false)
    }
  }, [user, event.id])

  React.useEffect(() => {
    fetchVotes()
  }, [fetchVotes])

  const totalCreditsSpent = votes.reduce((sum, v) => sum + v.credits_spent, 0)
  const totalVotes = votes.reduce((sum, v) => sum + v.vote_count, 0)
  const remainingCredits = totalCredits - totalCreditsSpent

  const handleVote = async (sessionId: string, currentVotes: number, delta: number) => {
    if (!user || votingClosed) return

    const token = getAccessToken()
    if (!token) return

    const newVoteCount = Math.max(0, currentVotes + delta)
    const newCredits = votesToCredits(newVoteCount, event.votingMechanism)

    // Check if user has enough credits for adding a vote
    if (delta > 0) {
      const additionalCost =
        newCredits - votesToCredits(currentVotes, event.votingMechanism)
      if (additionalCost > remainingCredits) return
    }

    // Optimistic update
    setVotes((prev) =>
      newVoteCount === 0
        ? prev.filter((v) => v.session_id !== sessionId)
        : prev.map((v) =>
            v.session_id === sessionId
              ? { ...v, vote_count: newVoteCount, credits_spent: newCredits }
              : v
          )
    )

    setSaveError(null)
    try {
      if (newVoteCount === 0) {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/votes?user_id=eq.${user.id}&session_id=eq.${sessionId}`,
          {
            method: 'DELETE',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
            },
          }
        )
        if (!response.ok) throw new Error('Your vote could not be saved. Please try again.')
      } else {
        const response = await fetch(
          `${SUPABASE_URL}/rest/v1/votes?on_conflict=user_id,session_id`,
          {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Prefer': 'resolution=merge-duplicates',
            },
            body: JSON.stringify({
              user_id: user.id,
              session_id: sessionId,
              event_id: event.id,
              vote_count: newVoteCount,
              credits_spent: newCredits,
            }),
          }
        )
        if (!response.ok) throw new Error('Your vote could not be saved. Please try again.')
      }
      window.dispatchEvent(new CustomEvent('schelling:votes-changed', { detail: { eventId: event.id } }))
    } catch (err) {
      setSaveError('Your vote could not be saved. Please try again.')
      console.error('Error updating vote:', err)
      // Revert on error
      fetchVotes()
    }
  }

  if (authLoading || isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    )
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold">My Votes</h1>
          <p className="text-muted-foreground mt-1">
            {votingClosed ? 'Voting is not open right now. Here is the support you contributed.' : 'Track your voting activity and credit usage'}
          </p>
        </div>

        {saveError && <p role="alert" className="rounded-xl bg-destructive/10 p-4 text-destructive">{saveError}</p>}

        {/* Summary Card */}
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-3xl font-bold text-primary">{votes.length}</div>
                <div className="text-sm text-muted-foreground">Sessions Voted</div>
              </div>
              <div>
                <div className="text-3xl font-bold">{totalVotes}</div>
                <div className="text-sm text-muted-foreground">Total Votes</div>
              </div>
              <div>
                <div className="text-3xl font-bold">{totalCreditsSpent}</div>
                <div className="text-sm text-muted-foreground">Credits Used</div>
              </div>
              <div>
                <div className="text-3xl font-bold text-primary">{remainingCredits}</div>
                <div className="text-sm text-muted-foreground">Credits Remaining</div>
              </div>
            </div>
          </CardContent>
        </Card>

        {votes.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <ClipboardList className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              <h2 className="text-lg font-semibold mb-2">No votes yet</h2>
              <p className="text-muted-foreground mb-4">
                {votingClosed ? 'You haven’t voted in this gathering. You can still explore its sessions.' : 'Browse sessions and vote for the ones you want to attend.'}
              </p>
              <Button asChild>
                <Link href={`/e/${event.slug}/sessions`}>Browse Sessions</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            <h2 className="font-semibold">Your Votes</h2>
            {votes
              .sort((a, b) => b.vote_count - a.vote_count)
              .map((vote) => {
                const costToAdd = nextVoteCost(vote.vote_count, event.votingMechanism)
                const isApproval = event.votingMechanism === 'approval'
                const canAddVote =
                  remainingCredits >= costToAdd && !(isApproval && vote.vote_count > 0)

                return (
                  <Card key={vote.session_id} className="hover:border-primary/50 transition-all">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between gap-4">
                        <Link href={`/e/${event.slug}/sessions/${vote.session.id}`} className="flex-1 min-w-0 cursor-pointer">
                          <div className="flex items-center gap-2 mb-1">
                            <Badge variant="secondary" className="capitalize text-xs">
                              {vote.session.format}
                            </Badge>
                          </div>
                          <h3 className="font-medium truncate hover:text-primary transition-colors">
                            {vote.session.title}
                          </h3>
                          {vote.session.host_name && (
                            <p className="text-sm text-muted-foreground">
                              by {vote.session.host_name}
                            </p>
                          )}
                        </Link>
                        <div className="flex items-center gap-3">
                          <Button
                            size="icon"
                            variant="outline"
                            aria-label={`Remove a vote from ${vote.session.title}`}
                            disabled={votingClosed}
                            onClick={(e) => {
                              e.preventDefault()
                              handleVote(vote.session_id, vote.vote_count, -1)
                            }}
                            className="h-10 w-10"
                          >
                            <Minus className="h-4 w-4" />
                          </Button>
                          <div className="min-w-[50px] text-center">
                            <div className="text-xl font-bold text-primary">{vote.vote_count}</div>
                            <div className="text-xs text-muted-foreground">
                              {vote.credits_spent} cr
                            </div>
                          </div>
                          <Button
                            size="icon"
                            variant="outline"
                            aria-label={`Add a vote to ${vote.session.title}`}
                            onClick={(e) => {
                              e.preventDefault()
                              handleVote(vote.session_id, vote.vote_count, 1)
                            }}
                            disabled={votingClosed || !canAddVote}
                            className="h-10 w-10"
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
