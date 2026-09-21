'use client'

/**
 * Organizer workspace → Knowledge (design §10.2–10.3): transcript coverage, "request
 * transcripts", the corpus export, provider status (never keys), "Embed now", "Generate
 * summaries and themes", and the Ask panel.
 */

import * as React from 'react'
import Link from 'next/link'
import { Archive, BellRing, CheckCircle2, Cpu, Download, FileText, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { AskPanel } from '@/components/knowledge/AskPanel'
import { useEvent, useEventRole } from '@/contexts/EventContext'
import { apiFetch } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { cn } from '@/lib/utils'

interface CoverageSession {
  id: string
  title: string
  status: string
  host_name: string | null
  track: string | null
  starts_at: string | null
  transcript: { id: string; format: string; char_count: number; word_count: number; created_at: string; has_summary: boolean; visibility: string } | null
}

interface Coverage {
  enabled: boolean
  visibility: 'members' | 'organizers'
  sessions: CoverageSession[]
  totals: { sessions: number; with_transcript: number; without_transcript: number; words: number; chunks: number; embedded: number }
  jobs: Array<{ id: string; kind: 'embed' | 'summaries'; status: string; processed: number; last_error: string | null; updated_at: string }>
  themes: { generated_at: string; model: string; themes: Array<{ title: string; summary: string; sessions: string[] }> } | null
  providers: {
    embeddings: { configured: true; provider: string; model: string } | { configured: false }
    chat: { configured: true; model: string } | { configured: false }
  }
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="stat-value mt-1">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}

function JobBadge({ job }: { job: Coverage['jobs'][number] | undefined }) {
  if (!job) return null
  const variant = job.status === 'succeeded' ? 'success' : job.status === 'failed' ? 'destructive' : job.status === 'running' ? 'amber' : 'secondary'
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Badge variant={variant}>{job.status}</Badge>
      {job.processed > 0 && `${job.processed} processed`}
      {job.last_error && <span className="text-destructive">{job.last_error.slice(0, 120)}</span>}
    </span>
  )
}

