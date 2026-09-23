'use client'

import * as React from 'react'
import { User, X, Copy, Plus, LogOut, Link2, Mail } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { apiFetch } from '@/lib/api/client'
import type { SessionView } from '@/app/api/v1/sessions/_lib/read'

interface Invite {
  id: string
  token: string
  status: string
  expires_at: string
  created_at: string
  /** When the link was emailed; the address itself is never stored. */
  emailed_at?: string | null
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

type Confirming = { kind: 'step-down' } | { kind: 'remove'; id: string; name: string } | { kind: 'revoke'; id: string }

const WHAT_A_COHOST_IS = 'Co-hosts appear alongside you on the session and can manage its resources and chat group link. They join by accepting an invite link themselves; nobody is added on your say-so.'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function cohostName(cohost: SessionView['cohosts'][number]): string {
  return cohost.display_name || (cohost.handle ? `@${cohost.handle}` : 'Co-host')
}

/**
 * Co-hosting is a double opt-in (spec §4.2): the proposer (or an organizer) shares an invite
 * link that names nobody; a person becomes a co-host only by accepting it themselves, which
 * writes a co-host record into their own repository. A co-host can step down (deleting that
 * record); the proposer can remove someone from their session; organizers cannot un-co-host.
 */
export function ManageCohostsSection({ sessionId, cohosts, isHost, isOrganizer, onCohostsChange }: ManageCohostsSectionProps) {
  const { toast } = useToast()
  const [invites, setInvites] = React.useState<Invite[]>([])
  const [isCreatingInvite, setIsCreatingInvite] = React.useState(false)
  const [inviteEmail, setInviteEmail] = React.useState('')
  const [busyId, setBusyId] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState<Confirming | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const canInvite = isHost || isOrganizer
  const me = cohosts.find((c) => c.is_viewer)

  const fetchInvites = React.useCallback(async () => {
    try {
      const data = await apiFetch<{ invites: Invite[] }>(`/api/sessions/${sessionId}/invites`)
      setInvites(data.invites)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invite links could not be loaded.')
    }
  }, [sessionId])

  React.useEffect(() => {
    if (canInvite) fetchInvites()
  }, [canInvite, fetchInvites])

  const run = async (id: string, action: () => Promise<unknown>, success: string) => {
    setBusyId(id)
    setError(null)
    try {
      await action()
      setConfirming(null)
      toast({ title: success, variant: 'success' })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.')
    } finally {
      setBusyId(null)
    }
  }

  const handleCreateInvite = async () => {
    const email = inviteEmail.trim()
    if (email && !EMAIL.test(email)) {
      setError('That does not look like an email address. Leave it empty to get a link you can send yourself.')
      return
    }
    setIsCreatingInvite(true)
    setError(null)
    try {
      const created = await apiFetch<{ emailed?: boolean; deliveryNote?: string | null }>(
        `/api/sessions/${sessionId}/invites`,
        { method: 'POST', json: email ? { email } : {} },
      )
      await fetchInvites()
      setInviteEmail('')
      toast({
        title: created.emailed ? 'Invitation sent' : 'Invite link created',
        description: created.deliveryNote
          || (created.emailed
            ? `We emailed the link to ${email}. Nothing happens until they accept it.`
            : 'Copy it and send it to your co-host.'),
        variant: 'success',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The invite link could not be created. Please try again.')
    } finally {
      setIsCreatingInvite(false)
    }
  }

  const handleCopyLink = async (token: string) => {
    const url = `${window.location.origin}/invite/${token}`
    try {
      await navigator.clipboard.writeText(url)
      toast({ title: 'Invite link copied', variant: 'success' })
    } catch {
      toast({ title: 'The link could not be copied', description: url, variant: 'destructive' })
    }
  }

  const errorBox = error ? (
    <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
  ) : null

  if (me && !isHost) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Co-host</CardTitle>
          <CardDescription>You co-host this session. Stepping down removes your co-host record from your repository.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {errorBox}
          {confirming?.kind === 'step-down' ? (
            <ConfirmInline
              destructive
              message="Step down as co-host? Your co-host record is deleted from your repository."
              confirmLabel="Step down"
              loading={busyId === 'me'}
              onConfirm={() => run('me', async () => {
                await apiFetch(`/api/sessions/${sessionId}/cohosts/me`, { method: 'DELETE' })
                onCohostsChange()
              }, 'You stepped down as co-host')}
              onCancel={() => setConfirming(null)}
            />
          ) : (
            <Button
              variant="outline"
              className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setConfirming({ kind: 'step-down' })}
            >
              <LogOut className="mr-2 h-4 w-4" aria-hidden />
              Step down as co-host
            </Button>
          )}
        </CardContent>
      </Card>
    )
  }

