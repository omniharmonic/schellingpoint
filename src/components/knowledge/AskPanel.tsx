'use client'

/**
 * "Ask the gathering" (design §10.3): a question, a streamed answer with citations
 * `[Session title · mm:ss]`, and the sources it was built on, each linking to the session's
 * transcript. Nothing is stored; the conversation lives in this component's state.
 */

import * as React from 'react'
import Link from 'next/link'
import { MessageCircleQuestion, Send, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent } from '@/components/ui/card'
import { apiFetch, ApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils'

export interface AskSource {
  n: number
  chunk_id: string
  session_id: string
  title: string
  marker: string | null
  label: string
  score: number
  excerpt: string
  href: string
}

interface Availability {
  available: boolean
  reason: 'chat' | 'embeddings' | 'no-transcripts' | 'no-embeddings' | null
  ready_transcripts: number
  embedded_chunks: number
}

interface Exchange {
  id: number
  question: string
  answer: string
  sources: AskSource[]
  notice: string | null
  error: string | null
  done: boolean
}

interface AskPanelProps {
  eventSlug: string
  /** Organizer copy names the missing configuration; member copy stays generic. */
  variant?: 'member' | 'organizer'
  className?: string
}

const MEMBER_REASON: Record<NonNullable<Availability['reason']>, string> = {
  chat: 'Ask the gathering is not available on this server yet.',
  embeddings: 'Ask the gathering is not available on this server yet.',
  'no-transcripts': 'It becomes available once hosts add transcripts to their sessions.',
  'no-embeddings': 'Transcripts are being indexed. Check back shortly.',
}

const ORGANIZER_REASON: Record<NonNullable<Availability['reason']>, string> = {
  chat: 'No answer model is configured (ANTHROPIC_API_KEY). Members see “not available yet”.',
  embeddings: 'No embeddings provider is configured (EMBEDDINGS_PROVIDER, EMBEDDINGS_MODEL, EMBEDDINGS_API_KEY). Members see “not available yet”.',
  'no-transcripts': 'No session has a transcript yet. Request transcripts from hosts, or add them from the session pages.',
  'no-embeddings': 'Transcripts exist but are not indexed yet. Use “Embed now”, or wait for the queued job.',
}

/** Render `[Session title · 12:30]` citations as subtle chips inside the answer text. */
function AnswerText({ text }: { text: string }) {
  const parts = text.split(/(\[[^\[\]\n]{3,160}\])/g)
  return (
    <>
      {parts.map((part, i) =>
        /^\[[^\[\]\n]+\]$/.test(part) ? (
          <span key={i} className="mx-0.5 inline-block rounded-md bg-primary/10 px-1.5 py-0.5 align-baseline font-mono text-[0.75em] text-primary">
            {part.slice(1, -1)}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  )
}

async function readSse(res: Response, onEvent: (event: string, data: unknown) => void): Promise<void> {
  if (!res.body) return
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      let event = 'message'
      const dataLines: string[] = []
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
      }
      if (!dataLines.length) continue
      try {
        onEvent(event, JSON.parse(dataLines.join('')))
      } catch {
        // a malformed frame is dropped, the stream continues
      }
    }
  }
}

export function AskPanel({ eventSlug, variant = 'member', className }: AskPanelProps) {
  const [availability, setAvailability] = React.useState<Availability | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [question, setQuestion] = React.useState('')
  const [exchanges, setExchanges] = React.useState<Exchange[]>([])
  const [busy, setBusy] = React.useState(false)
  const counter = React.useRef(0)

  React.useEffect(() => {
    let cancelled = false
    apiFetch<Availability>(`/api/v1/events/${eventSlug}/knowledge/ask`)
      .then((a) => { if (!cancelled) setAvailability(a) })
      .catch((e) => { if (!cancelled) setLoadError(e instanceof ApiError && e.status === 401 ? 'Sign in to ask the gathering.' : e instanceof Error ? e.message : 'Could not load.') })
    return () => { cancelled = true }
  }, [eventSlug])

  const update = (id: number, patch: Partial<Exchange> | ((prev: Exchange) => Partial<Exchange>)) =>
    setExchanges((list) => list.map((x) => (x.id === id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)))

  const ask = async (e: React.FormEvent) => {
    e.preventDefault()
    const q = question.trim()
    if (q.length < 3 || busy) return
    const id = ++counter.current
    setExchanges((list) => [...list, { id, question: q, answer: '', sources: [], notice: null, error: null, done: false }])
    setQuestion('')
    setBusy(true)
    try {
      const res = await fetch(`/api/v1/events/${eventSlug}/knowledge/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ question: q }),
        credentials: 'same-origin',
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        update(id, { error: body.error || `Could not ask (${res.status}).`, done: true })
        return
      }
      await readSse(res, (event, data) => {
        const d = data as Record<string, unknown>
        if (event === 'sources') update(id, { sources: Array.isArray(data) ? (data as AskSource[]) : [] })
        else if (event === 'notice') update(id, { notice: String(d.message ?? ''), done: true })
        else if (event === 'delta') update(id, (prev) => ({ answer: prev.answer + String(d.text ?? '') }))
        else if (event === 'error') update(id, { error: String(d.error ?? 'Something went wrong.'), done: true })
        else if (event === 'done') update(id, { done: true })
      })
      update(id, { done: true })
    } catch (err) {
      update(id, { error: err instanceof Error ? err.message : 'Could not reach the server.', done: true })
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return <p className={cn('text-sm text-muted-foreground', className)}>{loadError}</p>
  }
  if (!availability) {
    return <p className={cn('text-sm text-muted-foreground', className)} role="status">Checking what is available…</p>
  }
  if (!availability.available) {
    const reason = availability.reason ?? 'chat'
    return (
      <Card className={className}>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <MessageCircleQuestion className="h-8 w-8 text-muted-foreground" aria-hidden />
          <p className="font-medium">Ask the gathering is not ready</p>
          <p className="max-w-md text-sm text-muted-foreground">{variant === 'organizer' ? ORGANIZER_REASON[reason] : MEMBER_REASON[reason]}</p>
          {variant === 'member' && availability.ready_transcripts > 0 && (
            <p className="text-xs text-muted-foreground">Session pages already show the transcripts that exist.</p>
          )}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className={cn('space-y-5', className)}>
      <form onSubmit={ask} className="space-y-3">
        <label htmlFor={`ask-${eventSlug}`} className="sr-only">Your question</label>
        <Textarea
          id={`ask-${eventSlug}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit() } }}
          rows={3}
          maxLength={1000}
          placeholder="What was said about…? Which sessions discussed…?"
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Answers come only from this gathering’s transcripts and cite the session and moment. Nothing you ask is stored.</p>
          <Button type="submit" loading={busy} disabled={question.trim().length < 3}>
            <Send className="mr-1.5 h-4 w-4" aria-hidden />
            Ask
          </Button>
        </div>
      </form>

      <div className="space-y-4" aria-live="polite">
        {exchanges.map((x) => (
          <Card key={x.id}>
            <CardContent className="space-y-4 pt-6">
              <p className="font-medium">{x.question}</p>
              {x.error ? (
                <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{x.error}</p>
              ) : x.notice ? (
                <p className="text-sm text-muted-foreground">{x.notice}</p>
              ) : (
                <div className="space-y-2 whitespace-pre-wrap text-sm leading-relaxed">
                  {x.answer ? <AnswerText text={x.answer} /> : <span className="inline-flex items-center gap-2 text-muted-foreground"><Sparkles className="h-4 w-4 animate-pulse" aria-hidden />Reading the transcripts…</span>}
                </div>
              )}
              {x.sources.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sources</p>
                  <ol className="space-y-2">
                    {x.sources.map((s) => (
                      <li key={s.chunk_id} className="rounded-lg border p-3 text-sm">
                        <Link href={s.href} className="font-medium hover:underline">
                          {s.label}
                        </Link>
                        <p className="mt-1 text-xs text-muted-foreground">{s.excerpt}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
