import Link from 'next/link'
import { Bot, Eye, ScrollText, ShieldCheck } from 'lucide-react'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

/**
 * The help index (design 2026-09-25 §2.3c). Small on purpose: it lists the help pages that
 * actually exist, so the footer "Help" link always lands somewhere true. Add a card here whenever
 * a new page appears under /help.
 */

export const metadata = {
  title: 'Help',
  description: 'How to use unconference.events — connecting an AI assistant, and the policies that apply.',
}

const helpPages = [
  {
    href: '/help/assistants',
    icon: Bot,
    title: 'Connect an AI assistant',
    description:
      'Point Claude, ChatGPT or Cursor at the gatherings you belong to: mint a token, add the server, and ask it about the schedule or what was said in a session you missed.',
  },
  {
    href: '/help/privacy',
    icon: Eye,
    title: 'What is public and what is not',
    description:
      'What a gathering publishes, what its members see, what is never stored or shown, and what happens to your votes when a round closes.',
  },
]

const policies = [
  { href: '/codeofconduct', icon: ShieldCheck, title: 'Code of conduct', description: 'What we expect of everyone at a gathering, and how to report a problem.' },
  { href: '/privacy', icon: ScrollText, title: 'Privacy', description: 'What we store, what we publish, and what never leaves the members of a gathering.' },
  { href: '/terms', icon: ScrollText, title: 'Terms', description: 'The agreement between you and this service.' },
]

function Cards({ items }: { items: Array<{ href: string; icon: React.ComponentType<{ className?: string }>; title: string; description: string }> }) {
  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className="flex h-full items-start gap-3 rounded-2xl border bg-card p-5 transition-colors hover:border-primary/50 hover:bg-muted/30"
          >
            <span className="rounded-lg bg-primary/10 p-2">
              <item.icon className="h-5 w-5 text-primary" />
            </span>
            <span className="min-w-0">
              <span className="block font-semibold">{item.title}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{item.description}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export default function HelpIndexPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="container mx-auto flex-1 px-5 py-12 max-w-3xl">
        <h1 className="page-title mb-2">Help</h1>
        <p className="mb-10 text-muted-foreground">
          Short guides for the parts of unconference.events that are easy to miss. Organizers also have in-page guidance throughout the
          organizer workspace.
        </p>

        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Guides</h2>
          <Cards items={helpPages} />
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold">Policies</h2>
          <Cards items={policies} />
        </section>

        <p className="mt-10 text-sm text-muted-foreground">
          Something missing? Ask the organizers of your gathering — they can reach us.
        </p>
      </main>
      <Footer variant="minimal" />
    </div>
  )
}
