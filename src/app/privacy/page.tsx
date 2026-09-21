import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

export const metadata = { title: 'Privacy' }

const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || null

function Contact() {
  if (!contactEmail) return <>the operator of this instance</>
  return (
    <a href={`mailto:${contactEmail}`} className="text-primary hover:underline">
      {contactEmail}
    </a>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-semibold mb-3">{title}</h2>
      <div className="text-muted-foreground leading-relaxed space-y-3">{children}</div>
    </section>
  )
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />

      <main className="container mx-auto px-5 py-12 max-w-3xl flex-1">
        <h1 className="page-title mb-2">Privacy</h1>
        <p className="text-muted-foreground mb-8">Last updated: September 2026</p>

        <div className="max-w-none space-y-8 text-sm">
          <Section title="The short version">
            <p>
              This service runs on the AT Protocol, an open network. Some of what you do here becomes a{' '}
              <strong className="text-foreground">public record in your own repository</strong>, which anyone on the
              network can read and copy. Everything else stays on our server and is never published. This page lists
              which is which.
            </p>
          </Section>

          <Section title="Your identity">
            <p>
              Signing up with an email address creates an AT Protocol identity for you on our own data server
              (pds.unconference.events): a permanent identifier (a DID) and a generated handle such as
              calmotter417.unconference.events. The handle is never derived from your email. Your DID and handle are
              public by design; that is how the network works.
            </p>
            <p>
              We hold the password for that identity on your behalf, encrypted, so you never have to manage one. You
              can take full ownership at any time from Account → Identity: we rotate the password, show it to you once, and stop
              holding it. You can export your whole repository whenever you like.
            </p>
            <p>
              If you sign in with an existing AT Protocol account (for example Bluesky), the public records you create
              here are written into that account&apos;s repository and are permanently associated with it. We ask you to
              confirm this before your first public action. Signing in this way also imports your public profile (display
              name, photo and bio) from the network into your profile here; you can edit those fields, and re-sync them
              from the network at any time from Account → Identity.
            </p>
            <p>Your email address is never published and is used only to sign you in and send the notifications you choose.</p>
          </Section>

          <Section title="What becomes public (records on the network)">
            <ul className="list-disc list-inside space-y-2">
              <li>Session proposals you make, in your own repository: title, description, format, duration, topics and skills, and an optional public area you choose. Never an exact address.</li>
              <li>Your confirmation when you accept an invitation to co-host a session, in your own repository.</li>
              <li>Public endorsements, if you choose to make one. An endorsement is not a vote.</li>
              <li>An RSVP, only if you choose to share it publicly for a session.</li>
              <li>Your availability for a proposal, only if you choose to publish it.</li>
              <li>A public listing of your role at a gathering (for example host), only if the gathering allows it and you opt in.</li>
              <li>What gatherings publish in their own repository: the gathering itself, its policy, rooms, tracks, the published schedule, and vote tallies that show counts only, never who voted.</li>
            </ul>
            <p>
              Public records are copied by relays and other services across the network. You can delete a record you
              wrote, and we remove it from our index, but copies made by others before deletion may persist.
            </p>
          </Section>

          <Section title="What stays private (never published)">
            <ul className="list-disc list-inside space-y-2">
              <li>
                <strong className="text-foreground">Votes.</strong> While a round is open, your allocation is visible only
                to you; nobody sees live counts, including organizers. When the round closes, your votes are separated
                from your identity and the key that could link them is destroyed. Only the anonymous totals remain, and
                totals below a gathering&apos;s minimum voter count are not shown at all.
              </li>
              <li><strong className="text-foreground">Session feedback,</strong> which is anonymous and shown only as a summary once enough people have responded.</li>
              <li><strong className="text-foreground">Membership and the roster,</strong> visible only to fellow members of the same gathering. You can hide yourself from the directory.</li>
              <li><strong className="text-foreground">Tickets, payments and check-ins.</strong> Card payments are handled by Stripe; we never see card numbers.</li>
              <li><strong className="text-foreground">Exact locations</strong> for self-hosted sessions, meeting links and chat groups, shown only to confirmed attendees, hosts and organizers.</li>
              <li><strong className="text-foreground">Your profile details</strong> beyond your handle, display name and picture (bio, affiliation, interests, what you are looking for), shown to members of gatherings you share. Your messaging handle (Telegram, Signal, Matrix or similar) is shown only to fellow members. An ENS name is shown only if you verified it and chose to show it.</li>
              <li><strong className="text-foreground">Notifications</strong> and your notification preferences.</li>
            </ul>
          </Section>

          <Section title="Where data is stored and for how long">
            <p>
              Private data is stored in a database on a server in Helsinki, Finland, operated for this instance. Public
              records live in repositories on our data server and on whatever servers the network copies them to.
              Transactional email is delivered through Resend.
            </p>
            <ul className="list-disc list-inside space-y-2">
              <li>Vote allocations are deleted when a round closes; only anonymous entries remain.</li>
              <li>Notifications are deleted after 90 days.</li>
              <li>Who invited whom is forgotten 30 days after an invitation is used.</li>
              <li>Check-in times for past gatherings are reduced to counts after 90 days.</li>
              <li>Sign-in links expire after 15 minutes; sessions expire after 30 days.</li>
            </ul>
          </Section>

          <Section title="Cookies and tracking">
            <p>
              We set one essential cookie that keeps you signed in. There are no analytics, advertising or tracking
              cookies, and no third-party trackers.
            </p>
          </Section>

          <Section title="Your choices">
            <p>
              You can edit your profile, change notification preferences, hide yourself from directories, delete records
              you published, and take ownership of your identity from Account. To delete your account and the private
              data we hold about you, contact <Contact />. Deleting your account does not remove copies of public records
              held elsewhere on the network.
            </p>
          </Section>

          <Section title="Changes">
            <p>If this policy changes materially, we will update this page and its date.</p>
          </Section>
        </div>
      </main>

      <Footer variant="minimal" className="mt-auto" />
    </div>
  )
}
