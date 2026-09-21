'use client'

import * as React from 'react'
import { Upload, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { uploadEventLogo, uploadEventBanner } from '@/lib/storage/upload'
import type { Event } from '@/types/event'
import { SectionCard, SaveFeedback, Field } from './SectionCard'
import { useSectionSave } from './shared'

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
        <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => inputRef.current?.click()}>{busy ? null : <Upload className="mr-2 h-4 w-4" aria-hidden="true" />}{url ? 'Replace' : 'Upload'}</Button>
        {url ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={handleRemove}><X className="mr-1 h-4 w-4" aria-hidden="true" />Remove</Button> : null}
      </div>
      <input ref={inputRef} id={id} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={handleFile} />
    </div>
  </Field>
}

/** Logo and banner. Each image is saved the moment it uploads, so this card has no Save button. */
export function ImagesSection({ event }: { event: Event }) {
  const { state, save } = useSectionSave(event.id)
  const [logoUrl, setLogoUrl] = React.useState(event.logoUrl)
  const [bannerUrl, setBannerUrl] = React.useState(event.bannerUrl)

  const persist = (column: 'logo_url' | 'banner_url', setter: (url: string | null) => void) => async (url: string | null) => {
    const result = await save({ [column]: url }, url ? 'Image saved.' : 'Image removed.')
    if (result) setter(url)
    return !!result
  }

  return <SectionCard id="images" title="Images" description="The logo and banner used on the gathering’s page and in link previews."
    footer={<SaveFeedback state={state} idleHint="Images are saved as soon as they upload." />}>
    <ImageField id="event-logo" label="Logo (optional)" hint="Square, PNG or JPG, up to 5MB." url={logoUrl} upload={file => uploadEventLogo(file, event.slug)} onPersist={persist('logo_url', setLogoUrl)} />
    <ImageField id="event-banner" label="Banner (optional)" hint="Wide (about 3:1), up to 5MB." url={bannerUrl} upload={file => uploadEventBanner(file, event.slug)} onPersist={persist('banner_url', setBannerUrl)} previewClassName="h-20 w-full max-w-xs rounded-lg border object-cover" />
  </SectionCard>
}
