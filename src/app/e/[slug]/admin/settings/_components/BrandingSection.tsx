'use client'

import * as React from 'react'
import { Loader2, Upload, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ColorPicker } from '@/components/ui/color-picker'
import { uploadEventLogo, uploadEventBanner } from '@/lib/storage/upload'
import type { Event } from '@/types/event'
import { SectionCard, SaveBar, Field, ChoiceCard } from './SectionCard'
import { useSectionSave } from './shared'
import { THEME_MODES, DEFAULT_COLORS } from './constants'

interface ImageFieldProps {
  id: string
  label: string
  hint: string
  url: string | null
  upload: (file: File) => Promise<{ success: boolean; url?: string; error?: string }>
  onPersist: (url: string | null) => Promise<boolean>
  previewClassName?: string
}

/** Upload to `/api/uploads`, then persist the URL on the event. */
function ImageField({ id, label, hint, url, upload, onPersist, previewClassName }: ImageFieldProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true); setError(null)
    const result = await upload(file)
    if (!result.success || !result.url) setError(result.error || 'Upload failed. Try again.')
    else if (!(await onPersist(result.url))) setError('Uploaded, but the event could not be updated. Try again.')
    setBusy(false)
    if (inputRef.current) inputRef.current.value = ''
  }
  const handleRemove = async () => {
    setBusy(true); setError(null)
    if (!(await onPersist(null))) setError('Could not remove the image. Try again.')
    setBusy(false)
  }
  return <Field label={label} htmlFor={id} hint={hint} error={error}>
    <div className="flex flex-wrap items-center gap-4">
      {url ? <img src={url} alt="" className={previewClassName || 'h-16 w-16 rounded-lg border object-cover'} /> : <div className={`${previewClassName || 'h-16 w-16 rounded-lg'} flex items-center justify-center border border-dashed text-muted-foreground`}><Upload className="h-5 w-5" aria-hidden="true" /></div>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => inputRef.current?.click()}>{busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Upload className="h-4 w-4 mr-2" />}{url ? 'Replace' : 'Upload'}</Button>
        {url ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={handleRemove}><X className="h-4 w-4 mr-1" />Remove</Button> : null}
      </div>
      <input ref={inputRef} id={id} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={handleFile} />
    </div>
  </Field>
}

export function BrandingSection({ event }: { event: Event }) {
  const theme = event.theme || {}
  const { state, save } = useSectionSave(event.id)
  const assets = useSectionSave(event.id)
  const [primary, setPrimary] = React.useState(theme.colors?.primary || DEFAULT_COLORS.primary)
  const [secondary, setSecondary] = React.useState(theme.colors?.secondary || DEFAULT_COLORS.secondary)
  const [accent, setAccent] = React.useState(theme.colors?.accent || DEFAULT_COLORS.accent)
  const [mode, setMode] = React.useState<'light' | 'dark' | 'system'>(theme.mode || 'light')
  const [social, setSocial] = React.useState({ twitter: theme.social?.twitter || '', telegram: theme.social?.telegram || '', discord: theme.social?.discord || '', website: theme.social?.website || '' })
  const [logoUrl, setLogoUrl] = React.useState(event.logoUrl)
  const [bannerUrl, setBannerUrl] = React.useState(event.bannerUrl)
  const fieldError = (field: string) => (state.status === 'error' && state.field === field ? state.message : null)
  const setSocialField = (key: keyof typeof social) => (e: React.ChangeEvent<HTMLInputElement>) => setSocial(prev => ({ ...prev, [key]: e.target.value }))

  const persistAsset = (column: 'logo_url' | 'banner_url', setter: (url: string | null) => void) => async (url: string | null) => {
    const result = await assets.save({ [column]: url }, url ? 'Image saved.' : 'Image removed.')
    if (result) setter(url)
    return !!result
  }

  return <SectionCard id="branding" title="Branding" description="Colors, appearance, links, and imagery for the gathering’s pages."
    onSubmit={() => save({ theme: { colors: { primary, secondary, accent }, mode, social } }, 'Branding saved.')}
    footer={<SaveBar state={state} />}>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <ColorPicker label="Primary" value={primary} onChange={setPrimary} />
      <ColorPicker label="Secondary" value={secondary} onChange={setSecondary} />
      <ColorPicker label="Accent" value={accent} onChange={setAccent} />
    </div>
    {fieldError('theme') ? <p className="text-xs text-destructive" role="alert">{fieldError('theme')}</p> : null}
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap gap-2">
        <span className="rounded-lg px-4 py-2 text-sm font-medium text-white" style={{ backgroundColor: primary }}>Primary</span>
        <span className="rounded-lg px-4 py-2 text-sm font-medium" style={{ backgroundColor: secondary }}>Secondary</span>
        <span className="rounded-lg px-4 py-2 text-sm font-medium" style={{ backgroundColor: accent }}>Accent</span>
      </div>
      <div className="h-2 rounded-full" style={{ background: `linear-gradient(to right, ${primary}, ${secondary}, ${accent})` }} />
    </div>
    <div role="radiogroup" aria-label="Appearance" className="space-y-3">
      <p className="text-sm font-medium">Appearance</p>
      {THEME_MODES.map(option => <ChoiceCard key={option.value} selected={mode === option.value} onSelect={() => setMode(option.value)} label={option.label} description={option.description} />)}
    </div>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field label="Website" htmlFor="social-website"><Input id="social-website" type="url" value={social.website} onChange={setSocialField('website')} placeholder="https://" /></Field>
      <Field label="X / Twitter" htmlFor="social-twitter"><Input id="social-twitter" value={social.twitter} onChange={setSocialField('twitter')} placeholder="@handle or URL" /></Field>
      <Field label="Telegram" htmlFor="social-telegram"><Input id="social-telegram" value={social.telegram} onChange={setSocialField('telegram')} placeholder="https://t.me/…" /></Field>
      <Field label="Discord" htmlFor="social-discord"><Input id="social-discord" value={social.discord} onChange={setSocialField('discord')} placeholder="https://discord.gg/…" /></Field>
    </div>
    <div className="space-y-5 border-t pt-5">
      <ImageField id="event-logo" label="Logo" hint="Square, PNG or JPG, up to 5MB. Saved as soon as it uploads." url={logoUrl} upload={file => uploadEventLogo(file, event.slug)} onPersist={persistAsset('logo_url', setLogoUrl)} />
      <ImageField id="event-banner" label="Banner" hint="Wide (about 3:1), up to 5MB. Used on the event page and link previews." url={bannerUrl} upload={file => uploadEventBanner(file, event.slug)} onPersist={persistAsset('banner_url', setBannerUrl)} previewClassName="h-20 w-full max-w-xs rounded-lg border object-cover" />
      <div className="text-sm" aria-live="polite">
        {assets.state.status === 'error' ? <p role="alert" className="text-destructive">{assets.state.message}</p> : assets.state.status === 'saved' ? <p className="text-primary">{assets.state.message}</p> : null}
      </div>
    </div>
  </SectionCard>
}