export default function AdminKnowledgePage() {
  const event = useEvent()
  const { can, isAdmin, role } = useEventRole()
  const { toast } = useToast()
  const [data, setData] = React.useState<Coverage | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [confirmRequest, setConfirmRequest] = React.useState(false)
  const [working, setWorking] = React.useState<'request' | 'embed' | 'summaries' | null>(null)
  const base = `/api/v1/events/${event.slug}/knowledge`
  const organizer = isAdmin || role === 'moderator' || can('viewAnalytics')

  const load = React.useCallback(async () => {
    try {
      setData(await apiFetch<Coverage>(`${base}/coverage`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load coverage.')
    }
  }, [base])

  React.useEffect(() => {
    void load()
  }, [load])

  // While a job is live, refresh every few seconds.
  const live = data?.jobs.some((j) => j.status === 'queued' || j.status === 'running') ?? false
  React.useEffect(() => {
    if (!live) return
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [live, load])

  const run = async (kind: 'request' | 'embed' | 'summaries') => {
    setWorking(kind)
    try {
      if (kind === 'request') {
        const r = await apiFetch<{ sessions: number; notified: number }>(`${base}/coverage`, { method: 'POST', json: { action: 'request' } })
        toast({ title: r.sessions ? `Asked the hosts of ${plural(r.sessions, 'session')}` : 'Every scheduled session already has a transcript', description: r.notified ? `${plural(r.notified, 'notification')} sent.` : undefined, variant: 'success' })
        setConfirmRequest(false)
      } else {
        const r = await apiFetch<{ configured: boolean; queued: boolean; message?: string }>(`${base}/${kind}`, { method: 'POST' })
        if (!r.configured) toast({ title: kind === 'embed' ? 'Embeddings are not configured' : 'The answer model is not configured', description: r.message, variant: 'default' })
        else toast({ title: r.queued ? (kind === 'embed' ? 'Indexing started' : 'Generating summaries and themes') : 'Already running', variant: 'success' })
      }
      await load()
    } catch (e) {
      toast({ title: 'That did not work', description: e instanceof Error ? e.message : undefined, variant: 'destructive' })
    } finally {
      setWorking(null)
    }
  }

  if (!organizer) return null
  if (error) return <p className="text-sm text-destructive" role="alert">{error}</p>
  if (!data) return <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Loading coverage…</div>

  const embedJob = data.jobs.find((j) => j.kind === 'embed')
  const summariesJob = data.jobs.find((j) => j.kind === 'summaries')
  const missing = data.sessions.filter((s) => !s.transcript && s.status === 'scheduled').length
  const fmtWhen = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: event.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—')

  return (
    <div className="space-y-8">
      <PageHeader
        title="Knowledge"
        subtitle="Transcripts, the corpus export and — when a provider is configured — search and answers for members. Nothing here is ever published."
        actions={
          <Button asChild variant="outline">
            <Link href={`/e/${event.slug}/ask`}>Ask page for members</Link>
          </Button>
        }
      />

      {!data.enabled && (
        <p className="rounded-xl border border-signal-amber/40 bg-signal-amber/10 p-4 text-sm">
          Transcripts are turned off for this gathering. Turn them on under Settings → Participation to let hosts attach them.
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions with a transcript" value={`${data.totals.with_transcript} / ${data.totals.sessions}`} hint="Approved and scheduled sessions" />
        <Stat label="Words collected" value={data.totals.words.toLocaleString()} />
        <Stat label="Chunks" value={data.totals.chunks} hint="≈ 800 tokens each, 15% overlap" />
        <Stat label="Indexed" value={data.totals.chunks ? `${Math.round((data.totals.embedded / data.totals.chunks) * 100)}%` : '—'} hint={data.providers.embeddings.configured ? `${data.totals.embedded} of ${data.totals.chunks} embedded` : 'No embeddings provider'} />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><Archive className="h-5 w-5 text-muted-foreground" aria-hidden />Corpus</CardTitle>
            <CardDescription>A zip with corpus.jsonl (one chunk per line), sessions.json, a README with the schema and an embedding recipe, and every transcript as Markdown. Hosts appear by display name. Each download is logged.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild disabled={!data.totals.with_transcript}>
              <a href={`${base}/export`} download aria-disabled={!data.totals.with_transcript}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />Export corpus
              </a>
            </Button>
            {!confirmRequest ? (
              <Button variant="outline" onClick={() => setConfirmRequest(true)} disabled={!data.enabled || !missing}>
                <BellRing className="mr-1.5 h-4 w-4" aria-hidden />Request transcripts{missing ? ` (${missing})` : ''}
              </Button>
            ) : (
              <ConfirmInline
                className="basis-full"
                confirmLabel="Send requests"
                loading={working === 'request'}
                onConfirm={() => run('request')}
                onCancel={() => setConfirmRequest(false)}
                message={`Notify the hosts and co-hosts of ${plural(missing, 'scheduled session')} without a transcript?`}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><Cpu className="h-5 w-5 text-muted-foreground" aria-hidden />Search and answers</CardTitle>
            <CardDescription>Configured by the server operator through environment variables; keys are never shown here. When on, transcript text is sent to these providers — the consent checkbox and Participation settings say so.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">Embeddings</dt>
                <dd className="flex items-center gap-1.5 text-right">
                  {data.providers.embeddings.configured ? <><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />{data.providers.embeddings.provider} · {data.providers.embeddings.model}</> : <><XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />Not configured</>}
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">Answers</dt>
                <dd className="flex items-center gap-1.5 text-right">
                  {data.providers.chat.configured ? <><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />{data.providers.chat.model}</> : <><XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />Not configured</>}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" loading={working === 'embed'} disabled={!data.providers.embeddings.configured || !data.totals.chunks} onClick={() => run('embed')}>
                <RefreshCw className="mr-1.5 h-4 w-4" aria-hidden />Embed now
              </Button>
              <JobBadge job={embedJob} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" loading={working === 'summaries'} disabled={!data.providers.chat.configured || !data.totals.with_transcript} onClick={() => run('summaries')}>
                <Sparkles className="mr-1.5 h-4 w-4" aria-hidden />Generate summaries and themes
              </Button>
              <JobBadge job={summariesJob} />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg"><FileText className="h-5 w-5 text-muted-foreground" aria-hidden />Coverage</CardTitle>
          <CardDescription>Approved and scheduled sessions. Hosts, co-hosts and organizers add transcripts from the session page.</CardDescription>
        </CardHeader>
        <CardContent>
          {data.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approved or scheduled sessions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Session</th>
                    <th className="py-2 pr-3 font-medium">Host</th>
                    <th className="py-2 pr-3 font-medium">When</th>
                    <th className="py-2 pr-3 font-medium">Transcript</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sessions.map((s) => (
                    <tr key={s.id} className="border-b last:border-0">
                      <td className="py-2.5 pr-3">
                        <Link href={`/e/${event.slug}/sessions/${s.id}`} className="font-medium hover:underline">{s.title}</Link>
                        {s.track && <span className="ml-2 text-xs text-muted-foreground">{s.track}</span>}
                      </td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{s.host_name ?? '—'}</td>
                      <td className="py-2.5 pr-3 text-muted-foreground">{fmtWhen(s.starts_at)}</td>
                      <td className={cn('py-2.5 pr-3', !s.transcript && 'text-muted-foreground')}>
                        {s.transcript ? (
                          <span className="inline-flex flex-wrap items-center gap-1.5">
                            {plural(s.transcript.word_count, 'word')} · {s.transcript.format.toUpperCase()}
                            {s.transcript.has_summary && <Badge variant="muted">Summary</Badge>}
                            {s.transcript.visibility === 'organizers' && <Badge variant="secondary">Organizers only</Badge>}
                          </span>
                        ) : (
                          'None'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {data.themes && data.themes.themes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Themes</CardTitle>
            <CardDescription>Generated {new Date(data.themes.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} from the session transcripts. Members-only.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            {data.themes.themes.map((t) => (
              <div key={t.title} className="rounded-xl border p-4">
                <p className="font-medium">{t.title}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t.summary}</p>
                {t.sessions.length > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t.sessions.map((id) => data.sessions.find((s) => s.id === id)?.title).filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="ask-heading" className="space-y-4">
        <h2 id="ask-heading" className="text-lg font-semibold">Ask the gathering</h2>
        <AskPanel eventSlug={event.slug} variant="organizer" />
      </section>
    </div>
  )
}
