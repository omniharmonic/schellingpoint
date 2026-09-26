import Link from 'next/link'
import { SiteHeader } from '@/components/SiteHeader'
import { Footer } from '@/components/Footer'

export default function CodeOfConductPage() {
  const contact = process.env.NEXT_PUBLIC_CONTACT_EMAIL
  return <div className="flex min-h-screen flex-col bg-background">
    <SiteHeader />
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12 sm:py-16">
      <h1 className="page-title">Code of conduct</h1>
      <p className="mt-3 text-lg leading-relaxed text-muted-foreground">Make room for people. Respect their boundaries. Take care of the gathering.</p>
      <p className="mt-4 text-sm text-muted-foreground">Updated September 2026</p>
      <div className="mt-8 space-y-9 text-base leading-7">
        <section><h2 className="mb-3 text-xl font-semibold">A shared baseline</h2><p>unconference is a platform for independent, participant-led gatherings of all kinds. Everyone deserves to take part without harassment or discrimination, regardless of their background, identity, ability, beliefs or experience.</p><p className="mt-3">These expectations apply to participation on the platform and at gatherings hosted here. Each organizer is responsible for their own event and may add an event-specific code of conduct. Look for it on the gathering’s join screen or in its settings.</p></section>
        <section><h2 className="mb-3 text-xl font-semibold">How we participate</h2><ul className="list-disc space-y-2 pl-5">
          <li>Share the space and the conversation. Listen, make room for quieter voices, and welcome newcomers.</li>
          <li>Discuss ideas without attacking people. Disagreement is welcome; intimidation is not.</li>
          <li>Ask before photographing, recording or sharing someone’s words or personal information. Respect a refusal.</li>
          <li>Respect accessibility needs, personal space and requests to stop contact.</li>
          <li>Be honest about who you are. Do not impersonate others, spam participants or make misleading payment requests.</li>
        </ul></section>
        <section><h2 className="mb-3 text-xl font-semibold">What is not acceptable</h2><p>Harassment, discriminatory abuse, threats, stalking, unwanted sexual attention, sustained disruption, retaliation against someone who reports a concern, and disclosure of private information without consent are not acceptable. Organizers may intervene when conduct makes participation unsafe, whether it happens in person or online.</p></section>
        <section className="rounded-2xl border bg-secondary/40 p-5 sm:p-6"><h2 className="mb-3 text-xl font-semibold">If something happens</h2><p>Contact the gathering’s organizers using the contact details or reporting process they provide. For content in the app, use the report action where available. Include what happened, when and where, and any information you are comfortable sharing.</p><p className="mt-3">For immediate danger, contact local emergency services or venue staff. The platform is not an emergency response service.</p>{contact && <p className="mt-3">For a concern about the platform itself, contact <a className="break-all text-primary underline underline-offset-4" href={`mailto:${contact}`}>{contact}</a>.</p>}</section>
        <section><h2 className="mb-3 text-xl font-semibold">Responding to concerns</h2><p>Organizers should handle reports with care, limit sharing to people who need to respond, and explain their process. Responses may include a request to stop, a warning, removal of content, or restriction of participation. Serious concerns may require immediate action. Refunds are handled under the gathering’s stated ticket policy.</p><p className="mt-3">Ask the relevant organizers how to request a review of a decision. Platform moderation and event moderation are separate responsibilities.</p></section>
        <section><h2 className="mb-3 text-xl font-semibold">For organizers</h2><p>Make your reporting contact easy to find before the event. Tell participants who can help, how concerns are handled, and any event-specific expectations. Do not rely on an unannounced wristband, lanyard color or information desk as the only way to get help.</p><p className="mt-3">Read our <Link href="/privacy" className="text-primary underline underline-offset-4">privacy policy</Link> for how the platform handles information.</p></section>
      </div>
    </main>
    <Footer variant="minimal" />
  </div>
}
