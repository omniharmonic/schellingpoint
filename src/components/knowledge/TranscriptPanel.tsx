'use client'

/**
 * Session detail → Transcript (design §10.1): read with in-page search, download, and — for the
 * host, co-hosts and organizers — "Add transcript" (paste or upload, consent required) and
 * "Remove". Shows the organizer-generated summary when there is one. Renders nothing for people
 * outside the members boundary, and nothing at all when there is no transcript and the viewer
 * cannot add one.
 */

import * as React from 'react'
import Link from 'next/link'
import { Download, FileText, MessageCircleQuestion, Search, Trash2, Upload } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { apiFetch } from '@/lib/api/client'
import { plural } from '@/lib/format'
import { MARKER_RE, MAX_TRANSCRIPT_BYTES } from '@/lib/knowledge/normalize'
import { cn } from '@/lib/utils'

interface TranscriptView {
  id: string
  format: string
  source: string
  char_count: number
  word_count: number
  language: string | null
  visibility: 'members' | 'organizers'
  summary: string | null
  summary_edited_at: string | null
  created_at: string
  text: string
}

interface TranscriptResponse {
  enabled: boolean
  visibility: 'members' | 'organizers'
  tier: 'members' | 'organizers' | null
  can_manage: boolean
  /** Organizers only: the summary is theirs to edit (design §10.3). */
  can_edit_summary?: boolean
  transcript: TranscriptView | null
  restricted?: boolean
}

interface TranscriptPanelProps {
  sessionId: string
  eventSlug: string
  sessionTitle: string
  /** Host, co-host or organizer. The server decides again. */
  canManage: boolean
}

const CONSENT_LABEL = 'Everyone in the room was told the session was being recorded or transcribed.'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'))
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="rounded bg-favorite/30 px-0.5 text-foreground">{part}</mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  )
}

function Paragraph({ text, query }: { text: string; query: string }) {
  const m = MARKER_RE.exec(text)
  const marker = m && m.index === 0 ? m[0] : null
  const body = marker ? text.slice(marker.length).trimStart() : text
  return (
    <p className="text-sm leading-relaxed">
      {marker && <span className="mr-2 font-mono text-xs text-muted-foreground">{marker.slice(1, -1)}</span>}
      <Highlight text={body} query={query} />
    </p>
  )
}

