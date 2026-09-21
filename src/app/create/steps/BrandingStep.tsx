'use client';

import * as React from 'react';
import { Link2, Plus, Upload, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ColorPicker } from '@/components/ui/color-picker';
import { Field, ChoiceCard } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import {
  THEME_MODES,
  THEME_PRESETS,
  THEME_PRESET_CATEGORIES,
  SOCIAL_LINKS_MAX,
  contrastingTextColor,
  matchingThemePreset,
  socialToList,
  listToSocial,
  type ThemePreset,
  type SocialLinkEntry,
} from '@/app/e/[slug]/admin/settings/_components/constants';
import { cn } from '@/lib/utils';
import { uploadEventLogo, uploadEventBanner, type UploadResult } from '@/lib/storage/upload';
import type { WizardState, WizardAction, ThemeMode } from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

interface BrandingStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

// ============================================================================
// Image upload (same shape as the settings ImageField, but the URL lives in the draft)
// ============================================================================

interface ImageUploadProps {
  id: string;
  label: string;
  hint: string;
  url: string | null;
  upload: (file: File) => Promise<UploadResult>;
  onChange: (url: string | null) => void;
  previewClassName?: string;
}

function ImageUpload({ id, label, hint, url, upload, onChange, previewClassName }: ImageUploadProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await upload(file);
      if (!result.success || !result.url) setError(result.error || 'Upload failed. Try again.');
      else onChange(result.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed. Try again.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <div className="flex flex-wrap items-center gap-4">
        {url ? (
          <img src={url} alt="" className={previewClassName || 'h-16 w-16 rounded-lg border object-cover'} />
        ) : (
          <div className={cn(previewClassName || 'h-16 w-16 rounded-lg', 'flex items-center justify-center border border-dashed text-muted-foreground')}>
            <Upload className="h-5 w-5" aria-hidden="true" />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" loading={busy} onClick={() => inputRef.current?.click()}>
            {!busy && <Upload className="h-4 w-4 mr-2" aria-hidden="true" />}
            {url ? 'Replace' : 'Upload'}
          </Button>
          {url ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setError(null); onChange(null); }}>
              <X className="h-4 w-4 mr-1" aria-hidden="true" />
              Remove
            </Button>
          ) : null}
        </div>
        <input ref={inputRef} id={id} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" onChange={handleFile} disabled={busy} />
      </div>
    </Field>
  );
}

// ============================================================================
// Theme preset card
// ============================================================================

function PresetCard({ preset, selected, onSelect }: { preset: ThemePreset; selected: boolean; onSelect: () => void }) {
  const previewBg = preset.mode === 'dark' ? '#111827' : '#F7F3EC';
  const previewFg = preset.mode === 'dark' ? '#F7F3EC' : '#1A1A1A';
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'group flex flex-col items-stretch rounded-xl border-2 overflow-hidden transition-all text-left',
        'hover:border-primary/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        selected ? 'border-primary' : 'border-border'
      )}
    >
      <div className="px-4 py-3 flex items-center justify-between" style={{ backgroundColor: previewBg, color: previewFg }}>
        <div className="flex items-center gap-1.5">
          <span className="h-5 w-5 rounded-full shadow-sm ring-1 ring-black/5" style={{ backgroundColor: preset.primary }} />
          <span className="h-5 w-5 rounded-full shadow-sm ring-1 ring-black/5 -ml-2" style={{ backgroundColor: preset.secondary }} />
          <span className="h-5 w-5 rounded-full shadow-sm ring-1 ring-black/5 -ml-2" style={{ backgroundColor: preset.accent }} />
        </div>
        <span className="text-xs tracking-wide opacity-70">{preset.mode === 'dark' ? 'Dark' : 'Light'}</span>
      </div>
      <div className="px-4 py-3 bg-card">
        <p className="text-sm font-medium">{preset.name}</p>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{preset.description}</p>
      </div>
    </button>
  );
}

// ============================================================================
// Component
// ============================================================================

