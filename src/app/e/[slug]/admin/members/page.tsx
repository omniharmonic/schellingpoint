'use client'

import * as React from 'react'
import {
  Loader2,
  Users,
  UserPlus,
  Mail,
  Link as LinkIcon,
  Copy,
  Check,
  Trash2,
  Clock,
  AlertCircle,
  CheckCircle2,
  UserMinus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { formatDistanceToNow } from 'date-fns'

interface Member {
  id: string
  user_id: string
  role: string
  joined_at: string
  user_data: {
    display_name: string | null
    email: string | null
    handle: string | null
  } | null
}

interface Invitation {
  id: string
  token: string
  email: string | null
  role: string
  expires_at: string
  accepted_at: string | null
  created_at: string
  max_uses: number | null
  use_count: number
  /** Null once the retention job has removed the inviter (30 days after redemption). */
  invited_by: string | null
}

interface EmailResult {
  email: string
  sent: boolean
  channel?: 'notification' | 'email' | 'none'
  error?: string
}

const ROLE_COLORS: Record<string, string> = {
  owner: 'bg-purple-500',
  admin: 'bg-blue-500',
  moderator: 'bg-green-500',
  track_lead: 'bg-teal-500',
  volunteer: 'bg-amber-500',
  attendee: 'bg-gray-500',
}

// Order matches src/lib/permissions.ts hierarchy (highest first)
const ASSIGNABLE_ROLES: { value: string; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'moderator', label: 'Moderator' },
  { value: 'track_lead', label: 'Track Lead' },
  { value: 'volunteer', label: 'Volunteer' },
  { value: 'attendee', label: 'Attendee' },
]

/** Elevated link invites default to a single use; attendee links default to unlimited. */
function defaultMaxUsesFor(role: string): string {
  return role === 'admin' || role === 'moderator' ? '1' : ''
}

