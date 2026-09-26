import Link from 'next/link'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

/**
 * Where the mechanism went (design 2026-09-26 §6). Every in-app explainer that used to spell out
 * how something is stored now says what happens in one or two sentences and links here as
 * "Learn more". The five sections are fixed, and `tests/copy-budget.spec.ts` asserts they render:
 * an in-app sentence may point at any of them, so none of them may quietly disappear.
 *
 * This is the plain-language companion to `/privacy`, which stays the policy of record. Nothing
 * here is a secret, so the page is public: people read it before they have an account.
 */

export const metadata = {
  title: 'What is public and what is not',
  description: 'What a gathering publishes, what its members see, and what is never stored or shown.',
}

const SECTIONS = [
  { id: 'public', title: 'What is public' },
  { id: 'members', title: 'What members of a gathering see' },
  { id: 'never', title: 'What is never stored or shown' },
  { id: 'identity', title: 'Your identity on the open network' },
  { id: 'assistants', title: 'AI assistants and transcripts' },
] as const

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="mb-3 text-xl font-semibold">{title}</h2>
      <div className="space-y-3 leading-relaxed text-muted-foreground">{children}</div>
    </section>
  )
}

function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="text-foreground">{children}</strong>
}

export default function HelpPrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />

      <main className="container mx-auto max-w-3xl flex-1 px-5 py-12">
        <h1 className="page-title mb-2">What is public and what is not</h1>
        <p className="mb-8 text-muted-foreground">
          This app runs on an open network, so a few things you do here are readable by anyone, and most things are
          not. This page says which is which, in order of how far each one travels.
        </p>

        <nav aria-label="On this page" className="mb-10 rounded-2xl border bg-card p-5">
          <p className="mb-2 text-sm font-semibold">On this page</p>
          <ul className="space-y-1.5 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-primary hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="max-w-none space-y-10 text-sm">
          <Section id="public" title="What is public">
            <p>
              A public record is a small file in your own repository on the AT Protocol network. Anyone can read one,
              other services copy them, and copies made before you delete yours can outlive it. You write every record
              in your own repository; nobody writes one for you, and no record ever carries someone else&apos;s name
              unless they wrote it themselves.
            </p>
            <p>These are the ones you can create:</p>
            <ul className="list-inside list-disc space-y-1.5">
              <li>
                <Strong>A session proposal</Strong> — its title, description, format, duration and topics, plus a
                public area if you name one. Never an exact address.
              </li>
              <li>
                <Strong>Your confirmation</Strong> when you accept an invitation to co-host a session.
              </li>
              <li>
                <Strong>An endorsement</Strong> of a proposal, if you make one. An endorsement is not a vote, and it
                spends nothing.
              </li>
              <li>
                <Strong>An RSVP</Strong>, and <Strong>your availability</Strong> for a proposal — each only if you
                choose to share it.
              </li>
              <li>
                <Strong>Your display name and bio</Strong>, only after you switch on the public profile in Account.
                Your photo, email and everything else stay here.
              </li>
              <li>
                <Strong>&ldquo;I hosted at this gathering&rdquo;</Strong>, only if the organizers allow role listings
                and you switch it on for that gathering.
              </li>
            </ul>
            <p>
              A gathering publishes from its own account, not from an organizer&apos;s: the gathering itself, its
              policy, its rooms and tracks, the schedule once it is out, and vote totals after a round closes. Totals
              show counts only, never who voted, and a session named by fewer people than the gathering&apos;s
              threshold shows no count at all.
            </p>
            <p>
              When you delete a record it leaves your repository and this app&apos;s index. Copies other services
              already took are theirs, and this app cannot reach them.
            </p>
          </Section>

          <Section id="members" title="What members of a gathering see">
            <p>
              Joining a gathering makes you a member of that gathering and no other. Members see each other; the rest
              of the world does not.
            </p>
            <ul className="list-inside list-disc space-y-1.5">
              <li>
                <Strong>The roster and profiles</Strong> — name, photo, affiliation, interests and what you are looking
                for. You can hide yourself from the directory in Account.
              </li>
              <li>
                <Strong>Your messaging handle</Strong> and <Strong>your email address</Strong>, each behind its own
                switch, per gathering. Email is off unless you turn it on.
              </li>
              <li>
                <Strong>Transcripts</Strong> a host, co-host or organizer attached to a session, and anything the
                gathering&apos;s assistant answers from them.
              </li>
              <li>
                <Strong>Room outlines and floor plans</Strong> on the gathering map.
              </li>
              <li>
                <Strong>Chat groups and meeting links</Strong>, and the exact address of a self-hosted session — those
                reach confirmed attendees, the host and the organizers. Everyone else sees the neighbourhood.
              </li>
            </ul>
            <p>
              Hosts and organizers see how many people saved, RSVP&apos;d to or voted for a session, never which
              people. A count that would come from a handful of people is withheld instead.
            </p>
          </Section>

          <Section id="never" title="What is never stored or shown">
            <p>
              <Strong>Your votes, once a round closes.</Strong> While a round is open your allocation is yours alone:
              nobody sees a count, organizers included. When the round closes, the one thing that tied each vote to a
              person is destroyed in the same step, so afterwards nobody — not you, not the organizers, not the people
              who run this server — can say which votes were yours. Only anonymous totals remain.
            </p>
            <p>
              <Strong>Nothing about a vote ever becomes a public record.</Strong> Neither do ballots, tickets,
              check-ins, rosters, RSVPs you did not choose to share, the names organizers use for speakers who have no
              account, or the reason anybody was reported.
            </p>
            <p>
              <Strong>No exact address is ever published.</Strong> A self-hosted session&apos;s public area is rounded
              to roughly a neighbourhood; a private home&apos;s pin reaches members only. Room outlines stay in this
              app.
            </p>
            <p>
              <Strong>There is no leaderboard and no ranking.</Strong> Tallies are listed alphabetically on purpose.
            </p>
            <p>
              <Strong>Session feedback is anonymous</Strong> and appears only as a summary, once enough people have
              answered.
            </p>
          </Section>

          <Section id="identity" title="Your identity on the open network">
            <p>
              Signing in with an email address creates an identity for you on this instance&apos;s own data server: a
              permanent identifier and a generated handle such as calmotter417.unconference.events. Neither is derived
              from your email, and your email is never published.
            </p>
            <p>
              The password for that identity is held here, encrypted, so you never have to manage one. Take ownership
              from Account → Identity whenever you like: you get a new password, shown to you once, and this app stops
              holding it. From then on you sign in to your own data server, change the password, export everything you
              have written, or move to another provider.
            </p>
            <p>
              You can also sign in with an AT Protocol account you already have, such as a Bluesky one. Everything you
              publish here then belongs to that account, permanently, and this app asks you to confirm that before your
              first public action.
            </p>
            <p>
              Leaving a gathering takes you off its roster and cancels your RSVPs. The sessions you proposed stay where
              they are: they are yours, and a gathering cannot take them down.
            </p>
          </Section>

          <Section id="assistants" title="AI assistants and transcripts">
            <p>
              You can point your own assistant — Claude, ChatGPT, Cursor — at the gatherings you belong to and ask it
              about the schedule or about a session you missed. It sees exactly what you see and nothing more, it
              cannot change anything, and it cannot read votes, other people&apos;s messages or anyone&apos;s email
              address. Your questions and the excerpts it reads go to whoever runs that assistant.
            </p>
            <p>
              A token is what connects it. Only a fingerprint of the token is kept here, so it is shown to you once and
              never again; revoke it in Account and the assistant loses its access immediately.{' '}
              <Link href="/help/assistants" className="text-primary hover:underline">
                How to connect one
              </Link>
              .
            </p>
            <p>
              Transcripts stay inside the gathering that holds them, and are never published. Whoever attaches one
              confirms that everyone in the room was told the session was being recorded. If the organizers switch on
              search and answers, the text is indexed — on this server by default, or by the AI provider the operator
              or the gathering has configured. The gathering&apos;s Knowledge page says which is running.
            </p>
          </Section>

          <Section id="policy" title="The policy itself">
            <p>
              This page explains the product. The binding version, with retention periods and where data is stored, is
              the{' '}
              <Link href="/privacy" className="text-primary hover:underline">
                privacy policy
              </Link>
              . Something here unclear or wrong? Tell the organizers of your gathering — they can reach the operator.
            </p>
          </Section>
        </div>
      </main>

      <Footer variant="minimal" className="mt-auto" />
    </div>
  )
}
