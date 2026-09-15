'use client'

import * as React from 'react'
import { User, X, Copy, Check, Loader2, Plus, LogOut, Link2 } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api/client'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

interface Invite {
  id: string
  token: string
  status: string
  expires_at: string
  created_at: string
}

interface ManageCohostsSectionProps {
  sessionId: string
  cohosts: SessionView['cohosts']
  /** The viewer proposed this session. */
  isHost: boolean
  /** The viewer organizes the event. */
  isOrganizer: boolean
  onCohostsChange: () => void
}

/**
 * Co-hosting is a double opt-in (spec §4.2): the proposer (or an organizer) shares an invite
 * link that names nobody; a person becomes a co-host only by accepting it themselves, which
 * writes a co-host record into their own repository. A co-host can step down (deleting that
 * record); the proposer can remove someone from their session; organizers cannot un-co-host.
 */
export function ManageCohostsSection({ sessionId, cohosts, isHost, isOrganizer, onCohostsChange }: ManageCohostsSectionProps) {
  const [invites, setInvites] = React.useState<Invite[]>([])
  const [isCreatingInvite, setIsCreatingInvite] = React.useState(false)
  const [copiedToken, setCopiedToken] = React.useState<string | null>(null)
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const canInvite = isHost || isOrganizer
  const me = cohosts.find((c) => c.is_viewer)

  const fetchInvites = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ invites: Invite[] }>(`/api/sessions/${sessionId}/invites`)
      setInvites(data.invites)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite links could not load')
    }
  }, [sessionId])

  React.useEffect(() => {
    if (canInvite) fetchInvites()
  }, [canInvite, fetchInvites])

  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  const handleCreateInvite = async () => {
    setIsCreatingInvite(true)
    setError(null)
    try {
      await apiFetch(`/api/sessions/${sessionId}/invites`, { method: 'POST' })
      await fetchInvites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The invite link could not be created')
    } finally {
      setIsCreatingInvite(false)
    }
  }

  const handleCopyLink = async (token: string) => {
    await navigator.clipboard.writeText(`${window.location.origin}/invite/${token}`)
    setCopiedToken(token)
    setTimeout(() => setCopiedToken(null), 2000)
  }

  if (me && !isHost) {
    return (
      <Card className="p-6">
        <h3 className="font-semibold mb-4">Co-Host</h3>
        <p className="text-sm text-muted-foreground mb-3">
          You co-host this session. Stepping down removes your co-host record from your repository.
        </p>
        {error && <p role="alert" className="text-sm text-destructive mb-3">{error}</p>}
        <Button
          variant="outline"
          className="w-full justify-start text-destructive hover:text-destructive hover:bg-destructive/10"
          onClick={() => run('me', async () => {
            await apiFetch(`/api/sessions/${sessionId}/cohosts/me`, { method: 'DELETE' })
            onCohostsChange()
          })}
          disabled={busyId === 'me'}
        >
          {busyId === 'me' ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <LogOut className="h-4 w-4 mr-2" />}
          Step down as co-host
        </Button>
      </Card>
    )
  }

  if (!canInvite) return null

  return (
    <Card className="p-6">
      <h3 className="font-semibold mb-1">Co-Hosts</h3>
      <p className="text-xs text-muted-foreground mb-4">Co-hosts join by accepting an invite link themselves.</p>
      {error && <p role="alert" className="text-sm text-destructive mb-3">{error}</p>}

      {cohosts.length > 0 ? (
        <div className="space-y-2 mb-4">
          {cohosts.map((cohost) => (
            <div key={cohost.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-muted/50">
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center overflow-hidden shrink-0">
                  {cohost.avatar_url ? (
                    <img src={cohost.avatar_url} alt={cohost.display_name || ''} className="h-full w-full object-cover" />
                  ) : (
                    <User className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
                <span className="text-sm truncate">{cohost.display_name || (cohost.handle ? `@${cohost.handle}` : 'Co-host')}</span>
              </div>
              {isHost && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                  aria-label={`Remove ${cohost.display_name || 'co-host'}`}
                  onClick={() => run(cohost.id, async () => {
                    await apiFetch(`/api/sessions/${sessionId}/cohosts/${cohost.id}`, { method: 'DELETE' })
                    onCohostsChange()
                  })}
                  disabled={busyId === cohost.id}
                >
                  {busyId === cohost.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">No co-hosts yet</p>
      )}

      {invites.length > 0 && (
        <div className="space-y-2 mb-4">
          <p className="text-xs font-medium text-muted-foreground">Open invite links</p>
          {invites.map((invite) => (
            <div key={invite.id} className="flex items-center justify-between gap-2 p-2 rounded-lg border border-dashed">
              <div className="flex items-center gap-2 min-w-0">
                <Link2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs text-muted-foreground truncate">Expires {new Date(invite.expires_at).toLocaleDateString()}</span>
              </div>
              <div className="flex gap-1 shrink-0">
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => handleCopyLink(invite.token)} aria-label="Copy invite link">
                  {copiedToken === invite.token ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => run(invite.id, async () => {
                    await apiFetch(`/api/sessions/${sessionId}/invites/${invite.id}`, { method: 'DELETE' })
                    setInvites((prev) => prev.filter((i) => i.id !== invite.id))
                  })}
                  disabled={busyId === invite.id}
                  aria-label="Revoke invite link"
                >
                  {busyId === invite.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button variant="outline" className="w-full justify-start" onClick={handleCreateInvite} disabled={isCreatingInvite}>
        {isCreatingInvite ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
        Create Invite Link
      </Button>
    </Card>
  )
}
