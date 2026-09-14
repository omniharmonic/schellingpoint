'use client'

import * as React from 'react'
import Link from 'next/link'
import { Send, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Event } from '@/types/event'

// X (Twitter) icon component
const XIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
)

const DiscordIcon = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
)

interface SocialLinks {
  twitter?: string
  telegram?: string
  discord?: string
  website?: string
}

interface FooterProps {
  className?: string
  variant?: 'default' | 'minimal'
  event?: Pick<Event, 'name' | 'logoUrl' | 'tagline' | 'theme'> | null
}

interface FooterBranding {
  name: string
  logoUrl?: string | null
  tagline?: string | null
  social?: SocialLinks
}

const PLATFORM_BRANDING: FooterBranding = {
  name: 'Schelling Point',
  tagline: 'Coordination protocol for unconferences',

}

function SocialIcons({ social, className }: { social?: SocialLinks; className?: string }) {
  if (!social) return null

  const links = [
    { href: social.telegram, icon: <Send className="h-4 w-4" strokeWidth={1.5} />, label: 'Telegram' },
    { href: social.twitter, icon: <XIcon className="h-4 w-4" />, label: 'X' },
    { href: social.discord, icon: <DiscordIcon className="h-4 w-4" />, label: 'Discord' },
    { href: social.website, icon: <Globe className="h-4 w-4" strokeWidth={1.5} />, label: 'Web' },
  ].filter((link) => link.href)

  if (links.length === 0) return null

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {links.map(({ href, icon, label }) => (
        <a
          key={label}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="p-2 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/5 transition-colors"
          aria-label={label}
        >
          {icon}
        </a>
      ))}
    </div>
  )
}

export function Footer({ className, variant = 'default', event }: FooterProps) {
  const isMinimal = variant === 'minimal'

  const branding: FooterBranding = event
    ? {
        name: event.name,
        logoUrl: event.logoUrl,
        tagline: event.tagline,
        social: event.theme?.social,
      }
    : PLATFORM_BRANDING

  return (
    <footer className={cn('border-t bg-background', className)}>
      <div className={cn('container mx-auto px-5', isMinimal ? 'py-6' : 'py-10')}>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/" className="font-semibold tracking-tight">{event ? 'Powered by Schelling Point' : 'Schelling Point'}</Link>
            {!isMinimal && <p className="text-sm text-muted-foreground mt-1">A little structure. A lot of possibility.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-5 text-xs text-muted-foreground">
            <SocialIcons social={branding.social} />
            <Link href="/codeofconduct" className="hover:text-foreground">Code of conduct</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
          </div>
        </div>
      </div>
    </footer>
  )
}
