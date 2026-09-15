'use client'

import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Footer } from '@/components/Footer'

const contactEmail = process.env.NEXT_PUBLIC_CONTACT_EMAIL?.trim() || null

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="container mx-auto px-4">
          <div className="flex items-center h-14">
            <Button variant="ghost" size="sm" asChild>
              <Link href="/">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back
              </Link>
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="container mx-auto px-4 py-12 max-w-3xl">
        <h1 className="text-3xl font-bold mb-2">Terms of Service</h1>
        <p className="text-muted-foreground mb-8">Last updated: February 2026</p>

        <div className="prose prose-invert prose-sm max-w-none space-y-6">
          <section>
            <h2 className="text-xl font-semibold mb-3">Acceptance of Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              By accessing and using Schelling Point ("the Service"), you agree to be bound by these Terms of Service.
              If you do not agree to these terms, please do not use the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Description of Service</h2>
            <p className="text-muted-foreground leading-relaxed">
              Schelling Point is a session coordination platform for unconferences, hackathons, and community events, enabling participants to propose
              sessions, vote using quadratic voting, and help shape event schedules. The Service enables communities
              to collaboratively organize their events.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">User Accounts</h2>
            <ul className="list-disc list-inside text-muted-foreground space-y-2">
              <li>You must provide accurate information when creating an account</li>
              <li>You are responsible for maintaining the security of your account</li>
              <li>You must not share your login credentials with others</li>
              <li>One account per person is permitted</li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Acceptable Use</h2>
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
            <h2 className="text-xl font-semibold mb-3">Content Ownership</h2>
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
              The Service is provided "as is" without warranties of any kind. We do not guarantee that sessions will
              be scheduled or that the platform will be available without interruption. Participation in
              event sessions is at your own risk.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Limitation of Liability</h2>
            <p className="text-muted-foreground leading-relaxed">
              To the maximum extent permitted by law, Schelling Point and event organizers shall not be liable for any indirect,
              incidental, special, or consequential damages arising from your use of the Service.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">Changes to Terms</h2>
            <p className="text-muted-foreground leading-relaxed">
              We may update these Terms of Service from time to time. Continued use of the Service after changes
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
