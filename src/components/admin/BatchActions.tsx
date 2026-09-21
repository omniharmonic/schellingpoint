'use client'

import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Check, X, Tag, Trash2, Loader2, ChevronDown } from 'lucide-react'
import { plural } from '@/lib/format'

interface Track {
  id: string
  name: string
  color: string | null
}

interface BatchActionsProps {
  selectedCount: number
  tracks?: Track[]
  onApprove?: () => void
  onReject?: (reason?: string) => void
  onAssignTrack?: (trackId: string) => void
  onDelete?: () => void
  onClearSelection: () => void
  isLoading?: boolean
  allowedActions?: ('approve' | 'reject' | 'assign_track' | 'delete')[]
}

export function BatchActions({
  selectedCount,
  tracks = [],
  onApprove,
  onReject,
  onAssignTrack,
  onDelete,
  onClearSelection,
  isLoading = false,
  allowedActions = ['approve', 'reject', 'assign_track', 'delete'],
}: BatchActionsProps) {
  const [showRejectDialog, setShowRejectDialog] = React.useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false)
  const [rejectReason, setRejectReason] = React.useState('')

  const handleReject = () => {
    onReject?.(rejectReason.trim() || undefined)
    setShowRejectDialog(false)
    setRejectReason('')
  }

  const handleDelete = () => {
    onDelete?.()
    setShowDeleteConfirm(false)
  }

  if (selectedCount === 0) return null

  const selection = plural(selectedCount, 'session')

  return (
    <>
      {/* Floating toolbar; bottom offset respects the phone safe area. */}
      <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+1.5rem)] left-1/2 z-50 -translate-x-1/2 animate-in slide-in-from-bottom-4 duration-200 max-w-[calc(100vw-2rem)]">
        <div role="toolbar" aria-label="Selected sessions" className="flex items-center gap-2 overflow-x-auto rounded-full border bg-card px-3 py-2 shadow-lg">
          <Badge variant="secondary" className="whitespace-nowrap text-sm font-medium">
            {selectedCount} selected
          </Badge>

          <div className="h-6 w-px shrink-0 bg-border" aria-hidden="true" />

          <div className="flex items-center gap-1">
            {allowedActions.includes('approve') && onApprove && (
              <Button size="sm" onClick={onApprove} disabled={isLoading} className="gap-1.5">
                <Check className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Approve</span>
                <span className="sr-only sm:hidden">Approve</span>
              </Button>
            )}

            {allowedActions.includes('reject') && onReject && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowRejectDialog(true)}
                disabled={isLoading}
                className="gap-1.5 text-destructive hover:text-destructive"
              >
                <X className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Reject</span>
                <span className="sr-only sm:hidden">Reject</span>
              </Button>
            )}

            {allowedActions.includes('assign_track') && onAssignTrack && tracks.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="ghost" disabled={isLoading} className="gap-1.5">
                    <Tag className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Track</span>
                    <span className="sr-only sm:hidden">Assign a track</span>
                    <ChevronDown className="h-3 w-3" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-52">
                  {tracks.map((track) => (
                    <DropdownMenuItem key={track.id} onSelect={() => onAssignTrack(track.id)} className="gap-2">
                      <span className="h-3 w-3 rounded-full" style={{ backgroundColor: track.color ?? undefined }} aria-hidden="true" />
                      {track.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onAssignTrack('')} className="text-muted-foreground">
                    Clear track
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {allowedActions.includes('delete') && onDelete && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowDeleteConfirm(true)}
                disabled={isLoading}
                className="gap-1.5 text-destructive hover:text-destructive"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <span className="hidden sm:inline">Delete</span>
                <span className="sr-only sm:hidden">Delete</span>
              </Button>
            )}
          </div>

          <div className="h-6 w-px shrink-0 bg-border" aria-hidden="true" />

          <Button size="icon-sm" variant="ghost" onClick={onClearSelection} disabled={isLoading} className="text-muted-foreground" aria-label="Clear selection">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>

          {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Working" />}
        </div>
      </div>

      <Dialog open={showRejectDialog} onOpenChange={(open) => { if (!open) setShowRejectDialog(false) }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Reject {selection}?</DialogTitle>
            <DialogDescription>Hosts are notified. A reason is optional and is included in their notification.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="batch-reject-reason">Reason (optional)</Label>
            <Textarea
              id="batch-reject-reason"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="What would make these proposals a better fit?"
              rows={3}
              maxLength={500}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectDialog(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleReject}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteConfirm} onOpenChange={(open) => { if (!open) setShowDeleteConfirm(false) }}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete {selection}?</DialogTitle>
            <DialogDescription>
              This cannot be undone. Sessions already published on the network are skipped; cancel those from the schedule builder.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