export function TranscriptPanel({ sessionId, eventSlug, sessionTitle, canManage }: TranscriptPanelProps) {
  const { toast } = useToast()
  const [data, setData] = React.useState<TranscriptResponse | null>(null)
  const [hidden, setHidden] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [confirmRemove, setConfirmRemove] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)
  const [summaryDraft, setSummaryDraft] = React.useState<string | null>(null)
  const [savingSummary, setSavingSummary] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setData(await apiFetch<TranscriptResponse>(`/api/v1/sessions/${sessionId}/transcript`))
      setHidden(false)
    } catch {
      // 401 / 403 (outside the members boundary) or any failure: the panel stays out of the page.
      setHidden(true)
    }
  }, [sessionId])

  React.useEffect(() => {
    void load()
  }, [load])

  const paragraphs = React.useMemo(() => (data?.transcript ? data.transcript.text.split(/\n\n+/).filter(Boolean) : []), [data?.transcript])
  const trimmed = query.trim()
  const visible = React.useMemo(
    () => (trimmed ? paragraphs.filter((p) => p.toLowerCase().includes(trimmed.toLowerCase())) : paragraphs),
    [paragraphs, trimmed],
  )

  if (hidden || !data) return null
  const manage = canManage && data.can_manage
  if (!data.transcript && (!manage || !data.enabled)) return null

  /** Organizers edit what the model wrote (design §10.3); members then read the edit. */
  const saveSummary = async (text: string) => {
    setSavingSummary(true)
    try {
      await apiFetch(`/api/v1/sessions/${sessionId}/transcript`, { method: 'PATCH', json: { summary: text.trim() ? text : null } })
      toast({ title: text.trim() ? 'Summary saved' : 'Summary cleared', variant: 'success' })
      setSummaryDraft(null)
      await load()
    } catch (e) {
      toast({ title: 'That did not save', description: e instanceof Error ? e.message : undefined, variant: 'destructive' })
    } finally {
      setSavingSummary(false)
    }
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await apiFetch(`/api/v1/sessions/${sessionId}/transcript`, { method: 'DELETE' })
      toast({ title: 'Transcript removed', variant: 'success' })
      setConfirmRemove(false)
      await load()
    } catch (e) {
      toast({ title: 'Could not remove the transcript', description: e instanceof Error ? e.message : undefined, variant: 'destructive' })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Card id="transcript" className="scroll-mt-24">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FileText className="h-5 w-5 text-muted-foreground" aria-hidden />
            Transcript
          </CardTitle>
          {data.transcript && (
            <p className="mt-1 text-xs text-muted-foreground">
              {plural(data.transcript.word_count, 'word')} · {data.transcript.format.toUpperCase()}
              {data.transcript.visibility === 'organizers' ? ' · organizers only' : ' · members only'}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {data.transcript && (
            <Button asChild variant="outline" size="sm">
              <a href={`/api/v1/sessions/${sessionId}/transcript?download=1`}>
                <Download className="mr-1.5 h-4 w-4" aria-hidden />
                Download
              </a>
            </Button>
          )}
          {manage && data.enabled && (
            <Button variant={data.transcript ? 'outline' : 'default'} size="sm" onClick={() => setDialogOpen(true)}>
              <Upload className="mr-1.5 h-4 w-4" aria-hidden />
              {data.transcript ? 'Replace' : 'Add transcript'}
            </Button>
          )}
          {manage && data.transcript && !confirmRemove && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
              <Trash2 className="mr-1.5 h-4 w-4" aria-hidden />
              Remove
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {confirmRemove && (
          <ConfirmInline
            destructive
            confirmLabel="Remove transcript"
            loading={removing}
            onConfirm={remove}
            onCancel={() => setConfirmRemove(false)}
            message="Remove this transcript and its search index? People will no longer be able to read or ask about it."
          />
        )}
        {data.restricted && !data.transcript && (
          <p className="text-sm text-muted-foreground">A transcript exists for this session, but organizers have kept it to themselves.</p>
        )}
        {!data.transcript && manage && (
          <p className="text-sm text-muted-foreground">
            No transcript yet. Add one so members can search and revisit what was said. It stays inside this gathering — it is never published.
          </p>
        )}
        {(data.transcript?.summary || (data.can_edit_summary && data.transcript)) && (
          <section className="rounded-xl border bg-muted/40 p-4" aria-labelledby={`summary-${sessionId}`}>
            <h3 id={`summary-${sessionId}`} className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold">
              Summary <Badge variant="muted">{data.transcript?.summary_edited_at ? 'Edited by an organizer' : 'Generated'}</Badge>
            </h3>
            {summaryDraft !== null ? (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void saveSummary(summaryDraft)
                }}
              >
                <Label htmlFor={`summary-edit-${sessionId}`} className="sr-only">Session summary</Label>
                <Textarea id={`summary-edit-${sessionId}`} rows={10} maxLength={8000} value={summaryDraft} onChange={(e) => setSummaryDraft(e.target.value)} />
                <p className="text-xs text-muted-foreground">Members read this. Saving an empty summary clears it.</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" loading={savingSummary}>Save summary</Button>
                  <Button type="button" size="sm" variant="outline" disabled={savingSummary} onClick={() => setSummaryDraft(null)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <>
                <div className="space-y-2 whitespace-pre-wrap text-sm leading-relaxed">
                  {data.transcript?.summary || <span className="text-muted-foreground">No summary yet. Generate one from the Knowledge page, or write one here.</span>}
                </div>
                {data.can_edit_summary && (
                  <Button className="mt-3" size="sm" variant="outline" onClick={() => setSummaryDraft(data.transcript?.summary ?? '')}>
                    Edit summary
                  </Button>
                )}
              </>
            )}
          </section>
        )}
        {data.transcript && (
          <>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search in this transcript"
                  aria-label="Search in this transcript"
                  className="pl-9"
                />
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={`/e/${eventSlug}/ask`}>
                  <MessageCircleQuestion className="mr-1.5 h-4 w-4" aria-hidden />
                  Ask the gathering
                </Link>
              </Button>
            </div>
            {trimmed && (
              <p className="text-xs text-muted-foreground" role="status">
                {visible.length ? `${plural(visible.length, 'paragraph')} of ${paragraphs.length} match` : 'No paragraph matches.'}
              </p>
            )}
            <div className={cn('max-h-[32rem] space-y-3 overflow-y-auto rounded-xl border p-4', !visible.length && 'hidden')}>
              {visible.map((p, i) => (
                <Paragraph key={i} text={p} query={trimmed} />
              ))}
            </div>
          </>
        )}
      </CardContent>
      {manage && (
        <AddTranscriptDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          sessionId={sessionId}
          sessionTitle={sessionTitle}
          replacing={!!data.transcript}
          eventVisibility={data.visibility}
          onSaved={async () => {
            setDialogOpen(false)
            toast({ title: data.transcript ? 'Transcript replaced' : 'Transcript added', variant: 'success' })
            await load()
          }}
        />
      )}
    </Card>
  )
}

interface AddTranscriptDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string
  sessionTitle: string
  replacing: boolean
  eventVisibility: 'members' | 'organizers'
  onSaved: () => void | Promise<void>
}

