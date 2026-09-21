'use client'

import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || null

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <SiteHeader />

      {/* Content */}
      <main className="container mx-auto px-5 py-12 max-w-3xl flex-1">
        <h1 className="page-title mb-2">Terms of service</h1>
        <p className="text-muted-foreground mb-8">Last updated: February 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold mb-3">Acceptance of terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              By accessing and using unconference (“the Service”), you agree to be bound by these terms of service.
              If you do not agree to these terms, please do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Description of service</h2>
            <p className="text-muted-foreground leading-relaxed">
              unconference is a session coordination platform for unconferences, hackathons, and community events, enabling participants to propose
              sessions, vote using quadratic voting, and help shape event schedules. The Service enables communities
              to collaboratively organize their events.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">User accounts</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-2">
              <li>You must provide accurate information when creating an account</li>
              <li>You are responsible for maintaining the security of your account</li>
              <li>You must not share your login credentials with others</li>
              <li>One account per person is permitted</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Acceptable use</h2>
            <p className="text-muted-foreground leading-relaxed mb-3">
              When using the Service, you agree to:
            </p>
            <ul className="list-disc list-inside text-muted-foreground space-y-2">
              <li>Submit only genuine session proposals relevant to the event themes</li>
              <li>Vote honestly and not attempt to manipulate the voting system</li>
              <li>Respect other community members and their contributions</li>
              <li>Not post offensive, discriminatory, or inappropriate content</li>
              <li>Not attempt to circumvent security measures or exploit the platform</li>
              <li>Not use the Service for any unlawful purpose</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Voting</h2>
            <p className="text-muted-foreground leading-relaxed">
              Each gathering sets its own voting rules: how many credits participants receive and whether votes are
              quadratic (2 votes cost 4 credits), linear, or simple approval. Votes are private and results are sealed
              until a round closes. Attempting to game a vote through multiple accounts or other means may lead to your
              participation being removed by the gathering&apos;s organizers.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Content ownership</h2>
            <p className="text-muted-foreground leading-relaxed">
              You own what you write. Session proposals, co-host confirmations and endorsements are published as records
              in your own AT Protocol repository, where they remain yours to edit or delete. By publishing them you let
              gatherings and other applications on the network display them, including in schedules and listings.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Moderation</h2>
            <p className="text-muted-foreground leading-relaxed">
              Organizers decide what is programmed at their gathering. They can decline a proposal, remove it from the
              gathering&apos;s own listings and schedule, or ask its author to update it, but they cannot edit or delete a
              record in your repository. Moving or cancelling a session that is already on a published schedule requires
              the approval of as many organizers as the gathering&apos;s policy sets.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Disclaimer</h2>
            <p className="text-muted-foreground leading-relaxed">
              The Service is provided “as is” without warranties of any kind. We do not guarantee that sessions will
              be scheduled or that the platform will be available without interruption. Participation in
              event sessions is at your own risk.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Limitation of liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              To the maximum extent permitted by law, unconference and event organizers shall not be liable for any indirect,
              incidental, special, or consequential damages arising from your use of the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Changes to terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update these terms from time to time. Continued use of the Service after changes
              constitutes acceptance of the new terms.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Contact</h2>
            <p className="text-muted-foreground leading-relaxed">
              For questions about these terms, contact{' '}
              {contactEmail ? (
                <a href={`mailto:${contactEmail}`} className="text-primary hover:underline">
                  {contactEmail}
                </a>
              ) : (
                'the operator of this instance'
              )}
              .
            </p>
          </section>
        </div>
      </main>

      <Footer variant="minimal" className="mt-auto" />
    </div>
  )
}
