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
import { Select } from '@/components/ui/select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/hooks/useAuth'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch, ApiError } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'
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

// Role dots use tokens only (spec §2.3).
const ROLE_DOT: Record<string, string> = {
  owner: 'bg-primary',
  admin: 'bg-signal-cyan',
  moderator: 'bg-success',
  track_lead: 'bg-secondary-foreground',
  volunteer: 'bg-signal-amber',
  attendee: 'bg-muted-foreground',
}

// Order matches src/lib/permissions.ts hierarchy (highest first)
const ASSIGNABLE_ROLES: { value: string; label: string }[] = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'moderator', label: 'Moderator' },
  { value: 'track_lead', label: 'Track lead' },
  { value: 'volunteer', label: 'Volunteer' },
  { value: 'attendee', label: 'Attendee' },
]

const roleLabel = (role: string) => ASSIGNABLE_ROLES.find((r) => r.value === role)?.label ?? role.replace('_', ' ')

/** Elevated link invites default to a single use; attendee links default to unlimited. */
function defaultMaxUsesFor(role: string): string {
  return role === 'admin' || role === 'moderator' ? '1' : ''
}

/** "3 of 10 used" · "3 used, no limit". */
function usesLabel(invite: Invitation): string {
  return invite.max_uses === null ? `${invite.use_count} used, no limit` : `${invite.use_count} of ${invite.max_uses} used`
}

const memberName = (member: Member) =>
  member.user_data?.display_name || (member.user_data?.handle ? `@${member.user_data.handle}` : null) || member.user_data?.email || 'Member'