type Mode = 'paste' | 'upload'

function AddTranscriptDialog({ open, onOpenChange, sessionId, sessionTitle, replacing, eventVisibility, onSaved }: AddTranscriptDialogProps) {
  const [mode, setMode] = React.useState<Mode>('paste')
  const [text, setText] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [consent, setConsent] = React.useState(false)
  const [language, setLanguage] = React.useState('')
  const [organizersOnly, setOrganizersOnly] = React.useState(eventVisibility === 'organizers')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setError(null)
    setSaving(false)
  }, [open])

  const ready = consent && (mode === 'paste' ? text.trim().length > 0 : !!file)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setSaving(true)
    setError(null)
    try {
      const visibility = organizersOnly || eventVisibility === 'organizers' ? 'organizers' : 'members'
      if (mode === 'upload' && file) {
        if (file.size > MAX_TRANSCRIPT_BYTES) throw new Error('Transcripts are limited to 5 MB.')
        const body = new FormData()
        body.append('file', file)
        body.append('consent', 'true')
        body.append('visibility', visibility)
        if (language.trim()) body.append('language', language.trim())
        await apiFetch(`/api/v1/sessions/${sessionId}/transcript`, { method: 'POST', body })
      } else {
        await apiFetch(`/api/v1/sessions/${sessionId}/transcript`, {
          method: 'POST',
          json: { text, consent: true, visibility, language: language.trim() || undefined },
        })
      }
      setText('')
      setFile(null)
      setConsent(false)
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the transcript.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <form onSubmit={submit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>{replacing ? 'Replace the transcript' : 'Add a transcript'}</DialogTitle>
            <DialogDescription>
              For “{sessionTitle}”. Plain text, Markdown, WebVTT or SRT, up to 5 MB. Caption timings become <span className="font-mono">[mm:ss]</span> markers. Members of this gathering can read it; it is never published.
            </DialogDescription>
          </DialogHeader>

          <SegmentedControl<Mode>
            value={mode}
            onValueChange={setMode}
            options={[
              { value: 'paste', label: 'Paste text' },
              { value: 'upload', label: 'Upload a file' },
            ]}
            aria-label="How to add the transcript"
            fullWidth
          />

          {mode === 'paste' ? (
            <div className="space-y-2">
              <Label htmlFor={`transcript-text-${sessionId}`}>Transcript</Label>
              <Textarea
                id={`transcript-text-${sessionId}`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                placeholder="Paste the transcript here. Blank lines separate paragraphs; a leading [12:30] keeps a moment."
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={`transcript-file-${sessionId}`}>Transcript file</Label>
              <Input
                id={`transcript-file-${sessionId}`}
                type="file"
                accept=".txt,.md,.vtt,.srt,text/plain,text/markdown,text/vtt"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file && <p className="text-xs text-muted-foreground">{file.name} · {Math.max(1, Math.round(file.size / 1024))} KB</p>}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`transcript-language-${sessionId}`}>Language (optional)</Label>
              <Input
                id={`transcript-language-${sessionId}`}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                placeholder="en, es, pt-BR…"
                maxLength={12}
              />
            </div>
            {eventVisibility === 'members' && (
              <label className="flex cursor-pointer items-start gap-2 pt-7 text-sm">
                <Checkbox checked={organizersOnly} onCheckedChange={(v) => setOrganizersOnly(v === true)} aria-label="Organizers only" className="mt-0.5" />
                <span>
                  Organizers only
                  <span className="block text-xs text-muted-foreground">Keep this transcript from other members.</span>
                </span>
              </label>
            )}
          </div>

          <label className="flex cursor-pointer items-start gap-2 rounded-xl border p-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5">
            <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} aria-label={CONSENT_LABEL} className="mt-0.5" required />
            <span>
              {CONSENT_LABEL}
              <span className="block text-xs text-muted-foreground">
                If the organizers turn on search and answers, the text is sent to their configured AI provider for indexing. It never leaves the members boundary otherwise.
              </span>
            </span>
          </label>

          {error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={saving} disabled={!ready}>{replacing ? 'Replace transcript' : 'Add transcript'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
