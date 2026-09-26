'use client'

/**
 * Radix Dialog wrapper (focus trap, Escape, scroll lock, portal). Use for SettingsModal,
 * EditSessionModal and confirm dialogs instead of hand-rolled overlays.
 *
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent size="md">
 *       <DialogHeader>
 *         <DialogTitle>Edit session</DialogTitle>
 *         <DialogDescription>Changes are visible to organizers right away.</DialogDescription>
 *       </DialogHeader>
 *       …form…
 *       <DialogFooter>
 *         <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
 *         <Button type="submit" loading={saving}>Save changes</Button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 *
 * Every DialogContent must contain a DialogTitle (pass `hideClose` to drop the × button,
 * e.g. when an unsaved-changes guard owns dismissal; pair it with `onInteractOutside`).
 *
 * `variant="bottom"` makes it a sheet anchored to the bottom edge (the mobile More sheet,
 * design §2.2); everything else about it — focus trap, Escape, backdrop — is unchanged.
 */

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogPortal = DialogPrimitive.Portal
const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-foreground/40 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const SIZE = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
} as const

/**
 * `center` is the default modal. `bottom` is the mobile sheet (design §2.2): it rises from the
 * bottom edge, keeps clear of the home indicator, and is otherwise the same dialog — Radix still
 * traps focus, Escape and the backdrop still close it.
 */
const VARIANT = {
  center:
    'left-1/2 top-1/2 w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border p-6 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
  bottom:
    'inset-x-0 bottom-0 mx-auto w-full max-h-[calc(100dvh-5rem)] rounded-t-2xl border-t px-4 pt-5 pb-[max(1.25rem,calc(env(safe-area-inset-bottom)+0.75rem))] data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
} as const

export interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  size?: keyof typeof SIZE
  /** `bottom` anchors the dialog to the bottom edge as a sheet; the default is a centred modal. */
  variant?: keyof typeof VARIANT
  /** Omit the top-right close button (the footer must then offer a way out). */
  hideClose?: boolean
}

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, children, size = 'md', variant = 'center', hideClose, ...props }, ref) => (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 grid gap-4 overflow-y-auto bg-card text-card-foreground shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          VARIANT[variant],
          SIZE[size],
          className
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            aria-label="Close"
            className="absolute right-3 top-3 inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
)
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col gap-1.5 pr-8 text-left', className)} {...props} />
)
DialogHeader.displayName = 'DialogHeader'

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
)
DialogFooter.displayName = 'DialogFooter'

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('font-display text-lg font-semibold leading-tight tracking-tight', className)}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm leading-relaxed text-muted-foreground', className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}
