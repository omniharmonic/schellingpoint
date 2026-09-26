'use client'

/**
 * "Your AI assistant" (design 2026-09-25 §2.3a): the MCP server URL, a token minted inline, and
 * the link to `/help/assistants`. The same card appears on the gathering dashboard and on the Ask
 * page, because the feature existed and nobody could find it (fact-finding: "linked from exactly
 * one place").
 *
 * A thin wrapper over the same route Account → Identity uses (`/api/me/assistant-tokens`): the
 * token is the member acting through a machine, it is shown once, and only a fingerprint is kept.
 */

import * as React from 'react'
import Link from 'next/link'
import { Bot, Check, Copy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { WarningBox } from '@/components/WarningBox'
import { apiFetch } from '@/lib/api/client'
import { HELP_PRIVACY, LEARN_MORE } from '@/lib/labels'
import { cn } from '@/lib/utils'

interface AssistantToken {
  id: string
  name: string
  created_at: string
  last_used_at: string | null
}

export function AssistantCard({ className, gatheringName }: { className?: string; gatheringName?: string }) {
  const id = React.useId()
  const [mcpUrl, setMcpUrl] = React.useState('/api/mcp')
  const [tokens, setTokens] = React.useState<AssistantToken[] | null>(null)
  const [limit, setLimit] = React.useState(5)
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [secret, setSecret] = React.useState<string | null>(null)
  const [copied, setCopied] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    apiFetch<{ tokens: AssistantToken[]; limit: number; mcp_url: string }>('/api/me/assistant-tokens', { cache: 'no-store' })
      .then((res) => {
        if (cancelled) return
        setTokens(res.tokens)
        setLimit(res.limit)
        setMcpUrl(res.mcp_url)
      })
      .catch((e) => {
        if (!cancelled) {
          setTokens([])
          setError(e instanceof Error ? e.message : 'Could not load your connected assistants')
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(what)
      window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 2000)
    } catch {
      setError('Could not copy — select the text and copy it by hand.')
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch<{ token: string; assistant_token: AssistantToken }>('/api/me/assistant-tokens', { method: 'POST', json: { name: trimmed } })
      setSecret(res.token)
      setName('')
      setTokens((list) => [res.assistant_token, ...(list ?? [])])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a token')
    } finally {
      setBusy(false)
    }
  }

  const full = (tokens?.length ?? 0) >= limit

  return (
    <Card className={className} data-testid="assistant-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Bot className="h-5 w-5 text-muted-foreground" aria-hidden />
          Your AI assistant
        </CardTitle>
        <CardDescription>
          Ask Claude, ChatGPT or Cursor what is on at {gatheringName || 'your gatherings'}, who is hosting what, or what
          was said in a session you missed. It sees what you see, and can change nothing.{' '}
          <Link href="/help/assistants" className="underline">How to connect one</Link>
          {' · '}
          <Link href={HELP_PRIVACY.assistants} className="underline">{LEARN_MORE}</Link>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">Server URL</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all font-mono text-xs" data-testid="assistant-card-url">{mcpUrl}</code>
            <Button type="button" variant="ghost" size="sm" onClick={() => copy(mcpUrl, 'url')} aria-label="Copy the server URL">
              {copied === 'url' ? <Check className="h-4 w-4" aria-hidden /> : <Copy className="h-4 w-4" aria-hidden />}
            </Button>
          </div>
        </div>

        {secret && (
          <WarningBox title="Copy this token now — it is shown once">
            <p className="text-xs text-muted-foreground">
              Paste it into your assistant as the bearer token for the server URL above. It cannot be shown twice.
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-background px-2 py-1 font-mono text-xs" data-testid="assistant-card-secret">{secret}</code>
              <Button type="button" variant="outline" size="sm" onClick={() => copy(secret, 'secret')}>
                {copied === 'secret' ? <Check className="mr-1 h-4 w-4" aria-hidden /> : <Copy className="mr-1 h-4 w-4" aria-hidden />}
                Copy
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setSecret(null)}>I have saved it</Button>
          </WarningBox>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor={`${id}-name`} className="text-xs text-muted-foreground">Name this assistant</label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy && name.trim() && !full) {
                  e.preventDefault()
                  void create()
                }
              }}
              placeholder="Claude on my laptop"
              maxLength={60}
              disabled={busy || full}
            />
          </div>
          <Button type="button" onClick={() => void create()} loading={busy} disabled={!name.trim() || full}>Create token</Button>
        </div>

        {tokens === null ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />Loading your assistants…
          </p>
        ) : tokens.length === 0 ? (
          <p className="text-xs text-muted-foreground">No assistant is connected yet.</p>
        ) : (
          <p className={cn('text-xs text-muted-foreground')}>
            {tokens.length} of {limit} connected. Manage or revoke them in{' '}
            <Link href="/account?tab=identity" className="underline">Account → Identity</Link>.
          </p>
        )}
        {full && <p className="text-xs text-muted-foreground">You are at the limit. Revoke one in Account → Identity to add another.</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}