export default function AdminMembersPage() {
  const { user } = useAuth()
  const event = useEvent()
  const { isAdmin, isOwner } = useEventRole()
  const { toast } = useToast()

  const [members, setMembers] = React.useState<Member[]>([])
  const [invitations, setInvitations] = React.useState<Invitation[]>([])
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [showInviteForm, setShowInviteForm] = React.useState(false)
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
  const inviteFormRef = React.useRef<HTMLDivElement>(null)
  const inviteHeadingRef = React.useRef<HTMLHeadingElement>(null)

  const [savingMemberId, setSavingMemberId] = React.useState<string | null>(null)
  const [memberError, setMemberError] = React.useState<Record<string, string>>({})
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

  const openInviteForm = () => {
    setShowInviteForm(true)
    window.requestAnimationFrame(() => {
      inviteFormRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      inviteHeadingRef.current?.focus()
    })
  }

  const setRowError = (memberId: string, message: string | null) => {
    setMemberError((prev) => {
      const next = { ...prev }
      if (message) next[memberId] = message
      else delete next[memberId]
      return next
    })
  }

  const handleRoleChange = async (member: Member, newRole: string) => {
    if (newRole === member.role) return
    const previousRole = member.role
    setSavingMemberId(member.id)
    setRowError(member.id, null)
    setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: newRole } : m)))
    try {
      const data = await apiFetch<{ member: { role: string } }>(`${base}/members/${member.user_id}`, { method: 'PATCH', json: { role: newRole } })
      setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: data.member.role } : m)))
      toast({ title: `${memberName(member)} is now ${roleLabel(data.member.role).toLowerCase()}`, variant: 'success' })
    } catch (e) {
      setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: previousRole } : m)))
      setRowError(member.id, e instanceof ApiError ? e.message : 'The role could not be updated.')
    } finally {
      setSavingMemberId(null)
    }
  }

  const handleRemoveMember = async (member: Member) => {
    setSavingMemberId(member.id)
    setRowError(member.id, null)
    try {
      await apiFetch(`${base}/members/${member.user_id}`, { method: 'DELETE' })
      setMembers(prev => prev.filter(m => m.id !== member.id))
      toast({ title: `${memberName(member)} removed from ${event.name}`, variant: 'success' })
    } catch (e) {
      setRowError(member.id, e instanceof ApiError ? e.message : 'The member could not be removed.')
    } finally {
      setSavingMemberId(null)
      setConfirmRemoveId(null)
    }
  }

  const handleInviteRoleChange = (role: string) => {
    setInviteRole(role)
    setInviteMaxUses(defaultMaxUsesFor(role))
  }

  const resetInviteForm = () => {
    setShowInviteForm(false)
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
            setInviteError('Max uses must be a whole number of 1 or more, or left blank for no limit.')
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
      setInviteError(e instanceof ApiError ? e.message : 'The invitation could not be created.')
    } finally {
      setInviting(false)
    }
  }

  const handleRevokeInvite = async (id: string) => {
    setInviteListError(null)
    try {
      await apiFetch(`${base}/invitations/${id}`, { method: 'DELETE' })
      setInvitations(prev => prev.filter(i => i.id !== id))
      toast({ title: 'Invitation revoked', variant: 'success' })
    } catch (e) {
      setInviteListError(e instanceof ApiError ? e.message : 'The invitation could not be revoked.')
    } finally {
      setConfirmRevokeId(null)
    }
  }

  const copyToClipboard = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      toast({ title: 'Link copied', variant: 'success', duration: 2000 })
      setTimeout(() => setCopied(null), 2000)
    } catch {
      setInviteListError('Copying failed; select the link and copy it manually.')
    }
  }

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Members" />
        <Card><CardContent className="py-8 text-center text-muted-foreground">Only owners and admins manage members.</CardContent></Card>
      </>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12" role="status" aria-label="Loading members">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const pendingInvitations = invitations.filter(i => !i.accepted_at)
  const inviteFinished = !!generatedLink || !!emailResults

  return (
    <div>
      <PageHeader
        title="Members"
        subtitle={`${plural(members.length, 'member')} in ${event.name}`}
        actions={(
          <Button onClick={openInviteForm} disabled={showInviteForm}>
            <UserPlus className="h-4 w-4 mr-2" aria-hidden="true" />
            Invite people
          </Button>
        )}
      />

      <div className="space-y-6">
        {loadError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{loadError}</p>}
        {inviteListError && <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{inviteListError}</p>}

        {showInviteForm && (
          <Card className="border-primary scroll-mt-24" ref={inviteFormRef}>
            <CardHeader>
              <CardTitle ref={inviteHeadingRef} tabIndex={-1} className="focus-visible:outline-none">Invite people</CardTitle>
              <CardDescription>
                Share a link, or send invitations by email.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!inviteFinished && (
                <SegmentedControl<'link' | 'email'>
                  aria-label="Invitation method"
                  value={inviteType}
                  onValueChange={setInviteType}
                  options={[
                    { value: 'link', label: 'Shareable link', icon: <LinkIcon className="h-4 w-4" aria-hidden="true" /> },
                    { value: 'email', label: 'Email invitations', icon: <Mail className="h-4 w-4" aria-hidden="true" /> },
                  ]}
                />
              )}

              {inviteType === 'email' && !emailResults && (
                <div className="space-y-2">
                  <Label htmlFor="invite-emails">Email addresses</Label>
                  <Input
                    id="invite-emails"
                    placeholder="email@example.com, another@example.com"
                    value={inviteEmails}
                    onChange={(e) => setInviteEmails(e.target.value)}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    Separate addresses with commas. People who already have an account are invited in the app; others get an email.
                  </p>
                </div>
              )}

              {!inviteFinished && (
                <div className="space-y-2">
                  <Label htmlFor="invite-role">Role</Label>
                  <Select
                    id="invite-role"
                    value={inviteRole}
                    onChange={(e) => handleInviteRoleChange(e.target.value)}
                    wrapperClassName="sm:max-w-xs"
                  >
                    <option value="attendee">Attendee</option>
                    <option value="volunteer">Volunteer</option>
                    <option value="moderator">Moderator</option>
                    {isOwner && <option value="admin">Admin</option>}
                  </Select>
                </div>
              )}

              {inviteType === 'link' && !inviteFinished && (
                <div className="space-y-2">
                  <Label htmlFor="invite-max-uses">Max uses (optional)</Label>
                  <Input
                    id="invite-max-uses"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    placeholder="No limit"
                    value={inviteMaxUses}
                    onChange={(e) => setInviteMaxUses(e.target.value)}
                    className="w-40"
                  />
                  <p className="text-xs text-muted-foreground">
                    How many people can join with this link. Leave blank for no limit.
                    {(inviteRole === 'admin' || inviteRole === 'moderator') && ' Moderator and admin links must have a limit.'}
                  </p>
                </div>
              )}

              {inviteError && (
                <div role="alert" className="flex items-start gap-2 rounded-xl bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span>{inviteError}</span>
                </div>
              )}

              {emailResults && (
                <div className="space-y-2" role="status">
                  <p className="text-sm font-medium">Delivery</p>
                  <ul className="space-y-1 rounded-xl border p-3 text-sm">
                    {emailResults.map((r) => (
                      <li key={r.email} className="flex items-start gap-2">
                        {r.sent ? (
                          <CheckCircle2 className="h-4 w-4 mt-0.5 text-success shrink-0" aria-hidden="true" />
                        ) : (
                          <AlertCircle className="h-4 w-4 mt-0.5 text-destructive shrink-0" aria-hidden="true" />
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
                    {emailResults.filter(r => r.sent).length} of {plural(emailResults.length, 'invitation')} sent.
                    Failed addresses still have a pending invitation you can revoke below.
                  </p>
                </div>
              )}

              {generatedLink && (
                <div className="space-y-2" role="status">
                  <Label htmlFor="generated-invite-link">Invitation link</Label>
                  <div className="flex gap-2">
                    <Input id="generated-invite-link" value={generatedLink} readOnly className="text-sm" onFocus={(e) => e.currentTarget.select()} />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => void copyToClipboard(generatedLink, 'generated')}
                      aria-label={copied === 'generated' ? 'Copied' : 'Copy invitation link'}
                    >
                      {copied === 'generated' ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Anyone with this link can join as {roleLabel(inviteRole).toLowerCase()}.{' '}
                    {inviteMaxUses.trim() ? `Up to ${plural(Number(inviteMaxUses.trim()), 'use')}.` : 'No limit on uses.'}{' '}
                    Expires in 7 days.
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={resetInviteForm}>
                  {inviteFinished ? 'Done' : 'Cancel'}
                </Button>
                {!inviteFinished && (
                  <Button
                    onClick={handleCreateInvite}
                    loading={inviting}
                    disabled={inviteType === 'email' && !inviteEmails.trim()}
                  >
                    {inviteType === 'link' ? 'Create link' : 'Send invitations'}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock className="h-5 w-5" aria-hidden="true" />
              Pending invitations
            </CardTitle>
            <CardDescription>Links and email invitations that have not been used up yet.</CardDescription>
          </CardHeader>
          <CardContent>
            {pendingInvitations.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                <p>No pending invitations. Create a shareable link or email people to bring them in.</p>
                {!showInviteForm && (
                  <Button variant="outline" className="mt-4" onClick={openInviteForm}><UserPlus className="h-4 w-4 mr-2" aria-hidden="true" />Invite people</Button>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {pendingInvitations.map((invite) => {
                  const exhausted = !invite.email && invite.max_uses !== null && invite.use_count >= invite.max_uses
                  return (
                    <div key={invite.id} className="space-y-2 p-3 rounded-xl border bg-muted/30">
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div className="space-y-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {invite.email ? (
                              <span className="font-medium break-all">{invite.email}</span>
                            ) : (
                              <span className="text-muted-foreground flex items-center gap-1">
                                <LinkIcon className="h-4 w-4" aria-hidden="true" />
                                Shareable link
                              </span>
                            )}
                            <Badge variant="secondary">{roleLabel(invite.role)}</Badge>
                            {!invite.email && (
                              <Badge variant={exhausted ? 'muted' : 'outline'}>{exhausted ? `Used up (${usesLabel(invite)})` : usesLabel(invite)}</Badge>
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
                        {confirmRevokeId !== invite.id && (
                          <div className="flex items-center gap-1">
                            {!invite.email && (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() => void copyToClipboard(`${window.location.origin}/invite/e/${invite.token}`, invite.id)}
                                aria-label={copied === invite.id ? 'Copied' : 'Copy invitation link'}
                              >
                                {copied === invite.id ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="text-destructive hover:text-destructive"
                              onClick={() => setConfirmRevokeId(invite.id)}
                              aria-label="Revoke invitation"
                            >
                              <Trash2 className="h-4 w-4" aria-hidden="true" />
                            </Button>
                          </div>
                        )}
                      </div>
                      {confirmRevokeId === invite.id && (
                        <ConfirmInline
                          layout="inline"
                          destructive
                          message={invite.email ? `Revoke the invitation for ${invite.email}?` : 'Revoke this link? Anyone who has it can no longer join with it.'}
                          confirmLabel="Revoke"
                          onConfirm={() => void handleRevokeInvite(invite.id)}
                          onCancel={() => setConfirmRevokeId(null)}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="h-5 w-5" aria-hidden="true" />
              All members
            </CardTitle>
            <CardDescription>Your own row and the owner’s are locked.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {members.map((member) => {
                const isSelf = member.user_id === user?.id
                const targetIsOwner = member.role === 'owner'
                // Own row is locked; owner rows are locked for non-owners
                const locked = isSelf || (targetIsOwner && !isOwner)
                const saving = savingMemberId === member.id
                const rowError = memberError[member.id]
                const confirming = confirmRemoveId === member.id
                const roleOptions = ASSIGNABLE_ROLES.filter(r => isOwner || r.value !== 'owner')
                const name = memberName(member)

                return (
                  <div key={member.id} className="p-3 rounded-xl border space-y-2">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className={cn('w-2 h-2 rounded-full shrink-0', ROLE_DOT[member.role] || 'bg-muted-foreground')} aria-hidden="true" />
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {name}
                            {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                          </p>
                          {member.user_data?.handle && member.user_data?.display_name && (
                            <p className="text-xs text-muted-foreground truncate">@{member.user_data.handle}</p>
                          )}
                          {!member.user_data?.handle && member.user_data?.email && member.user_data?.display_name && (
                            <p className="text-xs text-muted-foreground truncate">{member.user_data.email}</p>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        {locked ? (
                          <Badge variant="outline">{roleLabel(member.role)}</Badge>
                        ) : (
                          <Select
                            aria-label={`Role for ${name}`}
                            value={member.role}
                            disabled={saving}
                            onChange={(e) => handleRoleChange(member, e.target.value)}
                            wrapperClassName="w-40"
                          >
                            {roleOptions.map(r => (
                              <option key={r.value} value={r.value}>{r.label}</option>
                            ))}
                          </Select>
                        )}

                        {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Saving" />}

                        {!locked && !confirming && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Remove ${name} from ${event.name}`}
                            className="text-destructive hover:text-destructive"
                            disabled={saving}
                            onClick={() => setConfirmRemoveId(member.id)}
                          >
                            <UserMinus className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        )}
                      </div>
                    </div>

                    {confirming && (
                      <ConfirmInline
                        layout="inline"
                        destructive
                        message={<>Remove <span className="font-medium">{name}</span> from {event.name}? Their proposals stay theirs.</>}
                        confirmLabel="Remove"
                        loading={saving}
                        onConfirm={() => void handleRemoveMember(member)}
                        onCancel={() => setConfirmRemoveId(null)}
                      />
                    )}

                    {rowError && (
                      <p role="alert" className="flex items-center gap-1 text-xs text-destructive">
                        <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        {rowError}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