export default function AdminMembersPage() {
  const { user } = useAuth()
  const event = useEvent()
  const { isAdmin, isOwner } = useEventRole()

  const [members, setMembers] = React.useState<Member[]>([])
  const [invitations, setInvitations] = React.useState<Invitation[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [showInviteModal, setShowInviteModal] = React.useState(false)
  const [inviteEmails, setInviteEmails] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState('attendee')
  const [inviteType, setInviteType] = React.useState<'email' | 'link'>('link')
  const [inviteMaxUses, setInviteMaxUses] = React.useState<string>(defaultMaxUsesFor('attendee'))
  const [inviting, setInviting] = React.useState(false)
  const [inviteError, setInviteError] = React.useState<string | null>(null)
  const [emailResults, setEmailResults] = React.useState<EmailResult[] | null>(null)
  const [generatedLink, setGeneratedLink] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)
  const [confirmRevokeId, setConfirmRevokeId] = React.useState<string | null>(null)
  const [inviteListError, setInviteListError] = React.useState<string | null>(null)

  const [savingMemberId, setSavingMemberId] = React.useState<string | null>(null)
  const [memberFeedback, setMemberFeedback] = React.useState<
    Record<string, { kind: 'success' | 'error'; message: string }>
  >({})
  const [confirmRemoveId, setConfirmRemoveId] = React.useState<string | null>(null)

  const base = `/api/v1/events/${event.slug}`

  const fetchInvitations = React.useCallback(async () => {
    const data = await apiFetch<{ invitations: Invitation[] }>(`${base}/invitations`)
    setInvitations(data.invitations)
  }, [base])

  React.useEffect(() => {
    if (!isAdmin) return
    let cancelled = false
    Promise.all([apiFetch<{ members: Member[] }>(`${base}/members`), fetchInvitations()])
      .then(([m]) => { if (!cancelled) setMembers(m.members) })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof ApiError ? e.message : 'Members could not be loaded.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [base, fetchInvitations, isAdmin])

  const setFeedback = (memberId: string, kind: 'success' | 'error', message: string) => {
    setMemberFeedback(prev => ({ ...prev, [memberId]: { kind, message } }))
    if (kind === 'success') {
      setTimeout(() => {
        setMemberFeedback(prev => {
          const next = { ...prev }
          delete next[memberId]
          return next
        })
      }, 2500)
    }
  }

  const handleRoleChange = async (member: Member, newRole: string) => {
    if (newRole === member.role) return
    const previousRole = member.role
    setSavingMemberId(member.id)
    setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: newRole } : m)))
    try {
      const data = await apiFetch<{ member: { role: string } }>(`${base}/members/${member.user_id}`, { method: 'PATCH', json: { role: newRole } })
      setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: data.member.role } : m)))
      setFeedback(member.id, 'success', 'Role updated')
    } catch (e) {
      setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: previousRole } : m)))
      setFeedback(member.id, 'error', e instanceof ApiError ? e.message : 'Failed to update role')
    } finally {
      setSavingMemberId(null)
    }
  }

  const handleRemoveMember = async (member: Member) => {
    setSavingMemberId(member.id)
    try {
      await apiFetch(`${base}/members/${member.user_id}`, { method: 'DELETE' })
      setMembers(prev => prev.filter(m => m.id !== member.id))
    } catch (e) {
      setFeedback(member.id, 'error', e instanceof ApiError ? e.message : 'Failed to remove member')
    } finally {
      setSavingMemberId(null)
      setConfirmRemoveId(null)
    }
  }

  const handleInviteRoleChange = (role: string) => {
    setInviteRole(role)
    setInviteMaxUses(defaultMaxUsesFor(role))
  }

  const resetInviteModal = () => {
    setShowInviteModal(false)
    setGeneratedLink(null)
    setInviteEmails('')
    setEmailResults(null)
    setInviteError(null)
  }

  const handleCreateInvite = async () => {
    setInviting(true)
    setGeneratedLink(null)
    setEmailResults(null)
    setInviteError(null)
    try {
      const body: { emails?: string[]; role: string; max_uses?: number | null } = { role: inviteRole }
      if (inviteType === 'email') {
        body.emails = inviteEmails.split(/[,\s]+/).map(e => e.trim()).filter(Boolean)
      } else {
        const trimmed = inviteMaxUses.trim()
        if (trimmed !== '') {
          const n = Number(trimmed)
          if (!Number.isInteger(n) || n < 1) {
            setInviteError('Max uses must be a whole number of 1 or more, or left blank for unlimited')
            return
          }
          body.max_uses = n
        } else {
          body.max_uses = null
        }
      }
      const data = await apiFetch<{ inviteUrl: string | null; emailResults?: EmailResult[] }>(`${base}/invitations`, { method: 'POST', json: body })
      if (data.inviteUrl) setGeneratedLink(data.inviteUrl)
      if (inviteType === 'email') {
        setEmailResults(data.emailResults ?? [])
        setInviteEmails('')
      }
      await fetchInvitations()
    } catch (e) {
      setInviteError(e instanceof ApiError ? e.message : 'Failed to create invitation')
    } finally {
      setInviting(false)
    }
  }

  const handleRevokeInvite = async (id: string) => {
    setConfirmRevokeId(null)
    setInviteListError(null)
    try {
      await apiFetch(`${base}/invitations/${id}`, { method: 'DELETE' })
      setInvitations(prev => prev.filter(i => i.id !== id))
    } catch (e) {
      setInviteListError(e instanceof ApiError ? e.message : 'The invitation could not be revoked.')
    }
  }

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      setInviteListError('Copying failed; select the link and copy it manually.')
    }
  }

  if (!isAdmin) {
    return <Card><CardContent className="py-8 text-center text-muted-foreground">Only owners and admins manage members.</CardContent></Card>
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const pendingInvitations = invitations.filter(i => !i.accepted_at)
  const inviteFinished = !!generatedLink || !!emailResults

  return (
        <div className="space-y-6">
          {/* Header */}
          <div className="page-heading">
            <div>
              <h1 className="text-2xl font-display font-bold">Members</h1>
              <p className="text-sm text-muted-foreground">
                {members.length} members in {event.name}
              </p>
            </div>
            <Button onClick={() => setShowInviteModal(true)}>
              <UserPlus className="h-4 w-4 mr-2" />
              Invite People
            </Button>
          </div>

          {loadError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{loadError}</p>}
          {inviteListError && <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{inviteListError}</p>}

          {/* Invite Modal */}
          {showInviteModal && (
            <Card className="border-primary">
              <CardHeader>
                <CardTitle>Invite People</CardTitle>
                <CardDescription>
                  Create an invitation link or send email invites
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Invite Type Toggle */}
                <div className="flex gap-2">
                  <Button
                    variant={inviteType === 'link' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setInviteType('link')}
                    disabled={inviteFinished}
                  >
                    <LinkIcon className="h-4 w-4 mr-1" />
                    Shareable Link
                  </Button>
                  <Button
                    variant={inviteType === 'email' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setInviteType('email')}
                    disabled={inviteFinished}
                  >
                    <Mail className="h-4 w-4 mr-1" />
                    Email Invites
                  </Button>
                </div>

                {inviteType === 'email' && !emailResults && (
                  <div className="space-y-2">
                    <Label>Email Addresses</Label>
                    <Input
                      placeholder="email@example.com, another@example.com"
                      value={inviteEmails}
                      onChange={(e) => setInviteEmails(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Separate addresses with commas. People who already have an account are invited in the app; others get an email.
                    </p>
                  </div>
                )}

                {!inviteFinished && (
                  <div className="space-y-2">
                    <Label>Role</Label>
                    <select
                      value={inviteRole}
                      onChange={(e) => handleInviteRoleChange(e.target.value)}
                      className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                    >
                      <option value="attendee">Attendee</option>
                      <option value="volunteer">Volunteer</option>
                      <option value="moderator">Moderator</option>
                      {isOwner && <option value="admin">Admin</option>}
                    </select>
                  </div>
                )}

                {inviteType === 'link' && !inviteFinished && (
                  <div className="space-y-2">
                    <Label htmlFor="invite-max-uses">Max uses</Label>
                    <Input
                      id="invite-max-uses"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      placeholder="Unlimited"
                      value={inviteMaxUses}
                      onChange={(e) => setInviteMaxUses(e.target.value)}
                      className="w-40"
                    />
                    <p className="text-xs text-muted-foreground">
                      How many people can join with this link. Leave blank for unlimited.
                      {(inviteRole === 'admin' || inviteRole === 'moderator') && ' Moderator and admin links must have a limit.'}
                    </p>
                  </div>
                )}

                {inviteError && (
                  <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{inviteError}</span>
                  </div>
                )}

                {emailResults && (
                  <div className="space-y-2">
                    <Label>Delivery results</Label>
                    <ul className="space-y-1 rounded-lg border p-3 text-sm">
                      {emailResults.map((r) => (
                        <li key={r.email} className="flex items-start gap-2">
                          {r.sent ? (
                            <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-600 shrink-0" />
                          ) : (
                            <AlertCircle className="h-4 w-4 mt-0.5 text-destructive shrink-0" />
                          )}
                          <span className="break-all">
                            <span className="font-medium">{r.email}</span>
                            {' — '}
                            {r.sent
                              ? r.channel === 'notification' ? 'invited in the app (they already have an account)' : `emailed${r.error ? ` — ${r.error}` : ''}`
                              : `not sent${r.error ? `: ${r.error}` : ''}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">
                      {emailResults.filter(r => r.sent).length} of {emailResults.length} invitations sent.
                      Failed addresses still have a pending invitation you can revoke below.
                    </p>
                  </div>
                )}

                {generatedLink && (
                  <div className="space-y-2">
                    <Label>Invitation Link</Label>
                    <div className="flex gap-2">
                      <Input value={generatedLink} readOnly className="text-sm" />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => void copyToClipboard(generatedLink, 'generated')}
                        aria-label="Copy invitation link"
                      >
                        {copied === 'generated' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Anyone with this link can join as {inviteRole}.{' '}
                      {inviteMaxUses.trim() ? `Up to ${inviteMaxUses.trim()} use${inviteMaxUses.trim() === '1' ? '' : 's'}.` : 'Unlimited uses.'}{' '}
                      Expires in 7 days.
                    </p>
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <Button variant="outline" onClick={resetInviteModal}>
                    {inviteFinished ? 'Done' : 'Cancel'}
                  </Button>
                  {!inviteFinished && (
                    <Button
                      onClick={handleCreateInvite}
                      disabled={inviting || (inviteType === 'email' && !inviteEmails.trim())}
                    >
                      {inviting ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          Creating...
                        </>
                      ) : inviteType === 'link' ? (
                        'Generate Link'
                      ) : (
                        'Send Invites'
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Pending Invitations */}
          {pendingInvitations.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  Pending Invitations
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {pendingInvitations.map((invite) => {
                    const exhausted = !invite.email && invite.max_uses !== null && invite.use_count >= invite.max_uses
                    return (
                    <div
                      key={invite.id}
                      className="flex items-center justify-between p-3 rounded-lg border bg-muted/30"
                    >
                      <div className="space-y-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          {invite.email ? (
                            <span className="font-medium">{invite.email}</span>
                          ) : (
                            <span className="text-muted-foreground flex items-center gap-1">
                              <LinkIcon className="h-4 w-4" />
                              Shareable Link
                            </span>
                          )}
                          <Badge variant="secondary" className="capitalize">
                            {invite.role.replace('_', ' ')}
                          </Badge>
                          {!invite.email && (
                            <Badge variant={exhausted ? 'destructive' : 'outline'} title="Uses / max uses">
                              {invite.use_count}/{invite.max_uses ?? '∞'} used
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Invited by {invite.invited_by ?? '—'}
                          {' · '}
                          Created {formatDistanceToNow(new Date(invite.created_at), { addSuffix: true })}
                          {' · '}
                          Expires {formatDistanceToNow(new Date(invite.expires_at), { addSuffix: true })}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {!invite.email && (
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => void copyToClipboard(`${window.location.origin}/invite/e/${invite.token}`, invite.id)}
                            aria-label="Copy invitation link"
                          >
                            {copied === invite.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                          </Button>
                        )}
                        {confirmRevokeId === invite.id ? (
                          <>
                            <Button variant="outline" size="sm" onClick={() => setConfirmRevokeId(null)}>Keep</Button>
                            <Button variant="destructive" size="sm" onClick={() => void handleRevokeInvite(invite.id)}>Revoke</Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setConfirmRevokeId(invite.id)}
                            aria-label="Revoke invitation"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Members List */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5" />
                All Members
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {members.map((member) => {
                  const isSelf = member.user_id === user?.id
                  const targetIsOwner = member.role === 'owner'
                  // Own row is locked; owner rows are locked for non-owners
                  const locked = isSelf || (targetIsOwner && !isOwner)
                  const saving = savingMemberId === member.id
                  const feedback = memberFeedback[member.id]
                  const confirming = confirmRemoveId === member.id
                  const roleOptions = ASSIGNABLE_ROLES.filter(r => isOwner || r.value !== 'owner')

                  return (
                    <div
                      key={member.id}
                      className="p-3 rounded-lg border space-y-2"
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className={`w-2 h-2 rounded-full shrink-0 ${ROLE_COLORS[member.role] || 'bg-gray-500'}`} />
                          <div className="min-w-0">
                            <p className="font-medium truncate">
                              {member.user_data?.display_name || (member.user_data?.handle ? `@${member.user_data.handle}` : null) || member.user_data?.email || 'Unknown member'}
                              {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                            </p>
                            {member.user_data?.email && member.user_data?.display_name && (
                              <p className="text-xs text-muted-foreground truncate">{member.user_data.email}</p>
                            )}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {locked ? (
                            <Badge variant="outline" className="capitalize">
                              {member.role.replace('_', ' ')}
                            </Badge>
                          ) : (
                            <select
                              aria-label={`Role for ${member.user_data?.display_name || member.user_data?.email || 'member'}`}
                              value={member.role}
                              disabled={saving}
                              onChange={(e) => handleRoleChange(member, e.target.value)}
                              className="h-9 rounded-md border bg-background px-2 text-sm disabled:opacity-60"
                            >
                              {roleOptions.map(r => (
                                <option key={r.value} value={r.value}>{r.label}</option>
                              ))}
                            </select>
                          )}

                          {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}

                          {!locked && !confirming && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title="Remove from event"
                              className="text-destructive hover:text-destructive"
                              disabled={saving}
                              onClick={() => setConfirmRemoveId(member.id)}
                            >
                              <UserMinus className="h-4 w-4" />
                            </Button>
                          )}
                        </div>
                      </div>

                      {confirming && (
                        <div className="flex items-center justify-between gap-2 rounded-md bg-destructive/10 border border-destructive/20 p-2 text-sm flex-wrap">
                          <span>
                            Remove{' '}
                            <span className="font-medium">
                              {member.user_data?.display_name || member.user_data?.email || 'this member'}
                            </span>{' '}
                            from {event.name}? Their proposals stay theirs.
                          </span>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={saving}
                              onClick={() => setConfirmRemoveId(null)}
                            >
                              Cancel
                            </Button>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={saving}
                              onClick={() => handleRemoveMember(member)}
                            >
                              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Remove'}
                            </Button>
                          </div>
                        </div>
                      )}

                      {feedback && (
                        <p
                          role="status"
                          className={`flex items-center gap-1 text-xs ${
                            feedback.kind === 'error' ? 'text-destructive' : 'text-green-600'
                          }`}
                        >
                          {feedback.kind === 'error' ? (
                            <AlertCircle className="h-3.5 w-3.5" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          {feedback.message}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </CardContent>
          </Card>
        </div>
  )
}
