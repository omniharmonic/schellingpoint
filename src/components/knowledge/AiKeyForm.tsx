'use client'

/**
 * The gathering's own answer-model key (design 2026-09-25 §2.1), inside the Knowledge page's
 * "Answers" card. Owners and admins set, replace, test or remove it.
 *
 * What the copy must say, and does: the key is encrypted on this server, used only for this
 * gathering, and never shown again — only its last four characters come back. When the operator
 * has not configured secret storage (`APP_SECRETS_KEY`), the form says so instead of failing.
 */

import * as React from 'react'
import { CheckCircle2, KeyRound, Loader2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { ConfirmInline } from '@/components/ui/confirm-inline'
import { useToast } from '@/components/ui/toast'
import { apiFetch, ApiError } from '@/lib/api/client'

type Provider = 'anthropic' | 'openai-compatible'

interface Settings {
  provider: Provider
  base_url: string | null
  model: string | null
  last4: string
  set_at: string
}

interface KeyState {
  secrets_configured: boolean
  settings: Settings | null
  deployment: { configured: boolean; model?: string }
  anthropic_models: Array<{ id: string; label: string }>
  default_model: string
}

export function AiKeyForm({ eventSlug, onChanged }: { eventSlug: string; onChanged?: () => void }) {
  const { toast } = useToast()
  const base = `/api/v1/events/${eventSlug}/admin/ai-key`
  const [state, setState] = React.useState<KeyState | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [editing, setEditing] = React.useState(false)
  const [provider, setProvider] = React.useState<Provider>('anthropic')
  const [model, setModel] = React.useState('')
  const [baseUrl, setBaseUrl] = React.useState('')
  const [key, setKey] = React.useState('')
  const [busy, setBusy] = React.useState<'save' | 'test' | 'remove' | null>(null)
  const [fieldError, setFieldError] = React.useState<{ field?: string; message: string } | null>(null)
  const [testResult, setTestResult] = React.useState<{ ok: boolean; detail: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      const data = await apiFetch<KeyState>(base, { cache: 'no-store' })
      setState(data)
      setLoadError(null)
      setProvider(data.settings?.provider ?? 'anthropic')
      setModel(data.settings?.model ?? data.default_model)
      setBaseUrl(data.settings?.base_url ?? '')
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not read the answer settings.')
    }
  }, [base])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loadError) return <p className="text-sm text-destructive" role="alert">{loadError}</p>
  if (!state) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />Reading the answer settings…
      </p>
    )
  }

  if (!state.secrets_configured) {
    return (
      <div className="rounded-xl border border-signal-amber/40 bg-signal-amber/10 p-4 text-sm" data-testid="ai-key-secrets-missing">
        <p className="font-medium">This gathering cannot hold its own key yet</p>
        <p className="mt-1 text-muted-foreground">
          The operator has not set up secret storage (<code className="font-mono text-xs">APP_SECRETS_KEY</code>). Answers
          still work if the server has its own key.
        </p>
      </div>
    )
  }

  const save = async () => {
    setBusy('save')
    setFieldError(null)
    setTestResult(null)
    try {
      await apiFetch(base, {
        method: 'PUT',
        json: { provider, key, model, base_url: provider === 'openai-compatible' ? baseUrl : undefined },
      })
      toast({ title: state.settings ? 'Key replaced' : 'Key saved', description: 'Encrypted on this server and used only for this gathering.', variant: 'success' })
      setKey('')
      setEditing(false)
      await load()
      onChanged?.()
    } catch (e) {
      const message = e instanceof Error ? e.message : 'That did not save.'
      setFieldError({ field: e instanceof ApiError ? e.field : undefined, message })
    } finally {
      setBusy(null)
    }
  }

  const test = async () => {
    setBusy('test')
    setTestResult(null)
    try {
      const body = editing && key.trim() ? { provider, key, model, base_url: provider === 'openai-compatible' ? baseUrl : undefined } : {}
      const res = await apiFetch<{ ok: boolean; detail: string }>(`${base}?action=test`, { method: 'POST', json: body })
      setTestResult({ ok: res.ok, detail: res.detail })
    } catch (e) {
      setTestResult({ ok: false, detail: e instanceof Error ? e.message : 'The test did not run.' })
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('remove')
    try {
      await apiFetch(base, { method: 'DELETE' })
      toast({
        title: 'Key removed',
        description: state.deployment.configured ? 'Answers fall back to the key this server is configured with.' : 'Answers are off again until a key is set.',
        variant: 'success',
      })
      setConfirmRemove(false)
      setTestResult(null)
      await load()
      onChanged?.()
    } catch (e) {
      toast({ title: 'That did not work', description: e instanceof Error ? e.message : undefined, variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const installed = state.settings

  return (
    <div className="space-y-3" data-testid="ai-key-form">
      {installed && !editing && (
        <dl className="space-y-1.5 text-sm">
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">This gathering’s key</dt>
            <dd className="text-right">
              <Badge variant="success">In use</Badge>{' '}
              <span className="font-mono text-xs">••••{installed.last4}</span>
            </dd>
          </div>
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Provider</dt>
            <dd className="text-right">
              {installed.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible'}
              {installed.model ? ` · ${installed.model}` : ''}
            </dd>
          </div>
          {installed.base_url && (
            <div className="flex items-start justify-between gap-3">
              <dt className="text-muted-foreground">Base URL</dt>
              <dd className="break-all text-right font-mono text-xs">{installed.base_url}</dd>
            </div>
          )}
          <div className="flex items-start justify-between gap-3">
            <dt className="text-muted-foreground">Set</dt>
            <dd className="text-right text-muted-foreground">{new Date(installed.set_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</dd>
          </div>
        </dl>
      )}

      {!editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant={installed ? 'outline' : 'default'} size="sm" onClick={() => { setEditing(true); setKey(''); setTestResult(null) }} data-testid="ai-key-edit">
            <KeyRound className="mr-1.5 h-4 w-4" aria-hidden />
            {installed ? 'Replace the key' : 'Use this gathering’s own key'}
          </Button>
          <Button type="button" variant="ghost" size="sm" loading={busy === 'test'} onClick={() => void test()}>Test connection</Button>
          {installed && !confirmRemove && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>Remove</Button>
          )}
        </div>
      ) : (
        <form
          className="space-y-3 rounded-xl border p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="ai-key-provider">Provider</Label>
            <Select
              id="ai-key-provider"
              value={provider}
              onChange={(e) => {
                const next = e.target.value as Provider
                setProvider(next)
                setModel(next === 'anthropic' ? state.default_model : '')
                setFieldError(null)
              }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai-compatible">OpenAI-compatible (OpenAI, OpenRouter, Together, your own server)</option>
            </Select>
          </div>

          {provider === 'anthropic' ? (
            <div className="space-y-1.5">
              <Label htmlFor="ai-key-model">Model</Label>
              <Select id="ai-key-model" value={model} onChange={(e) => setModel(e.target.value)} error={fieldError?.field === 'model'}>
                {state.anthropic_models.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </Select>
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="ai-key-base-url">Base URL</Label>
                <Input
                  id="ai-key-base-url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  maxLength={300}
                  error={fieldError?.field === 'base_url'}
                />
                <p className="text-xs text-muted-foreground">https only. Answers are requested at <code className="font-mono">/v1/chat/completions</code> under it.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ai-key-model-free">Model</Label>
                <Input
                  id="ai-key-model-free"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="gpt-4o-mini"
                  maxLength={100}
                  error={fieldError?.field === 'model'}
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ai-key-secret">API key</Label>
            <Input
              id="ai-key-secret"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={installed ? `Replaces the key ending ${installed.last4}` : 'sk-…'}
              maxLength={500}
              error={fieldError?.field === 'key'}
              data-testid="ai-key-secret"
            />
            <p className="text-xs text-muted-foreground">
              Encrypted here, used only for this gathering, and shown to nobody again. Questions and the excerpts that
              answer them go to this provider.
            </p>
          </div>

          {fieldError && <p className="text-sm text-destructive" role="alert">{fieldError.message}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" loading={busy === 'save'} disabled={key.trim().length < 8}>Save key</Button>
            <Button type="button" variant="outline" size="sm" loading={busy === 'test'} disabled={key.trim().length < 8} onClick={() => void test()}>Test connection</Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setEditing(false); setKey(''); setFieldError(null) }}>Cancel</Button>
          </div>
        </form>
      )}

      {confirmRemove && (
        <ConfirmInline
          message={
            state.deployment.configured
              ? 'Remove this gathering’s key? Answers fall back to the key this server is configured with.'
              : 'Remove this gathering’s key? Answers and generated summaries stop working for this gathering.'
          }
          confirmLabel="Remove the key"
          destructive
          loading={busy === 'remove'}
          onConfirm={() => void remove()}
          onCancel={() => setConfirmRemove(false)}
        />
      )}

      {testResult && (
        <p className={`flex items-start gap-1.5 text-sm ${testResult.ok ? 'text-success' : 'text-destructive'}`} role="status" data-testid="ai-key-test-result">
          {testResult.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          {testResult.detail}
        </p>
      )}

      {!installed && state.deployment.configured && (
        <p className="text-xs text-muted-foreground">
          Until you add one, answers use the key this server is configured with ({state.deployment.model}).
        </p>
      )}
      {!installed && !state.deployment.configured && (
        <p className="text-xs text-muted-foreground">This server has no key of its own, so answers stay off until you add one here.</p>
      )}
    </div>
  )
}
