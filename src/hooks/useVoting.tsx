'use client'

/**
 * The browser's view of the signed-in participant's own ballot (plan §7.2).
 *
 *   const { round, allocation, spent, remaining, loading, error, setVotes, refresh } = useVoting(eventSlug)
 *
 * One store per event slug, shared by every component that calls the hook, so the credit
 * gauge, the session cards and My Votes always agree and the allocation is fetched once
 * per event. `VotingProvider` (mounted by `DashboardLayout`) warms the store; the hook
 * works without it too.
 *
 * `setVotes` updates optimistically, sends writes in order, and on refusal rolls the
 * session back to the server's last confirmed value and exposes the server's message in
 * `error`. It never throws.
 *
 * Nothing here is ever a count of other people's votes: the server does not send any.
 */
import * as React from 'react'
import { apiFetch, ApiError } from '@/lib/api/client'
import { useAuth } from '@/hooks/useAuth'
import {
  allocationCost,
  isValidVoteCount,
  maxVotesFor,
  type RoundPhase,
  type VotingMechanism,
} from '@/lib/voting/mechanism'

export type RoundStatus = 'none' | 'upcoming' | 'open' | 'closed'

export interface VotingRound {
  id: string
  eventId: string
  phase: RoundPhase
  mechanism: VotingMechanism
  credits: number
  opensAt: string
  closesAt: string
  finalizedAt: string | null
  status: Exclude<RoundStatus, 'none'>
}

export interface VotedSession {
  id: string
  title: string
  format: string | null
  status: string
  track: { name: string; color: string | null } | null
}

interface MineResponse {
  round: VotingRound | null
  status: RoundStatus
  mechanism: VotingMechanism | null
  allocation: Record<string, number>
  spent: number
  budget: number
  remaining: number
  canVote: boolean
  reason: string | null
  sealed: boolean
  eligibility: { eligible: boolean; code?: string; reason?: string }
  sessions: VotedSession[]
}

interface CurrentResponse {
  round: VotingRound | null
  status: RoundStatus
}

interface Confirmed {
  round: VotingRound | null
  status: RoundStatus
  mechanism: VotingMechanism | null
  allocation: Record<string, number>
  budget: number
  canVote: boolean
  reason: string | null
  sealed: boolean
  eligible: boolean
  sessions: VotedSession[]
}

interface Snapshot {
  confirmed: Confirmed
  /** Pending optimistic values by session, applied over `confirmed.allocation`. */
  overlay: Record<string, number>
  signedIn: boolean
  loading: boolean
  loaded: boolean
  error: string | null
}

export interface VotingState {
  round: VotingRound | null
  status: RoundStatus
  /** The round's mechanism; null before any round exists. */
  mechanism: VotingMechanism | null
  /** session id → the viewer's own votes. Empty once the round is closed (ballots are sealed). */
  allocation: Record<string, number>
  spent: number
  remaining: number
  budget: number
  /** Allocations are accepted right now for this viewer. */
  canVote: boolean
  /** Why `canVote` is false, for display. */
  reason: string | null
  eligible: boolean
  sealed: boolean
  signedIn: boolean
  /** Titles etc. of the sessions in `allocation` (as of the last server response). */
  sessions: VotedSession[]
  loading: boolean
  error: string | null
  /** Session ids with a write in flight. */
  pending: ReadonlySet<string>
  setVotes: (sessionId: string, votes: number) => Promise<void>
  refresh: () => Promise<void>
  clearError: () => void
}

const EMPTY_CONFIRMED: Confirmed = {
  round: null,
  status: 'none',
  mechanism: null,
  allocation: {},
  budget: 0,
  canVote: false,
  reason: null,
  sealed: false,
  eligible: false,
  sessions: [],
}

const STALE_MS = 60_000

function fromMine(r: MineResponse): Confirmed {
  return {
    round: r.round,
    status: r.status,
    mechanism: r.mechanism ?? r.round?.mechanism ?? null,
    allocation: r.allocation ?? {},
    budget: r.budget,
    canVote: r.canVote,
    reason: r.reason,
    sealed: r.sealed,
    eligible: !!r.eligibility?.eligible,
    sessions: r.sessions ?? [],
  }
}