export function BrandingStep({ state, dispatch }: BrandingStepProps) {
  const { branding } = state;

  // The social links are edited as one list; storage keeps the legacy keys + `links`.
  const [links, setLinks] = React.useState<SocialLinkEntry[]>(() => socialToList(branding.social));
  const commitLinks = (next: SocialLinkEntry[]) => {
    setLinks(next);
    dispatch({ type: 'UPDATE_BRANDING', payload: { social: listToSocial(next) } });
  };
  const updateLink = (index: number, patch: Partial<SocialLinkEntry>) =>
    commitLinks(links.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  const removeLink = (index: number) => commitLinks(links.filter((_, i) => i !== index));
  const addLink = () => { if (links.length < SOCIAL_LINKS_MAX) commitLinks([...links, { label: '', url: '' }]); };

  const setTheme = (theme: Partial<WizardState['branding']['theme']>) =>
    dispatch({ type: 'UPDATE_BRANDING', payload: { theme: { ...branding.theme, ...theme } } });

  const handlePresetSelect = (preset: ThemePreset) =>
    // Honor each preset's intended mode (light/dark) so e.g. Midnight opens in dark by default.
    setTheme({ primary: preset.primary, secondary: preset.secondary, accent: preset.accent, mode: preset.mode });

  const currentPreset = matchingThemePreset(branding.theme);
  const swatches: { label: string; color: string }[] = [
    { label: 'Primary', color: branding.theme.primary },
    { label: 'Secondary', color: branding.theme.secondary },
    { label: 'Accent', color: branding.theme.accent },
  ];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Images</CardTitle>
          <CardDescription>A logo and a banner for the gathering’s pages and link previews. Optional; both can be changed later.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ImageUpload
            id="event-logo"
            label="Logo (optional)"
            hint="Square, PNG or JPG, up to 5MB. Shown in navigation and on cards."
            url={branding.logoUrl}
            upload={(file) => uploadEventLogo(file)}
            onChange={(logoUrl) => dispatch({ type: 'UPDATE_BRANDING', payload: { logoUrl } })}
          />
          <ImageUpload
            id="event-banner"
            label="Banner (optional)"
            hint="Wide (about 3:1), up to 5MB. Used on the event page header and link previews."
            url={branding.bannerUrl}
            upload={(file) => uploadEventBanner(file)}
            onChange={(bannerUrl) => dispatch({ type: 'UPDATE_BRANDING', payload: { bannerUrl } })}
            previewClassName="h-20 w-full max-w-xs rounded-lg border object-cover"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Colors</CardTitle>
          <CardDescription>Choose a palette or set your own colors. Palettes stay available in Event settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-5" role="radiogroup" aria-label="Color palette">
            {THEME_PRESET_CATEGORIES.map((category) => {
              const presets = THEME_PRESETS.filter((p) => p.category === category);
              if (presets.length === 0) return null;
              return (
                <div key={category} className="space-y-2">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground">{category}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {presets.map((preset) => (
                      <PresetCard key={preset.name} preset={preset} selected={currentPreset?.name === preset.name} onSelect={() => handlePresetSelect(preset)} />
                    ))}
                  </div>
                </div>
              );
            })}
            {!currentPreset && (
              <div className="flex items-center gap-3 rounded-xl border-2 border-primary bg-primary/5 p-3">
                <div className="flex items-center gap-1.5">
                  <span className="h-5 w-5 rounded-full ring-1 ring-black/5" style={{ backgroundColor: branding.theme.primary }} />
                  <span className="h-5 w-5 rounded-full ring-1 ring-black/5 -ml-2" style={{ backgroundColor: branding.theme.secondary }} />
                  <span className="h-5 w-5 rounded-full ring-1 ring-black/5 -ml-2" style={{ backgroundColor: branding.theme.accent }} />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">Custom palette</p>
                  <p className="text-xs text-muted-foreground">You’ve set the colors below yourself.</p>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ColorPicker label="Primary" value={branding.theme.primary} onChange={(primary) => setTheme({ primary })} />
            <ColorPicker label="Secondary" value={branding.theme.secondary} onChange={(secondary) => setTheme({ secondary })} />
            <ColorPicker label="Accent" value={branding.theme.accent} onChange={(accent) => setTheme({ accent })} />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Preview</p>
            <div className="rounded-lg border bg-card p-4">
              <div className="mb-3 flex flex-wrap gap-2">
                {swatches.map((swatch) => (
                  <span
                    key={swatch.label}
                    className="rounded-lg px-4 py-2 text-sm font-medium"
                    style={{ backgroundColor: swatch.color, color: contrastingTextColor(swatch.color) }}
                  >
                    {swatch.label}
                  </span>
                ))}
              </div>
              <div
                className="h-2 rounded-full"
                style={{ background: `linear-gradient(to right, ${branding.theme.primary}, ${branding.theme.secondary}, ${branding.theme.accent})` }}
              />
            </div>
          </div>

          <div role="radiogroup" aria-label="Appearance" className="space-y-3">
            <p className="text-sm font-medium">Appearance</p>
            {THEME_MODES.map((option) => (
              <ChoiceCard
                key={option.value}
                selected={branding.theme.mode === option.value}
                onSelect={() => setTheme({ mode: option.value as ThemeMode })}
                label={option.label}
                description={option.description}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Links</CardTitle>
          <CardDescription>Where people can find the gathering elsewhere: a website, Bluesky, Telegram, Signal, Discord, Luma — any label you like. Shown in the footer of the gathering’s pages.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {links.length > 0 ? (
            <ul className="space-y-3">
              {links.map((entry, index) => (
                <li key={index} className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-end">
                  <Field label="Label" htmlFor={`social-label-${index}`}>
                    <Input
                      id={`social-label-${index}`}
                      value={entry.label}
                      onChange={(e) => updateLink(index, { label: e.target.value })}
                      placeholder="e.g. Bluesky"
                      maxLength={40}
                    />
                  </Field>
                  <Field label="URL" htmlFor={`social-url-${index}`}>
                    <Input
                      id={`social-url-${index}`}
                      type="url"
                      inputMode="url"
                      value={entry.url}
                      onChange={(e) => updateLink(index, { url: e.target.value })}
                      placeholder="https://"
                      maxLength={300}
                    />
                  </Field>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeLink(index)} aria-label={`Remove ${entry.label || 'this link'}`}>
                    <X className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Link2 className="h-4 w-4" aria-hidden="true" />
              No links yet.
            </p>
          )}
          <Button type="button" variant="outline" size="sm" onClick={addLink} disabled={links.length >= SOCIAL_LINKS_MAX}>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add a link
          </Button>
          {links.length >= SOCIAL_LINKS_MAX && <p className="text-xs text-muted-foreground">Up to {SOCIAL_LINKS_MAX} links.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

export default BrandingStep;
