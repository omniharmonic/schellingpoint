'use client'

/**
 * Organizer workspace → Knowledge (design §10.2–10.3): transcript coverage, "request
 * transcripts", the corpus export, provider status (never keys), "Embed now", "Generate
 * summaries and themes", and the Ask panel.
 */

import * as React from 'react'
import Link from 'next/link'
import { Archive, BellRing, Bot, Check, CheckCircle2, Copy, Cpu, Download, FileText, Loader2, RefreshCw, Sparkles, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { PageHeader } from '@/components/PageHeader'
import { AskPanel } from '@/components/knowledge/AskPanel'
import { AiKeyForm } from '@/components/knowledge/AiKeyForm'
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
  transcript: { id: string; format: string; char_count: number; word_count: number; created_at: string; has_summary: boolean; summary_edited: boolean; visibility: string } | null
}

interface Coverage {
  enabled: boolean
  visibility: 'members' | 'organizers'
  sessions: CoverageSession[]
  totals: { sessions: number; with_transcript: number; without_transcript: number; words: number; chunks: number; embedded: number }
  jobs: Array<{ id: string; kind: 'embed' | 'summaries'; status: string; processed: number; last_error: string | null; updated_at: string }>
  themes: { generated_at: string; model: string; themes: Array<{ title: string; summary: string; sessions: string[] }> } | null
  themes_edited_at: string | null
  providers: {
    embeddings:
      | { configured: true; provider: string; model: string; label: string; local: boolean; error: string | null }
      | { configured: false }
    chat: { configured: true; model: string; provider: 'anthropic' | 'openai-compatible'; source: 'gathering' | 'deployment' } | { configured: false }
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

/**
 * "AI access" (design 2026-09-25 §2.3b): what attendees can connect, the server URL, and a snippet
 * organizers can paste into their announcement. Nothing here is a secret — the tokens members mint
 * are personal and read only what they can already read.
 */
function AiAccessCard({ eventName, eventSlug }: { eventName: string; eventSlug: string }) {
  const [copied, setCopied] = React.useState<string | null>(null)
  const origin = typeof window === 'undefined' ? '' : window.location.origin
  const mcpUrl = `${origin}/api/mcp`
  const snippet = [
    `You can point your own AI assistant at ${eventName}.`,
    '',
    `1. Open ${origin}/account?tab=identity and create a token under “Connect an AI assistant”.`,
    `2. Add this MCP server to Claude, ChatGPT or Cursor: ${mcpUrl}`,
    '3. Use the token as the bearer token.',
    '',
    'Your assistant then sees exactly what you see — sessions, the schedule, and the transcripts you are allowed to read — and can change nothing.',
    `Step-by-step help: ${origin}/help/assistants`,
  ].join('\n')

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000)
    } catch {
      // The textarea below is selectable; copying by hand always works.
    }
  }

  return (
    <Card data-testid="ai-access-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="h-5 w-5 text-muted-foreground" aria-hidden />AI access for attendees
        </CardTitle>
        <CardDescription>
          Members can connect their own assistant (Claude, ChatGPT, Cursor) to this app and ask it about the schedule, who is hosting
          what, and the transcripts they are allowed to read. Each member mints their own token; an assistant can never write anything,
          read messages or email addresses, or see votes. Members find it on the{' '}
          <Link href={`/e/${eventSlug}/ask`} className="underline">Ask page</Link> and in Account → Identity.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">Server URL</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all font-mono text-xs" data-testid="ai-access-url">{mcpUrl}</code>
            <Button type="button" variant="ghost" size="sm" onClick={() => void copy(mcpUrl, 'url')} aria-label="Copy the server URL">
              {copied === 'url' ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            </Button>
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="ai-access-snippet">Announcement snippet</Label>
            <Button type="button" variant="outline" size="sm" onClick={() => void copy(snippet, 'snippet')}>
              {copied === 'snippet' ? <Check className="mr-1.5 h-4 w-4" aria-hidden /> : <Copy className="mr-1.5 h-4 w-4" aria-hidden />}
              Copy
            </Button>
          </div>
          <Textarea id="ai-access-snippet" readOnly rows={8} value={snippet} className="font-mono text-xs" />
          <p className="text-xs text-muted-foreground">Paste it into your welcome email or announcement. Nothing in it is secret.</p>
        </div>
      </CardContent>
    </Card>
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
  // Design §10.3: what a model generated is a draft. Organizers edit it; members read the edit.
  const [editingThemes, setEditingThemes] = React.useState<Array<{ title: string; summary: string; sessions: string[] }> | null>(null)
  const [savingThemes, setSavingThemes] = React.useState(false)
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
        const r = await apiFetch<{ sessions: number; notified: number; skipped: number }>(`${base}/coverage`, { method: 'POST', json: { action: 'request' } })
        const skippedNote = r.skipped ? `${plural(r.skipped, 'session')} asked in the last 24 hours skipped.` : ''
        toast({
          title: r.sessions ? `Asked the hosts of ${plural(r.sessions, 'session')}` : r.skipped ? 'Already asked today' : 'Every scheduled session already has a transcript',
          description: [r.notified ? `${plural(r.notified, 'notification')} sent.` : '', skippedNote].filter(Boolean).join(' ') || undefined,
          variant: 'success',
        })
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

  const saveThemes = async (next: Array<{ title: string; summary: string; sessions: string[] }>) => {
    setSavingThemes(true)
    try {
      await apiFetch(`${base}/summaries`, { method: 'PATCH', json: { themes: next.filter((t) => t.title.trim() && t.summary.trim()) } })
      toast({ title: 'Themes saved', description: 'Members read what you edited.', variant: 'success' })
      setEditingThemes(null)
      await load()
    } catch (e) {
      toast({ title: 'That did not save', description: e instanceof Error ? e.message : undefined, variant: 'destructive' })
    } finally {
      setSavingThemes(false)
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Sessions with a transcript" value={`${data.totals.with_transcript} / ${data.totals.sessions}`} hint="Approved and scheduled sessions" />
        <Stat label="Words collected" value={data.totals.words.toLocaleString()} />
        <Stat label="Chunks" value={data.totals.chunks} hint="≈ 800 tokens each, 15% overlap" />
        <Stat label="Indexed" value={data.totals.chunks ? `${Math.round((data.totals.embedded / data.totals.chunks) * 100)}%` : '—'} hint={data.providers.embeddings.configured ? `${data.totals.embedded} of ${data.totals.chunks} embedded` : 'No embeddings provider'} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
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
            <CardDescription>
            Embeddings are the server operator&apos;s setting and run on this box by default, so no transcript text leaves it; if the
            operator switches to a hosted provider, text is sent there — the consent checkbox and Participation settings say so.
            Answers use this gathering&apos;s own key when you set one below, otherwise the key the server is configured with.
          </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <dl className="space-y-2 text-sm">
              <div className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">Embeddings</dt>
                <dd className="flex items-center gap-1.5 text-right">
                  {data.providers.embeddings.configured ? <><CheckCircle2 className="h-4 w-4 text-success" aria-hidden />{data.providers.embeddings.label}</> : <><XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />Not configured</>}
                </dd>
              </div>
              {data.providers.embeddings.configured && data.providers.embeddings.error ? (
                <p className="text-right text-xs text-destructive">The on-box model did not load: {data.providers.embeddings.error}</p>
              ) : null}
              <div className="flex items-start justify-between gap-3">
                <dt className="text-muted-foreground">Answers</dt>
                <dd className="flex items-center gap-1.5 text-right">
                  {data.providers.chat.configured ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
                      {data.providers.chat.model}
                      <span className="text-xs text-muted-foreground">
                        {data.providers.chat.source === 'gathering' ? '(this gathering’s key)' : '(the server’s key)'}
                      </span>
                    </>
                  ) : (
                    <><XCircle className="h-4 w-4 text-muted-foreground" aria-hidden />Not configured</>
                  )}
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

            {isAdmin ? (
              <div className="border-t pt-4">
                <p className="mb-3 text-sm font-medium">This gathering’s answer key</p>
                <AiKeyForm eventSlug={event.slug} onChanged={() => void load()} />
              </div>
            ) : (
              <p className="border-t pt-4 text-xs text-muted-foreground">Only the owner and admins can set the gathering’s answer key.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <AiAccessCard eventName={event.name} eventSlug={event.slug} />

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
            <CardDescription>
              Generated {new Date(data.themes.generated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} from the session transcripts, and yours to edit —
              members read what is here. Members-only, never published.
              {data.themes_edited_at ? ` Edited ${new Date(data.themes_edited_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {editingThemes ? (
              <form
                className="space-y-4"
                onSubmit={(e) => {
                  e.preventDefault()
                  void saveThemes(editingThemes)
                }}
              >
                {editingThemes.map((t, i) => (
                  <div key={i} className="space-y-2 rounded-xl border p-4">
                    <Label htmlFor={`theme-title-${i}`}>Theme {i + 1}</Label>
                    <Input
                      id={`theme-title-${i}`}
                      value={t.title}
                      maxLength={120}
                      onChange={(e) => setEditingThemes((prev) => prev!.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
                    />
                    <Textarea
                      id={`theme-summary-${i}`}
                      aria-label={`Summary of theme ${i + 1}`}
                      rows={3}
                      maxLength={2000}
                      value={t.summary}
                      onChange={(e) => setEditingThemes((prev) => prev!.map((x, j) => (j === i ? { ...x, summary: e.target.value } : x)))}
                    />
                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditingThemes((prev) => prev!.filter((_, j) => j !== i))}>
                      Remove this theme
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" loading={savingThemes}>Save themes</Button>
                  <Button type="button" variant="outline" disabled={savingThemes} onClick={() => setEditingThemes(null)}>Cancel</Button>
                  <Button type="button" variant="ghost" disabled={savingThemes} onClick={() => setEditingThemes((prev) => [...(prev ?? []), { title: '', summary: '', sessions: [] }])}>
                    Add a theme
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">A theme with no title or no summary is dropped. Saving replaces what members read.</p>
              </form>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                </div>
                <Button variant="outline" size="sm" onClick={() => setEditingThemes(data.themes!.themes.map((t) => ({ ...t })))}>Edit themes</Button>
              </>
            )}
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="ask-heading" className="space-y-4">
        <h2 id="ask-heading" className="text-lg font-semibold">Ask the gathering</h2>
        <AskPanel eventSlug={event.slug} variant="organizer" adminLink={false} />
      </section>
    </div>
  )
}