function fromCurrent(r: CurrentResponse): Confirmed {
  const reason =
    r.status === 'open' ? 'Sign in to vote.'
      : r.status === 'upcoming' && r.round ? `Voting opens ${new Date(r.round.opensAt).toLocaleString()}.`
        : r.status === 'closed' ? 'Voting has closed. Ballots are sealed.'
          : 'Voting has not opened for this gathering.'
  return { ...EMPTY_CONFIRMED, round: r.round, status: r.status, mechanism: r.round?.mechanism ?? null, reason, sealed: r.status === 'closed' }
}

function merged(allocation: Record<string, number>, overlay: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = { ...allocation }
  for (const [id, v] of Object.entries(overlay)) {
    if (v > 0) out[id] = v
    else delete out[id]
  }
  return out
}

function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error && e.message) return e.message
  return 'Your vote could not be saved. Please try again.'
}

class VotingStore {
  private snap: Snapshot = { confirmed: EMPTY_CONFIRMED, overlay: {}, signedIn: false, loading: true, loaded: false, error: null }
  private listeners = new Set<() => void>()
  private viewer: string | null | undefined = undefined
  private loadedAt = 0
  private inflight: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()
  private latestWrite = new Map<string, number>()
  private writeSeq = 0
  private pendingIds = new Set<string>()
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly slug: string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.snap

  get pending(): ReadonlySet<string> {
    return this.pendingIds
  }