  if (!canInvite) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Co-hosts</CardTitle>
        <CardDescription>{WHAT_A_COHOST_IS}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {errorBox}

        {cohosts.length > 0 ? (
          <ul className="space-y-2">
            {cohosts.map((cohost) => (
              <li key={cohost.id} className="space-y-2">
                <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 p-2 pl-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
                      {cohost.avatar_url ? (
                        <img src={cohost.avatar_url} alt="" className="h-full w-full object-cover" />
                      ) : cohost.handle ? (
                        <span className="text-xs font-medium uppercase text-muted-foreground">{cohost.handle.charAt(0)}</span>
                      ) : (
                        <User className="h-4 w-4 text-muted-foreground" aria-hidden />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm">{cohostName(cohost)}</p>
                      {cohost.display_name && cohost.handle && <p className="truncate text-xs text-muted-foreground">@{cohost.handle}</p>}
                    </div>
                  </div>
                  {isHost && !(confirming?.kind === 'remove' && confirming.id === cohost.id) && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove ${cohostName(cohost)}`}
                      onClick={() => setConfirming({ kind: 'remove', id: cohost.id, name: cohostName(cohost) })}
                      disabled={busyId !== null}
                    >
                      <X className="h-4 w-4" aria-hidden />
                    </Button>
                  )}
                </div>
                {confirming?.kind === 'remove' && confirming.id === cohost.id && (
                  <ConfirmInline
                    destructive
                    message={`Remove ${confirming.name} as a co-host? They can be invited again later.`}
                    confirmLabel="Remove"
                    loading={busyId === cohost.id}
                    onConfirm={() => run(cohost.id, async () => {
                      await apiFetch(`/api/sessions/${sessionId}/cohosts/${cohost.id}`, { method: 'DELETE' })
                      onCohostsChange()
                    }, 'Co-host removed')}
                    onCancel={() => setConfirming(null)}
                  />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No co-hosts yet. Create an invite link and share it with the person you’d like to co-host.</p>
        )}

        {invites.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Open invite links</p>
            <ul className="space-y-2">
              {invites.map((invite) => (
                <li key={invite.id} className="space-y-2">
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-dashed p-2 pl-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="min-w-0 text-xs text-muted-foreground">
                        <p className="truncate">Created {new Date(invite.created_at).toLocaleDateString()} · expires {new Date(invite.expires_at).toLocaleDateString()}</p>
                        <p className="truncate">{invite.emailed_at ? 'Emailed. Anyone with the link can accept it once.' : 'Anyone with the link can accept it once.'}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button variant="ghost" size="icon-sm" onClick={() => handleCopyLink(invite.token)} aria-label="Copy invite link" title="Copy invite link">
                        <Copy className="h-4 w-4" aria-hidden />
                      </Button>
                      {!(confirming?.kind === 'revoke' && confirming.id === invite.id) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setConfirming({ kind: 'revoke', id: invite.id })}
                          disabled={busyId !== null}
                          aria-label="Revoke invite link"
                          title="Revoke invite link"
                        >
                          <X className="h-4 w-4" aria-hidden />
                        </Button>
                      )}
                    </div>
                  </div>
                  {confirming?.kind === 'revoke' && confirming.id === invite.id && (
                    <ConfirmInline
                      destructive
                      message="Revoke this invite link? Anyone who still has it will no longer be able to accept it."
                      confirmLabel="Revoke"
                      loading={busyId === invite.id}
                      onConfirm={() => run(invite.id, async () => {
                        await apiFetch(`/api/sessions/${sessionId}/invites/${invite.id}`, { method: 'DELETE' })
                        setInvites((prev) => prev.filter((i) => i.id !== invite.id))
                      }, 'Invite link revoked')}
                      onCancel={() => setConfirming(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2 rounded-lg border border-dashed p-3">
          <Label htmlFor="cohost-invite-email" className="text-xs font-medium text-muted-foreground">
            Invite by email <span className="font-normal">(optional)</span>
          </Label>
          <Input
            id="cohost-invite-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder="them@example.com"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            disabled={isCreatingInvite}
          />
          <p className="text-xs text-muted-foreground">
            We send them the link and nothing else. Leave it empty to get a link you can share yourself.
            Either way, they are a co-host only once they accept.
          </p>
          <Button className="w-full" onClick={handleCreateInvite} loading={isCreatingInvite}>
            {!isCreatingInvite && (inviteEmail.trim() ? <Mail className="mr-2 h-4 w-4" aria-hidden /> : <Plus className="mr-2 h-4 w-4" aria-hidden />)}
            {inviteEmail.trim() ? 'Send the invitation' : 'Create an invite link'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
