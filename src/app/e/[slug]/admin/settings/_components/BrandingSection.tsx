'use client'

import * as React from 'react'
import { Check, Plus, Trash2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ColorPicker } from '@/components/ui/color-picker'
import { cn } from '@/lib/utils'
import type { Event } from '@/types/event'
import { SectionCard, SaveBar, ChoiceCard } from './SectionCard'
import { useSectionSave, sameValue, socialToLinks, linksToSocial, type SocialLink } from './shared'
import { THEME_MODES, DEFAULT_COLORS, THEME_PRESETS, matchingThemePreset, contrastingTextColor, type ThemePreset } from './constants'
import { MAX_SOCIAL_LINKS, SOCIAL_LABEL_MAX, SOCIAL_URL_MAX } from './labels'

/** Colors, appearance and links. Images have their own card (`ImagesSection`) because they save on upload. */
export function BrandingSection({ event }: { event: Event }) {
  const theme = event.theme || {}
  const { state, save } = useSectionSave(event.id)
  const [primary, setPrimary] = React.useState(theme.colors?.primary || DEFAULT_COLORS.primary)
  const [secondary, setSecondary] = React.useState(theme.colors?.secondary || DEFAULT_COLORS.secondary)
  const [accent, setAccent] = React.useState(theme.colors?.accent || DEFAULT_COLORS.accent)
  const [mode, setMode] = React.useState<'light' | 'dark' | 'system'>(theme.mode || 'light')
  const [links, setLinks] = React.useState<SocialLink[]>(() => socialToLinks(theme.social))
  const fieldError = (field: string) => (state.status === 'error' && state.field === field ? state.message : null)

  const patch = { theme: { colors: { primary, secondary, accent }, mode, social: linksToSocial(links) } }
  const dirty = !sameValue(patch, { theme: {
    colors: { primary: theme.colors?.primary || DEFAULT_COLORS.primary, secondary: theme.colors?.secondary || DEFAULT_COLORS.secondary, accent: theme.colors?.accent || DEFAULT_COLORS.accent },
    mode: theme.mode || 'light', social: linksToSocial(socialToLinks(theme.social)),
  } })

  const applyPreset = (preset: ThemePreset) => {
    setPrimary(preset.primary); setSecondary(preset.secondary); setAccent(preset.accent)
    setMode(preset.mode)
  }
  const selectedPreset = matchingThemePreset({ primary, secondary, accent })
  const updateLink = (index: number, field: keyof SocialLink, value: string) => setLinks(prev => prev.map((link, i) => i === index ? { ...link, [field]: value } : link))
  const removeLink = (index: number) => setLinks(prev => prev.filter((_, i) => i !== index))
  const addLink = () => setLinks(prev => prev.length < MAX_SOCIAL_LINKS ? [...prev, { label: '', url: '' }] : prev)

  const swatches = [{ label: 'Primary', color: primary }, { label: 'Secondary', color: secondary }, { label: 'Accent', color: accent }]

  return <SectionCard id="branding" title="Branding" description="Colors, appearance and links for the gathering’s pages."
    onSubmit={() => save(patch, 'Branding saved.')}
    footer={<SaveBar state={state} dirty={dirty} />}>
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Palette</legend>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {THEME_PRESETS.map(preset => {
          const selected = selectedPreset?.name === preset.name
          return <button key={preset.name} type="button" aria-pressed={selected} onClick={() => applyPreset(preset)} title={preset.description}
            className={cn('flex flex-col gap-2 rounded-lg border-2 p-3 text-left transition-all hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2', selected ? 'border-primary bg-primary/5' : 'border-border')}>
            <span className="flex gap-1" aria-hidden="true">
              <span className="h-5 w-5 rounded-full border border-black/10" style={{ backgroundColor: preset.primary }} />
              <span className="h-5 w-5 rounded-full border border-black/10" style={{ backgroundColor: preset.secondary }} />
              <span className="h-5 w-5 rounded-full border border-black/10" style={{ backgroundColor: preset.accent }} />
            </span>
            <span className="flex items-center gap-1 text-sm font-medium">{preset.name}{selected ? <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> : null}</span>
            <span className="text-xs text-muted-foreground">{preset.mode === 'dark' ? 'Dark' : 'Light'}</span>
          </button>
        })}
      </div>
      <p className="text-xs text-muted-foreground">Pick a palette, then adjust any color below.</p>
    </fieldset>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <ColorPicker label="Primary" value={primary} onChange={setPrimary} />
      <ColorPicker label="Secondary" value={secondary} onChange={setSecondary} />
      <ColorPicker label="Accent" value={accent} onChange={setAccent} />
    </div>
    {fieldError('theme') ? <p className="text-xs text-destructive" role="alert">{fieldError('theme')}</p> : null}
    <div className="rounded-lg border bg-card p-4" aria-label="Preview">
      <div className="mb-3 flex flex-wrap gap-2">
        {swatches.map(({ label, color }) => <span key={label} className="rounded-lg px-4 py-2 text-sm font-medium" style={{ backgroundColor: color, color: contrastingTextColor(color) }}>{label}</span>)}
      </div>
      <div className="h-2 rounded-full" style={{ background: `linear-gradient(to right, ${primary}, ${secondary}, ${accent})` }} />
    </div>
    <div role="radiogroup" aria-labelledby="appearance-label" className="space-y-3">
      <p id="appearance-label" className="text-sm font-medium">Appearance</p>
      {THEME_MODES.map(option => <ChoiceCard key={option.value} selected={mode === option.value} onSelect={() => setMode(option.value)} label={option.label} description={option.description} />)}
    </div>
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Links (optional)</legend>
      <p className="text-xs text-muted-foreground">Shown in the gathering’s footer. Any platform: Bluesky, Telegram, Discord, Signal, a website. Up to {MAX_SOCIAL_LINKS}.</p>
      {links.length ? <ul className="space-y-3">
        {links.map((link, index) => <li key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor={`link-label-${index}`} className="text-xs text-muted-foreground">Label</Label>
            <Input id={`link-label-${index}`} value={link.label} onChange={e => updateLink(index, 'label', e.target.value)} placeholder="Bluesky" maxLength={SOCIAL_LABEL_MAX} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`link-url-${index}`} className="text-xs text-muted-foreground">URL</Label>
            <Input id={`link-url-${index}`} type="url" value={link.url} onChange={e => updateLink(index, 'url', e.target.value)} placeholder="https://" maxLength={SOCIAL_URL_MAX} />
          </div>
          <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeLink(index)} aria-label={`Remove ${link.label.trim() || 'this'} link`}><Trash2 className="h-4 w-4" aria-hidden="true" /></Button>
        </li>)}
      </ul> : null}
      <Button type="button" variant="outline" onClick={addLink} disabled={links.length >= MAX_SOCIAL_LINKS}><Plus className="mr-1 h-4 w-4" aria-hidden="true" />Add a link</Button>
    </fieldset>
  </SectionCard>
}