  private set(next: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...next }
    for (const l of this.listeners) l()
  }

  /** Load for this viewer if not loaded (or stale, or the viewer changed). */
  ensure(viewerId: string | null) {
    const changed = this.viewer !== viewerId
    if (changed) {
      this.viewer = viewerId
      this.overlayReset()
      this.set({ confirmed: EMPTY_CONFIRMED, signedIn: !!viewerId, loaded: false, loading: true, error: null })
    }
    if (changed || Date.now() - this.loadedAt > STALE_MS) void this.refresh()
  }

  private overlayReset() {
    this.latestWrite.clear()
    this.pendingIds = new Set()
    this.snap = { ...this.snap, overlay: {} }
  }

  refresh = (): Promise<void> => {
    if (this.inflight) return this.inflight
    const viewer = this.viewer
    const base = `/api/v1/events/${encodeURIComponent(this.slug)}`
    this.inflight = (async () => {
      if (!this.snap.loaded) this.set({ loading: true })
      try {
        const confirmed = viewer
          ? fromMine(await apiFetch<MineResponse>(`${base}/votes/mine`, { cache: 'no-store' }))
          : fromCurrent(await apiFetch<CurrentResponse>(`${base}/rounds/current`, { cache: 'no-store' }))
        if (viewer !== this.viewer) return
        this.loadedAt = Date.now()
        this.set({ confirmed, loading: false, loaded: true, error: null })
        this.scheduleBoundaryRefresh(confirmed.round)
      } catch (e) {
        if (viewer !== this.viewer) return
        // Signed out between the auth check and this request: show the public view.
        if (e instanceof ApiError && e.status === 401 && viewer) {
          this.set({ loading: false, loaded: true, error: null, signedIn: false })
          return
        }
        this.set({ loading: false, loaded: true, error: e instanceof ApiError ? e.message : 'Voting is unavailable right now.' })
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }

  /** Re-read when the window opens or closes, so controls enable/disable on time. */
  private scheduleBoundaryRefresh(round: VotingRound | null) {
    if (this.boundaryTimer) clearTimeout(this.boundaryTimer)
    this.boundaryTimer = null
    if (!round || round.status === 'closed' || typeof window === 'undefined') return
    const now = Date.now()
    const next = [round.opensAt, round.closesAt]
      .map((t) => new Date(t).getTime())
      .filter((t) => t > now)
      .sort((a, b) => a - b)[0]
    if (next === undefined || next - now > 86_400_000) return
    this.boundaryTimer = setTimeout(() => {
      this.loadedAt = 0
      void this.refresh()
    }, next - now + 1500)
  }

  clearError = () => this.set({ error: null })

  setVotes = (sessionId: string, votes: number): Promise<void> => {
    const { confirmed, overlay } = this.snap
    const mechanism = confirmed.mechanism ?? 'quadratic'
    if (!this.viewer) {
      this.set({ error: 'Sign in to vote.' })
      return Promise.resolve()
    }
    if (!confirmed.canVote) {
      this.set({ error: confirmed.reason ?? 'Voting is not open right now.' })
      return Promise.resolve()
    }
    if (!isValidVoteCount(votes, mechanism)) {
      this.set({
        error: mechanism === 'approval' ? 'Approval voting allows at most 1 vote per session.' : `A session can take at most ${maxVotesFor(mechanism)} votes.`,
      })
      return Promise.resolve()
    }
    const current = merged(confirmed.allocation, overlay)
    const next = { ...current, [sessionId]: votes }
    if (votes === 0) delete next[sessionId]
    const before = allocationCost(current, mechanism)
    const after = allocationCost(next, mechanism)
    if (after > confirmed.budget && after > before) {
      const noun = mechanism === 'approval' ? 'approvals' : 'credits'
      this.set({ error: `Not enough ${noun}: this would use ${after} of your ${confirmed.budget}.` })
      return Promise.resolve()
    }

    // Optimistic.
    const seq = ++this.writeSeq
    this.latestWrite.set(sessionId, seq)
    this.pendingIds = new Set(this.pendingIds).add(sessionId)
    this.set({ overlay: { ...overlay, [sessionId]: votes }, error: null })

    const base = `/api/v1/events/${encodeURIComponent(this.slug)}`
    const viewer = this.viewer
    const run = async () => {
      try {
        const res = await apiFetch<MineResponse>(`${base}/votes/mine`, { method: 'PUT', json: { sessionId, votes } })
        if (viewer !== this.viewer) return
        this.loadedAt = Date.now()
        this.settle(sessionId, seq, { confirmed: fromMine(res) })
      } catch (e) {
        if (viewer !== this.viewer) return
        // Roll back this session to the last confirmed value and say why.
        this.settle(sessionId, seq, { error: messageOf(e) })
        if (e instanceof ApiError && (e.status === 409 || e.status === 403)) {
          this.loadedAt = 0
          void this.refresh()
        }
      }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  private settle(sessionId: string, seq: number, patch: { confirmed?: Confirmed; error?: string }) {
    const overlay = { ...this.snap.overlay }
    if (this.latestWrite.get(sessionId) === seq) {
      delete overlay[sessionId]
      this.latestWrite.delete(sessionId)
      const ids = new Set(this.pendingIds)
      ids.delete(sessionId)
      this.pendingIds = ids
    }
    this.set({ ...patch, overlay })
  }
}

const stores = new Map<string, VotingStore>()

function storeFor(slug: string): VotingStore {
  let s = stores.get(slug)
  if (!s) {
    s = new VotingStore(slug)
    stores.set(slug, s)
  }
  return s
}

export function useVoting(eventSlug: string): VotingState {
  const { user, isLoading: authLoading } = useAuth()
  const store = storeFor(eventSlug)
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  React.useEffect(() => {
    if (!authLoading) store.ensure(user?.id ?? null)
  }, [store, user?.id, authLoading])

  return React.useMemo<VotingState>(() => {
    const c = snap.confirmed
    const mechanism = c.mechanism
    const allocation = merged(c.allocation, snap.overlay)
    const spent = allocationCost(allocation, mechanism ?? 'quadratic')
    return {
      round: c.round,
      status: c.status,
      mechanism,
      allocation,
      spent,
      budget: c.budget,
      remaining: Math.max(0, c.budget - spent),
      canVote: c.canVote,
      reason: c.reason,
      eligible: c.eligible,
      sealed: c.sealed,
      signedIn: snap.signedIn,
      sessions: c.sessions,
      loading: authLoading || snap.loading,
      error: snap.error,
      pending: store.pending,
      setVotes: store.setVotes,
      refresh: store.refresh,
      clearError: store.clearError,
    }
  }, [snap, store, authLoading])
}

/** Mounted by `DashboardLayout`: loads the event's ballot once for every consumer below it. */
export function VotingProvider({ eventSlug, children }: { eventSlug: string; children: React.ReactNode }) {
  useVoting(eventSlug)
  return <>{children}</>
}
