'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
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
import { getAccessToken } from '@/lib/supabase/client'
import { formatDistanceToNow } from 'date-fns'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

interface Member {
  id: string
  user_id: string
  role: string
  joined_at: string
  user_data: {
    display_name: string | null
    email: string | null
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
}

interface EmailResult {
  email: string
  sent: boolean
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
  const router = useRouter()
  const { user, isLoading: authLoading } = useAuth()
  const event = useEvent()
  const { isAdmin, isOwner, isLoading: roleLoading } = useEventRole()

  const [members, setMembers] = React.useState<Member[]>([])
  const [invitations, setInvitations] = React.useState<Invitation[]>([])
  const [loading, setLoading] = React.useState(true)

  const [showInviteModal, setShowInviteModal] = React.useState(false)
  const [inviteEmails, setInviteEmails] = React.useState('')
  const [inviteRole, setInviteRole] = React.useState('attendee')
  const [inviteType, setInviteType] = React.useState<'email' | 'link'>('link')
  const [inviteMaxUses, setInviteMaxUses] = React.useState<string>(defaultMaxUsesFor('attendee'))
  const [inviting, setInviting] = React.useState(false)
  const [inviteError, setInviteError] = React.useState<string | null>(null)
  const [emailResults, setEmailResults] = React.useState<EmailResult[] | null>(null)
  const [generatedLink, setGeneratedLink] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState(false)

  // Per-member role editing / removal state
  const [savingMemberId, setSavingMemberId] = React.useState<string | null>(null)
  const [memberFeedback, setMemberFeedback] = React.useState<
    Record<string, { kind: 'success' | 'error'; message: string }>
  >({})
  const [confirmRemoveId, setConfirmRemoveId] = React.useState<string | null>(null)

  // Redirect if not admin
  React.useEffect(() => {
    if (!authLoading && !roleLoading && (!user || !isAdmin)) {
      router.push(`/e/${event.slug}/sessions`)
    }
  }, [user, isAdmin, authLoading, roleLoading, router, event.slug])

  const fetchInvitations = React.useCallback(async (token: string) => {
    const invitationsRes = await fetch(`/api/v1/events/${event.slug}/invitations`, {
      headers: { 'Authorization': `Bearer ${token}` },
    })
    if (invitationsRes.ok) {
      const data = await invitationsRes.json()
      setInvitations(data.invitations || [])
    }
  }, [event.slug])

  // Fetch members and invitations
  React.useEffect(() => {
    async function fetchData() {
      const token = getAccessToken()
      if (!token) return

      try {
        // Fetch members. Join to profiles via PostgREST FK resolution so we
        // get display_name/email alongside each event_member row.
        const membersRes = await fetch(
          `${SUPABASE_URL}/rest/v1/event_members?event_id=eq.${event.id}&select=id,user_id,role,joined_at,user_data:profiles!user_id(display_name,email)&order=role.asc,joined_at.asc`,
          {
            headers: {
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${token}`,
            },
          }
        )
        if (membersRes.ok) {
          setMembers(await membersRes.json())
        }

        await fetchInvitations(token)
      } catch (err) {
        console.error('Error fetching data:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [event.id, fetchInvitations])

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
    const token = getAccessToken()
    if (!token || newRole === member.role) return

    const previousRole = member.role
    setSavingMemberId(member.id)
    // Optimistic update
    setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: newRole } : m)))

    try {
      const response = await fetch(`/api/v1/events/${event.slug}/members/${member.user_id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ role: newRole }),
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        // Roll back
        setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: previousRole } : m)))
        setFeedback(member.id, 'error', data.error || 'Failed to update role')
        return
      }

      setMembers(prev =>
        prev.map(m => (m.id === member.id ? { ...m, role: data.member?.role ?? newRole } : m))
      )
      setFeedback(member.id, 'success', 'Role updated')
    } catch (err) {
      console.error('Error updating role:', err)
      setMembers(prev => prev.map(m => (m.id === member.id ? { ...m, role: previousRole } : m)))
      setFeedback(member.id, 'error', 'Network error while updating role')
    } finally {
      setSavingMemberId(null)
    }
  }

  const handleRemoveMember = async (member: Member) => {
    const token = getAccessToken()
    if (!token) return

    setSavingMemberId(member.id)
    try {
      const response = await fetch(`/api/v1/events/${event.slug}/members/${member.user_id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })
      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setFeedback(member.id, 'error', data.error || 'Failed to remove member')
        return
      }

      setMembers(prev => prev.filter(m => m.id !== member.id))
    } catch (err) {
      console.error('Error removing member:', err)
      setFeedback(member.id, 'error', 'Network error while removing member')
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
    const token = getAccessToken()
    if (!token) return

    setInviting(true)
    setGeneratedLink(null)
    setEmailResults(null)
    setInviteError(null)

    try {
      const body: { emails?: string[]; role: string; max_uses?: number | null } = { role: inviteRole }

      if (inviteType === 'email' && inviteEmails.trim()) {
        body.emails = inviteEmails.split(',').map(e => e.trim()).filter(e => e)
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

      const response = await fetch(`/api/v1/events/${event.slug}/invitations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        setInviteError(data.error || 'Failed to create invitation')
        return
      }

      if (data.inviteUrl) {
        setGeneratedLink(data.inviteUrl)
      }

      if (inviteType === 'email') {
        // Surface per-address delivery results instead of silently closing
        const results: EmailResult[] = Array.isArray(data.emailResults)
          ? data.emailResults
          : (body.emails || []).map(email => ({ email, sent: true }))
        setEmailResults(results)
        setInviteEmails('')
      }

      await fetchInvitations(token)
    } catch (err) {
      console.error('Error creating invitation:', err)
      setInviteError('Network error while creating invitation')
    } finally {
      setInviting(false)
    }
  }

  const handleRevokeInvite = async (id: string) => {
    const token = getAccessToken()
    if (!token) return

    if (!confirm('Revoke this invitation?')) return

    try {
      await fetch(`/api/v1/events/${event.slug}/invitations/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      })

      setInvitations(prev => prev.filter(i => i.id !== id))
    } catch (err) {
      console.error('Error revoking invitation:', err)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (authLoading || roleLoading || loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAdmin) return null

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
                      Separate multiple emails with commas
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
                      {inviteRole === 'admin' && ' Admin links must have a limit.'}
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
                            {r.sent ? 'sent' : `failed${r.error ? `: ${r.error}` : ''}`}
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
                        onClick={() => copyToClipboard(generatedLink)}
                      >
                        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
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
                            onClick={() => copyToClipboard(`${window.location.origin}/invite/e/${invite.token}`)}
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive hover:text-destructive"
                          onClick={() => handleRevokeInvite(invite.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
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
                              {member.user_data?.display_name || member.user_data?.email || 'Unknown User'}
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
                            from {event.name}? Their votes and sessions are kept.
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
