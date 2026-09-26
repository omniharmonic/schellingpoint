import Link from 'next/link'
import type { EventActivity } from '@/lib/events/activity'

export function GatheringPulse({ activity, slug, sessions, scheduled, participants }: {
  activity: EventActivity; slug: string; sessions: number; scheduled: number; participants: number | null
}) {
  return <section aria-labelledby="gathering-pulse-title" className="overflow-hidden rounded-2xl border bg-card">
    <div className="grid lg:grid-cols-[1fr_1.4fr]">
      <div className="p-5 sm:p-6 lg:border-r">
        <h2 id="gathering-pulse-title" className="text-lg font-semibold">Taking shape</h2>
        <p className="mt-1 text-sm text-muted-foreground">A shared picture of your gathering.</p>
        <dl className="mt-5 grid grid-cols-3 gap-3">
          {[{ name: 'Sessions', n: sessions }, { name: 'Scheduled', n: scheduled }, ...(participants === null ? [] : [{ name: 'People', n: participants }])].map(item => <div key={item.name}><dd className="text-3xl font-semibold tracking-tight tabular-nums">{item.n}</dd><dt className="mt-1 text-sm text-muted-foreground">{item.name}</dt></div>)}
        </dl>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-secondary" role="progressbar" aria-label="Sessions scheduled" aria-valuenow={scheduled} aria-valuemin={0} aria-valuemax={Math.max(sessions, 1)}><div className="h-full rounded-full bg-primary" style={{ width: `${sessions ? Math.min(100, scheduled / sessions * 100) : 0}%` }} /></div>
        <p className="mt-2 text-xs text-muted-foreground">{sessions ? `${scheduled} of ${sessions} sessions have a place in the program.` : 'The first proposal starts the conversation.'}</p>
      </div>
      <div className="border-t p-5 sm:p-6 lg:border-t-0">
        <h3 className="font-semibold">{activity.mode === 'results' ? 'Most supported · closed voting' : 'Publicly backed sessions'}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{activity.mode === 'results' ? `Finalized results only. Sessions supported by fewer than ${activity.threshold} voters are withheld for privacy.` : 'Voluntary public endorsements, separate from private votes. Ballot totals stay hidden until voting closes.'}</p>
        {activity.entries.length ? <ol className="mt-3 divide-y">{activity.entries.map(entry => <li key={entry.id}><Link href={`/e/${slug}/sessions/${entry.id}`} className="flex min-h-14 items-center justify-between gap-4 rounded-lg py-3 hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"><span className="min-w-0 break-words text-sm font-medium">{entry.title}</span><span className="shrink-0 text-right"><span className="block font-semibold tabular-nums">{entry.count}</span><span className="block text-xs text-muted-foreground">{activity.mode === 'results' ? 'votes' : 'endorsements'}</span></span></Link></li>)}</ol> : <p className="mt-5 text-sm text-muted-foreground">{activity.mode === 'results' ? 'No session has a shareable result yet.' : 'No public endorsements yet. Explore sessions to find an idea you want to stand behind.'}</p>}
      </div>
    </div>
  </section>
}
