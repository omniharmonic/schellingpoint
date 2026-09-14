'use client'

import { isParticipationOpen } from '@/lib/events/lifecycle'
import * as React from 'react'
import Link from 'next/link'
import {
  Presentation,
  Vote,
  Heart,
  Users,
  TrendingUp,
  Clock,
  Loader2,
  ArrowRight,
  Sparkles,
  Zap,
  Mic,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { DashboardLayout } from '@/components/DashboardLayout'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { votesToCredits } from '@/lib/utils'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null
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

interface DashboardStats {
  totalSessions: number
  scheduledSessions: number
  pendingSessions: number
  totalVotes: number
  totalParticipants: number
}

interface SessionRow {
  id: string
  title: string
  description?: string | null
  host_id?: string
  host_name?: string | null
  status: string
  format?: string | null
  total_votes?: number
  created_at?: string
  track?: { name: string; color?: string | null } | null
}

export default function DashboardPage() {
  const { user, profile } = useAuth()
  const event = useEvent()
  const eventIsOver = event.status === 'completed' || event.status === 'archived'
  const { voteCredits, isMember, isAdmin } = useEventRole()

  const [stats, setStats] = React.useState<DashboardStats | null>(null)
  const [userVotes, setUserVotes] = React.useState<Record<string, number>>({})
  const [userFavorites, setUserFavorites] = React.useState<number>(0)
  const [allSessions, setAllSessions] = React.useState<SessionRow[]>([])
  const [myPendingSessions, setMyPendingSessions] = React.useState<SessionRow[]>([])
  const [favoriteSessionIds, setFavoriteSessionIds] = React.useState<Set<string>>(new Set())
  const [isLoading, setIsLoading] = React.useState(true)

  // Calculate user's credits spent using the event's voting mechanism
  const creditsSpent = React.useMemo(() => {
    return Object.values(userVotes).reduce(
      (sum, votes) => sum + votesToCredits(votes, event.votingMechanism),
      0
    )
  }, [userVotes, event.votingMechanism])

  const creditsRemaining = voteCredits - creditsSpent

  // Derived lists for dashboard panels
  const topSessions = React.useMemo(() => {
    return [...allSessions]
      .sort((a, b) => (b.total_votes || 0) - (a.total_votes || 0))
      .slice(0, 6)
  }, [allSessions])

  const userProposedSessions = React.useMemo(() => {
    if (!user) return []
    return allSessions
      .filter((s) => s.host_id === user.id)
      .sort((a, b) => (b.total_votes || 0) - (a.total_votes || 0))
  }, [allSessions, user])

  const userVotedSessions = React.useMemo(() => {
    const votedIds = Object.keys(userVotes)
    return allSessions
      .filter((s) => votedIds.includes(s.id))
      .sort((a, b) => (userVotes[b.id] || 0) - (userVotes[a.id] || 0))
      .slice(0, 6)
  }, [allSessions, userVotes])

  const totalVotesCast = React.useMemo(
    () => Object.values(userVotes).reduce((sum, v) => sum + v, 0),
    [userVotes],
  )

  // Fetch dashboard data
  React.useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch stats (sessions count)
        const [sessionsRes, participantsRes] = await Promise.all([
          fetch(
            `${SUPABASE_URL}/rest/v1/sessions?event_id=eq.${event.id}&select=id,status,total_votes`,
            {
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
              },
            }
          ),
          fetch(
            `${SUPABASE_URL}/rest/v1/event_members?event_id=eq.${event.id}&select=id`,
            {
              headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
              },
            }
          ),
        ])

        if (sessionsRes.ok) {
          const sessions = await sessionsRes.json()
          const scheduled = sessions.filter((s: any) => s.status === 'scheduled').length
          const pending = sessions.filter((s: any) => s.status === 'pending').length
          const totalVotes = sessions.reduce((sum: number, s: any) => sum + (s.total_votes || 0), 0)

          setStats({
            totalSessions: sessions.length,
            scheduledSessions: scheduled,
            pendingSessions: pending,
            totalVotes,
            totalParticipants: 0, // Will be set below
          })
        }

        // Fetch all approved/scheduled sessions for Top & My Sessions panels
        const allSessionsRes = await fetch(
          `${SUPABASE_URL}/rest/v1/sessions?event_id=eq.${event.id}&status=in.(approved,scheduled)&select=id,title,description,host_id,host_name,status,format,total_votes,created_at,track:tracks(name,color)&order=created_at.desc&limit=200`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
          },
        )
        if (allSessionsRes.ok) {
          setAllSessions(await allSessionsRes.json())
        }

        if (participantsRes.ok) {
          const participants = await participantsRes.json()
          setStats(prev => prev ? { ...prev, totalParticipants: participants.length } : null)
        }

        // Fetch user-specific data if logged in
        if (user) {
          const token = getAccessToken()
          if (token) {
            const [votesRes, favsRes] = await Promise.all([
              fetch(
                `${SUPABASE_URL}/rest/v1/votes?user_id=eq.${user.id}&event_id=eq.${event.id}&select=session_id,vote_count`,
                {
                  headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                  },
                }
              ),
              fetch(
                `${SUPABASE_URL}/rest/v1/favorites?user_id=eq.${user.id}&event_id=eq.${event.id}&select=session_id`,
                {
                  headers: {
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${token}`,
                  },
                }
              ),
            ])

            if (votesRes.ok) {
              const votes = await votesRes.json()
              const votesMap: Record<string, number> = {}
              votes.forEach((v: any) => {
                votesMap[v.session_id] = v.vote_count
              })
              setUserVotes(votesMap)
            }

            if (favsRes.ok) {
              const favs = await favsRes.json()
              setUserFavorites(favs.length)
              setFavoriteSessionIds(new Set((favs as any[]).map((f) => f.session_id)))
            }

            // Fetch the user's pending proposals
            const pendingMineRes = await fetch(
              `${SUPABASE_URL}/rest/v1/sessions?event_id=eq.${event.id}&status=eq.pending&host_id=eq.${user.id}&select=id,title,description,status,format,total_votes,created_at&order=created_at.desc`,
              {
                headers: {
                  'apikey': SUPABASE_KEY,
                  'Authorization': `Bearer ${token}`,
                },
              },
            )
            if (pendingMineRes.ok) {
              setMyPendingSessions(await pendingMineRes.json())
            }
          }
        }
      } catch (err) {
        console.error('Error fetching dashboard data:', err)
      } finally {
        setIsLoading(false)
      }
    }

    fetchData()
  }, [event.id, user])

  if (isLoading) {
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
        {/* Header */}
        <div className="dashboard-welcome">
          <h1 className="text-2xl font-display font-bold">
            {user
              ? `Welcome back, ${profile?.display_name || user.email?.split('@')[0] || 'friend'}`
              : 'Your gathering'}
          </h1>
          <p className="text-muted-foreground mt-1">
            Find your people. Follow your curiosity. Make {event.name} your own.
          </p>
        </div>

        {/* Stats Grid — System Gauges */}
        <div className="dashboard-stats grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Card className="stats-card" accent="top" accentColor="hsl(var(--signal))">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs text-muted-foreground">Total Sessions</CardTitle>
              <Presentation className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{stats?.totalSessions || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {stats?.scheduledSessions || 0} scheduled
              </p>
            </CardContent>
          </Card>

          <Card className="stats-card" accent="top" accentColor="hsl(var(--signal-amber))">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs text-muted-foreground">Total Votes</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{stats?.totalVotes || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">
                across all sessions
              </p>
            </CardContent>
          </Card>

          <Card className="stats-card" accent="top" accentColor="hsl(var(--signal-cyan))">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs text-muted-foreground">Participants</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tabular-nums">{stats?.totalParticipants || 0}</div>
              <p className="text-xs text-muted-foreground mt-1">
                people shaping the gathering
              </p>
            </CardContent>
          </Card>

          {user && (
            <Card className="stats-card" accent="top" accentColor="hsl(var(--signal))">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-xs text-muted-foreground">{eventIsOver ? 'Your contribution' : 'Your credits'}</CardTitle>
                <Vote className="h-4 w-4 text-primary" strokeWidth={1.5} />
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold tabular-nums text-primary">{eventIsOver ? creditsSpent : creditsRemaining}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {creditsSpent} of {voteCredits} allocated
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Quick Actions */}
        {user && isMember && (
          <div className="grid gap-4 md:grid-cols-3">
            <Card className="hover:bg-muted/50 transition-colors">
              <Link href={`/e/${event.slug}/sessions`}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-lg bg-primary/10">
                      <Vote className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{isParticipationOpen(event, 'vote') ? 'Vote on sessions' : 'Explore sessions'}</h3>
                      <p className="text-sm text-muted-foreground">
                        {isParticipationOpen(event, 'vote') ? `${creditsRemaining} credits remaining` : 'Discover the ideas taking shape'}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Link>
            </Card>

            <Card className="hover:bg-muted/50 transition-colors">
              <Link href={`/e/${event.slug}/my-schedule`}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-lg bg-primary/10">
                      <Heart className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">My Schedule</h3>
                      <p className="text-sm text-muted-foreground">
                        {userFavorites} session{userFavorites === 1 ? '' : 's'} saved
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Link>
            </Card>

            <Card className="hover:bg-muted/50 transition-colors">
              <Link href={`/e/${event.slug}/${isParticipationOpen(event, 'propose') ? 'propose' : 'participants'}`}>
                <CardContent className="pt-6">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-lg bg-primary/10">
                      <Presentation className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <h3 className="font-semibold">{isParticipationOpen(event, 'propose') ? 'Propose a session' : 'Find your people'}</h3>
                      <p className="text-sm text-muted-foreground">
                        {isParticipationOpen(event, 'propose') ? 'Share your knowledge' : 'Connect with the community'}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Link>
            </Card>
          </div>
        )}

        {/* Your Voting Activity */}
        {user && isMember && (
          <Card accent="left" accentColor="hsl(var(--signal))" className="stats-card">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  Your voting activity
                </h3>
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/e/${event.slug}/my-votes`}>View details</Link>
                </Button>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <p className="text-2xl sm:text-3xl font-bold tabular-nums text-primary">
                    {Object.keys(userVotes).length}
                  </p>
                  <p className="text-xs text-muted-foreground">Sessions voted</p>
                </div>
                <div>
                  <p className="text-2xl sm:text-3xl font-bold tabular-nums">{totalVotesCast}</p>
                  <p className="text-xs text-muted-foreground">Votes cast</p>
                </div>
                <div>
                  <p className="text-2xl sm:text-3xl font-bold tabular-nums">{creditsSpent}</p>
                  <p className="text-xs text-muted-foreground">Credits used</p>
                </div>
                <div>
                  <p className="text-2xl sm:text-3xl font-bold tabular-nums text-primary">
                    {Math.max(creditsRemaining, 0)}
                  </p>
                  <p className="text-xs text-muted-foreground">Credits remaining</p>
                </div>
              </div>
              <div className="mt-4">
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground tracking-wider">Credit usage</span>
                  <span className="font-medium tabular-nums">
                    {creditsSpent}/{voteCredits}
                  </span>
                </div>
                <Progress
                  value={voteCredits > 0 ? (creditsSpent / voteCredits) * 100 : 0}
                  className="h-2"
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* My Pending Proposals */}
        {user && myPendingSessions.length > 0 && (
          <Card className="border-yellow-500/30 bg-yellow-500/5">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Clock className="h-5 w-5 text-yellow-500" />
                  My pending proposals
                </CardTitle>
                <Badge variant="outline" className="text-yellow-600 border-yellow-500/50">
                  Awaiting review
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {myPendingSessions.map((session) => (
                  <div
                    key={session.id}
                    className="p-4 rounded-lg border border-yellow-500/20 bg-background/50"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="font-medium line-clamp-2">{session.title}</p>
                      <Badge
                        variant="secondary"
                        className="capitalize text-xs flex-shrink-0 bg-yellow-500/20 text-yellow-600"
                      >
                        pending
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                      {session.description || 'No description'}
                    </p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span className="capitalize">{session.format || 'session'}</span>
                      <span>
                        {session.created_at
                          ? new Date(session.created_at).toLocaleDateString()
                          : ''}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-3">
                Your proposals are being reviewed by admins. Once approved they&apos;ll appear in the sessions list for voting.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Top Sessions + Recently Proposed */}
        {allSessions.length > 0 && (
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Top Sessions leaderboard */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    Top sessions
                  </CardTitle>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/e/${event.slug}/sessions?sort=votes`} className="text-muted-foreground">
                      View all <ArrowRight className="h-4 w-4 ml-1" />
                    </Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                  {topSessions.map((session, index) => (
                    <Link
                      key={session.id}
                      href={`/e/${event.slug}/sessions/${session.id}`}
                      className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                    >
                      <div
                        className={`
                          w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm flex-shrink-0
                          ${index === 0 ? 'bg-yellow-500/20 text-yellow-600' : ''}
                          ${index === 1 ? 'bg-gray-300/20 text-gray-500' : ''}
                          ${index === 2 ? 'bg-orange-500/20 text-orange-600' : ''}
                          ${index > 2 ? 'bg-muted text-muted-foreground' : ''}
                        `}
                      >
                        {index + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate group-hover:text-primary transition-colors">
                          {session.title}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          {session.host_name || 'Anonymous'}
                        </p>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <p className="font-semibold text-primary">{session.total_votes || 0}</p>
                        <p className="text-xs text-muted-foreground">votes</p>
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Recently proposed */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Sparkles className="h-5 w-5 text-primary" />
                    Recently proposed
                  </CardTitle>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/e/${event.slug}/sessions?sort=recent`} className="text-muted-foreground">
                      View all <ArrowRight className="h-4 w-4 ml-1" />
                    </Link>
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
                  {allSessions.slice(0, 6).map((session) => (
                    <Link
                      key={session.id}
                      href={`/e/${event.slug}/sessions/${session.id}`}
                      className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors group"
                    >
                      <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
                        <Sparkles className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate group-hover:text-primary transition-colors">
                          {session.title}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground overflow-hidden">
                          <span className="truncate">{session.host_name || 'Anonymous'}</span>
                          {session.created_at && (
                            <>
                              <span className="flex-shrink-0">•</span>
                              <span className="flex-shrink-0">
                                {new Date(session.created_at).toLocaleDateString()}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      {session.format && (
                        <Badge variant="secondary" className="capitalize text-xs flex-shrink-0">
                          {session.format}
                        </Badge>
                      )}
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* My Sessions (hosting) */}
        {user && userProposedSessions.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Mic className="h-5 w-5 text-primary" />
                  My sessions
                </CardTitle>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/e/${event.slug}/sessions?filter=mine`} className="text-muted-foreground">
                    View all <ArrowRight className="h-4 w-4 ml-1" />
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {userProposedSessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/e/${event.slug}/sessions/${session.id}`}
                    className="p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/30 transition-all group"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="font-medium line-clamp-2 group-hover:text-primary transition-colors">
                        {session.title}
                      </p>
                      <Badge variant="secondary" className="capitalize text-xs flex-shrink-0">
                        {session.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Total votes</span>
                      <span className="font-semibold text-primary">
                        {session.total_votes || 0}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Sessions You're Supporting */}
        {user && userVotedSessions.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Heart className="h-5 w-5 text-red-500" />
                  Sessions you&apos;re supporting
                </CardTitle>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/e/${event.slug}/my-votes`} className="text-muted-foreground">
                    View all <ArrowRight className="h-4 w-4 ml-1" />
                  </Link>
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {userVotedSessions.map((session) => (
                  <Link
                    key={session.id}
                    href={`/e/${event.slug}/sessions/${session.id}`}
                    className="p-4 rounded-lg border hover:border-primary/50 hover:bg-muted/30 transition-all group"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <p className="font-medium line-clamp-2 group-hover:text-primary transition-colors">
                        {session.title}
                      </p>
                      {favoriteSessionIds.has(session.id) && (
                        <Heart className="h-4 w-4 text-red-500 fill-current flex-shrink-0" />
                      )}
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Your votes</span>
                      <span className="font-semibold text-primary">
                        {userVotes[session.id]}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Admin Quick Stats */}
        {isAdmin && stats?.pendingSessions && stats.pendingSessions > 0 && (
          <Card className="border-orange-500/30 bg-orange-500/5">
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="p-3 rounded-lg bg-orange-500/10">
                    <Clock className="h-6 w-6 text-orange-500" />
                  </div>
                  <div>
                    <h3 className="font-semibold">Pending Approval</h3>
                    <p className="text-sm text-muted-foreground">
                      {stats.pendingSessions} sessions awaiting review
                    </p>
                  </div>
                </div>
                <Button asChild>
                  <Link href={`/e/${event.slug}/admin`}>Review</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

      </div>
    </DashboardLayout>
  )
}
