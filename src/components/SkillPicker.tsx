'use client'

/**
 * SkillPicker — choose up to five skills from the shared taxonomy (the Free School skills
 * authority's `freeschool.draft.skill` records, spec §4.1, §10). Controlled; stores AT-URIs.
 *
 * For package B (proposal form) and D (track editor):
 *
 *   <SkillPicker value={skillUris} onChange={setSkillUris} />
 *   <SkillPicker value={track.skill_uris} onChange={...} max={20} label="Track skills" />
 *
 * Props
 *   value       string[]                   selected skill AT-URIs (at://…/freeschool.draft.skill/<slug>)
 *   onChange    (uris: string[]) => void   called with the new selection
 *   max?        number                     default 5 (a proposal's limit); tracks may pass up to 20
 *   label?      string                     visible label, default "Skills"
 *   description? string                    helper text under the label
 *   disabled?   boolean
 *   id?         string                     id for the search input (label association)
 *
 * The server validates again (`validateSkillUris` in `src/lib/atproto/skills.ts`): never trust
 * the picker's limit alone. Search hits GET /api/atproto/skills?q=; chips for an existing value
 * resolve through GET /api/atproto/skills?uris=.
 */
import * as React from 'react'
import { Loader2, Search, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api/client'

export interface SkillOption {
  uri: string
  id: string
  label: string
  description: string | null
  status: string
}

export interface SkillPickerProps {
  value: string[]
  onChange: (uris: string[]) => void
  max?: number
  label?: string
  description?: string
  disabled?: boolean
  id?: string
}

interface SkillsResponse {
  skills: SkillOption[]
}

export function SkillPicker({ value, onChange, max = 5, label = 'Skills', description, disabled = false, id }: SkillPickerProps) {
  const generatedId = React.useId()
  const inputId = id ?? `skill-picker-${generatedId}`
  const listId = `${inputId}-results`
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<SkillOption[]>([])
  const [known, setKnown] = React.useState<Record<string, SkillOption>>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [active, setActive] = React.useState(-1)
  const limit = Math.max(1, Math.min(max, 20))
  const full = value.length >= limit

  // Resolve labels for URIs we have not seen (an existing proposal being edited).
  React.useEffect(() => {
    const missing = value.filter((u) => !known[u])
    if (!missing.length) return
    let cancelled = false
    apiFetch<SkillsResponse>(`/api/atproto/skills?uris=${missing.map(encodeURIComponent).join(',')}`)
      .then((r) => {
        if (cancelled) return
        setKnown((prev) => ({ ...prev, ...Object.fromEntries(r.skills.map((s) => [s.uri, s])) }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [value, known])

  // Debounced search.
  React.useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      apiFetch<SkillsResponse>(`/api/atproto/skills?q=${encodeURIComponent(q)}&limit=12`, { signal: controller.signal })
        .then((r) => {
          setResults(r.skills)
          setKnown((prev) => ({ ...prev, ...Object.fromEntries(r.skills.map((s) => [s.uri, s])) }))
          setError(null)
          setActive(-1)
        })
        .catch((e) => {
          if ((e as { name?: string }).name !== 'AbortError') setError('Skills could not be loaded right now.')
        })
        .finally(() => setLoading(false))
    }, 200)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const add = (skill: SkillOption) => {
    if (disabled || full || value.includes(skill.uri)) return
    onChange([...value, skill.uri])
    setQuery('')
    setResults([])
  }

  const remove = (uri: string) => {
    if (disabled) return
    onChange(value.filter((u) => u !== uri))
  }

  const options = results.filter((r) => !value.includes(r.uri))

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!options.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1))
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault()
      add(options[active]!)
    } else if (e.key === 'Escape') {
      setResults([])
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {value.length}/{limit}
        </span>
      </div>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}

      {value.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected skills">
          {value.map((uri) => (
            <li key={uri}>
              <Badge variant="secondary" className="gap-1 pr-1">
                <span>{known[uri]?.label ?? uri.slice(uri.lastIndexOf('/') + 1).replace(/-/g, ' ')}</span>
                <button
                  type="button"
                  onClick={() => remove(uri)}
                  disabled={disabled}
                  className="rounded-sm p-0.5 hover:bg-background/60 disabled:opacity-50"
                  aria-label={`Remove ${known[uri]?.label ?? 'skill'}`}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
        <Input
          id={inputId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled || full}
          placeholder={full ? `You can choose up to ${limit}` : 'Search skills, e.g. permaculture'}
          className="pl-8"
          role="combobox"
          aria-expanded={options.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && options[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
        />
        {loading ? <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-foreground" aria-hidden /> : null}
        {options.length ? (
          <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover p-1 shadow-md">
            {options.map((s, i) => (
              <li
                key={s.uri}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault()
                  add(s)
                }}
                className={`cursor-pointer rounded-sm px-2 py-1.5 text-sm ${i === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{s.label}</span>
                  {s.status === 'proposed' ? <span className="text-[10px] uppercase tracking-wide text-muted-foreground">proposed</span> : null}
                </div>
                {s.description ? <p className="line-clamp-1 text-xs text-muted-foreground">{s.description}</p> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export default SkillPicker
