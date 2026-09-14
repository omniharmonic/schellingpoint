'use client';

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { uploadEventLogo, uploadEventBanner } from '@/lib/storage/upload';
import type { WizardState, WizardAction, ThemeMode } from '../useWizardState';

// ============================================================================
// Types
// ============================================================================

interface BrandingStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

interface ThemePreset {
  name: string;
  category: string;
  primary: string;
  secondary: string;
  accent: string;
  mode?: 'dark' | 'light';
  description: string;
}

// ============================================================================
// Constants
// ============================================================================

// Refined theme palettes — each has a clear identity and restrained color
// usage, no neon saturation. Organizers can still customize with the picker.
const THEME_PRESETS: ThemePreset[] = [
  { name: 'Commons', category: 'Cool', primary: '#246653', secondary: '#E8F1EB', accent: '#DCD5ED', mode: 'light', description: 'Spruce, mineral white, and lilac. Space for people and ideas.' },
  // === Earth & grounded ===
  {
    name: 'Terra',
    category: 'Earth',
    primary: '#B97F5A',
    secondary: '#6B5744',
    accent: '#D4A373',
    mode: 'light',
    description: 'Warm terracotta and oak — grounded, human',
  },
  {
    name: 'Parchment',
    category: 'Earth',
    primary: '#7D6B55',
    secondary: '#4A4238',
    accent: '#C9A87C',
    mode: 'light',
    description: 'Aged paper and honey — quiet and considered',
  },
  {
    name: 'Sage',
    category: 'Earth',
    primary: '#6B8E7F',
    secondary: '#3E5349',
    accent: '#C8B68B',
    mode: 'light',
    description: 'Moss and cream — botanical and calm',
  },

  // === Dark & sophisticated ===
  {
    name: 'Midnight',
    category: 'Dark',
    primary: '#7C8BFF',
    secondary: '#1A2238',
    accent: '#F5C98F',
    mode: 'dark',
    description: 'Deep indigo with a warm highlight — editorial dark mode',
  },
  {
    name: 'Noir',
    category: 'Dark',
    primary: '#D4AF37',
    secondary: '#111827',
    accent: '#6B7280',
    mode: 'dark',
    description: 'Graphite and gold — minimal, cinematic',
  },

  // === Cool & refined ===
  {
    name: 'Nordic',
    category: 'Cool',
    primary: '#5B7DB1',
    secondary: '#2C3E50',
    accent: '#A9BCD0',
    mode: 'light',
    description: 'Slate blue and fog — understated and precise',
  },
  {
    name: 'Harbor',
    category: 'Cool',
    primary: '#1F6E8C',
    secondary: '#0E4B5A',
    accent: '#E8C547',
    mode: 'light',
    description: 'Deep teal with a brass accent',
  },

  // === Warm & muted ===
  {
    name: 'Rose',
    category: 'Warm',
    primary: '#B56576',
    secondary: '#6D4C5A',
    accent: '#EAAC8B',
    mode: 'light',
    description: 'Dusty rose and peach — muted and warm',
  },
  {
    name: 'Dusk',
    category: 'Warm',
    primary: '#8E7CC3',
    secondary: '#534678',
    accent: '#F4A261',
    mode: 'dark',
    description: 'Amethyst and amber — reflective evening light',
  },
];

const THEME_CATEGORIES = ['Earth', 'Dark', 'Cool', 'Warm'] as const;

const THEME_MODES: { value: ThemeMode; label: string; description: string }[] = [
  { value: 'light', label: 'Light', description: 'Always use light mode' },
  { value: 'dark', label: 'Dark', description: 'Always use dark mode' },
  { value: 'system', label: 'System', description: 'Follow user preference' },
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate if a string is a valid hex color
 */
function isValidHexColor(color: string): boolean {
  return /^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/.test(color);
}

/**
 * Normalize a hex input (adds # if missing)
 */
function normalizeHexInput(input: string): string {
  const cleaned = input.trim();
  if (!cleaned) return '';
  if (cleaned.startsWith('#')) return cleaned;
  return `#${cleaned}`;
}

/**
 * Check if current theme matches a preset
 */
function isPresetSelected(theme: { primary: string; secondary: string; accent: string }, preset: ThemePreset): boolean {
  return (
    theme.primary.toLowerCase() === preset.primary.toLowerCase() &&
    theme.secondary.toLowerCase() === preset.secondary.toLowerCase() &&
    theme.accent.toLowerCase() === preset.accent.toLowerCase()
  );
}

// ============================================================================
// Sub-Components
// ============================================================================

interface ImageUploadProps {
  label: string;
  description: string;
  aspectHint?: string;
  previewUrl: string | null;
  onUpload: (file: File) => Promise<string | null>; // Returns URL or null on error
  onRemove: () => void;
  accept?: string;
}

function ImageUpload({ label, description, aspectHint, previewUrl, onUpload, onRemove, accept = 'image/*' }: ImageUploadProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [localPreview, setLocalPreview] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    setIsUploading(true);

    // Create local preview URL immediately
    const localUrl = URL.createObjectURL(file);
    setLocalPreview(localUrl);

    try {
      const uploadedUrl = await onUpload(file);
      if (!uploadedUrl) {
        // Error message is set by the caller via the upload function
        URL.revokeObjectURL(localUrl);
        setLocalPreview(null);
      } else {
        // Upload succeeded, keep local preview until we switch to remote
        URL.revokeObjectURL(localUrl);
        setLocalPreview(null); // Clear local preview, use remote URL now
        setUploadError(null);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setUploadError(errorMessage);
      URL.revokeObjectURL(localUrl);
      setLocalPreview(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleRemove = () => {
    if (localPreview) {
      URL.revokeObjectURL(localPreview);
    }
    setLocalPreview(null);
    setUploadError(null);
    onRemove();
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      if (localPreview) {
        URL.revokeObjectURL(localPreview);
      }
    };
  }, [localPreview]);

  const displayPreview = localPreview || previewUrl;

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <p className="text-sm text-muted-foreground">{description}</p>
      {aspectHint && (
        <p className="text-xs text-muted-foreground italic">{aspectHint}</p>
      )}

      <div className="mt-2">
        {displayPreview ? (
          <div className="relative group">
            <img
              src={displayPreview}
              alt={`${label} preview`}
              className={cn(
                "max-h-40 rounded-lg border object-contain",
                isUploading && "opacity-50"
              )}
            />
            {isUploading && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="flex items-center gap-2 bg-background/90 px-3 py-2 rounded-lg shadow">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <span className="text-sm">Uploading...</span>
                </div>
              </div>
            )}
            {!isUploading && (
              <button
                type="button"
                onClick={handleRemove}
                className="absolute top-2 right-2 p-1.5 rounded-full bg-background/80 border shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive hover:text-destructive-foreground"
                aria-label="Remove image"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            )}
          </div>
        ) : (
          <label className={cn(
            "flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-lg transition-colors",
            isUploading
              ? "cursor-wait bg-muted/50"
              : "cursor-pointer hover:bg-accent/50"
          )}>
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              {isUploading ? (
                <>
                  <svg className="animate-spin h-6 w-6 mb-2 text-muted-foreground" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  <p className="text-sm text-muted-foreground">Uploading...</p>
                </>
              ) : (
                <>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="24"
                    height="24"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="mb-2 text-muted-foreground"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" x2="12" y1="3" y2="15" />
                  </svg>
                  <p className="text-sm text-muted-foreground">
                    Click to upload or drag and drop
                  </p>
                </>
              )}
            </div>
            <input
              ref={inputRef}
              type="file"
              className="hidden"
              accept={accept}
              onChange={handleFileChange}
              disabled={isUploading}
            />
          </label>
        )}
      </div>
      {uploadError && (
        <p className="text-sm text-destructive">{uploadError}</p>
      )}
    </div>
  );
}

interface ColorPickerProps {
  label: string;
  value: string;
  onChange: (color: string) => void;
}

function ColorPicker({ label, value, onChange }: ColorPickerProps) {
  const [inputValue, setInputValue] = React.useState(value);
  const [isValid, setIsValid] = React.useState(true);

  // Sync input value when prop changes
  React.useEffect(() => {
    setInputValue(value);
    setIsValid(isValidHexColor(value));
  }, [value]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setInputValue(raw);

    const normalized = normalizeHexInput(raw);
    if (isValidHexColor(normalized)) {
      setIsValid(true);
      onChange(normalized);
    } else {
      setIsValid(raw === '' || raw === '#');
    }
  };

  const handleColorChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const color = e.target.value;
    setInputValue(color);
    setIsValid(true);
    onChange(color);
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <input
          type="color"
          value={isValidHexColor(value) ? value : '#000000'}
          onChange={handleColorChange}
          className="w-10 h-10 rounded-lg border cursor-pointer"
        />
        <Input
          value={inputValue}
          onChange={handleInputChange}
          placeholder="#000000"
          className={cn('font-mono', !isValid && 'border-destructive')}
          maxLength={7}
        />
      </div>
      {!isValid && inputValue.length > 1 && (
        <p className="text-xs text-destructive">Please enter a valid hex color (e.g., #FF5500)</p>
      )}
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

export function BrandingStep({ state, dispatch }: BrandingStepProps) {
  const { branding } = state;

  // Handlers for theme updates
  const handleThemeColorChange = (colorType: 'primary' | 'secondary' | 'accent') => (color: string) => {
    dispatch({
      type: 'UPDATE_BRANDING',
      payload: {
        theme: {
          ...branding.theme,
          [colorType]: color,
        },
      },
    });
  };

  const handleThemeModeChange = (mode: ThemeMode) => {
    dispatch({
      type: 'UPDATE_BRANDING',
      payload: {
        theme: {
          ...branding.theme,
          mode,
        },
      },
    });
  };

  const handlePresetSelect = (preset: ThemePreset) => {
    dispatch({
      type: 'UPDATE_BRANDING',
      payload: {
        theme: {
          ...branding.theme,
          primary: preset.primary,
          secondary: preset.secondary,
          accent: preset.accent,
          // Honor each preset's intended mode (light/dark) if specified so
          // e.g. the Midnight theme opens in dark by default.
          ...(preset.mode ? { mode: preset.mode } : {}),
        },
      },
    });
  };

  // Handlers for social updates
  const handleSocialChange = (field: keyof typeof branding.social) => (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    dispatch({
      type: 'UPDATE_BRANDING',
      payload: {
        social: {
          ...branding.social,
          [field]: e.target.value,
        },
      },
    });
  };

  // File upload handlers
  const handleLogoUpload = React.useCallback(async (file: File): Promise<string | null> => {
    const result = await uploadEventLogo(file);
    if (result.success && result.url) {
      dispatch({
        type: 'UPDATE_BRANDING',
        payload: { logoUrl: result.url },
      });
      return result.url;
    }
    console.error('Logo upload failed:', result.error);
    // Throw error so the ImageUpload component can display it
    throw new Error(result.error || 'Upload failed');
  }, [dispatch]);

  const handleLogoRemove = React.useCallback(() => {
    dispatch({
      type: 'UPDATE_BRANDING',
      payload: { logoUrl: null },
    });
  }, [dispatch]);

  const handleBannerUpload = React.useCallback(async (file: File): Promise<string | null> => {
    const result = await uploadEventBanner(file);
    if (result.success && result.url) {
      dispatch({
        type: 'UPDATE_BRANDING',
        payload: { bannerUrl: result.url },
      });
      return result.url;
    }
    console.error('Banner upload failed:', result.error);
    // Throw error so the ImageUpload component can display it
    throw new Error(result.error || 'Upload failed');
  }, [dispatch]);

  const handleBannerRemove = React.useCallback(() => {
    dispatch({
      type: 'UPDATE_BRANDING',
      payload: { bannerUrl: null },
    });
  }, [dispatch]);

  // Check if current colors match any preset
  const currentPreset = THEME_PRESETS.find((preset) =>
    isPresetSelected(branding.theme, preset)
  );
  const isCustomTheme = !currentPreset;

  return (
    <div className="space-y-6">
      {/* Logo & Banner Uploads */}
      <Card>
        <CardHeader>
          <CardTitle>Event Images</CardTitle>
          <CardDescription>
            Add a logo and banner image to customize your event appearance
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ImageUpload
            label="Logo"
            description="Your event logo, displayed in navigation and cards"
            aspectHint="Recommended: Square image (1:1 ratio)"
            previewUrl={branding.logoUrl}
            onUpload={handleLogoUpload}
            onRemove={handleLogoRemove}
          />

          <ImageUpload
            label="Banner Image"
            description="A banner image for your event page header"
            aspectHint="Recommended: 16:9 aspect ratio (e.g., 1920x1080)"
            previewUrl={branding.bannerUrl}
            onUpload={handleBannerUpload}
            onRemove={handleBannerRemove}
          />
        </CardContent>
      </Card>

      {/* Color Theme */}
      <Card>
        <CardHeader>
          <CardTitle>Color Theme</CardTitle>
          <CardDescription>
            Choose a preset theme or customize your own colors
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Presets */}
          <div className="space-y-5">
            <Label>Theme Presets</Label>

            {THEME_CATEGORIES.map((category) => {
              const presetsInCategory = THEME_PRESETS.filter(
                (p) => p.category === category,
              );
              if (presetsInCategory.length === 0) return null;

              return (
                <div key={category} className="space-y-2">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground">
                    {category}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    {presetsInCategory.map((preset) => {
                      const isSelected = isPresetSelected(branding.theme, preset);
                      // Use preset.mode to pick a tasteful preview background
                      const previewBg = preset.mode === 'dark' ? '#111827' : '#F7F3EC';
                      const previewFg = preset.mode === 'dark' ? '#F7F3EC' : '#1A1A1A';
                      return (
                        <button
                          key={preset.name}
                          type="button"
                          onClick={() => handlePresetSelect(preset)}
                          className={cn(
                            'group flex flex-col items-stretch rounded-xl border-2 overflow-hidden transition-all text-left',
                            'hover:border-primary/50',
                            'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                            isSelected ? 'border-primary' : 'border-border',
                          )}
                        >
                          {/* Preview swatch */}
                          <div
                            className="px-4 py-3 flex items-center justify-between"
                            style={{ backgroundColor: previewBg, color: previewFg }}
                          >
                            <div className="flex items-center gap-1.5">
                              <span
                                className="h-5 w-5 rounded-full shadow-sm ring-1 ring-black/5"
                                style={{ backgroundColor: preset.primary }}
                              />
                              <span
                                className="h-5 w-5 rounded-full shadow-sm ring-1 ring-black/5 -ml-2"
                                style={{ backgroundColor: preset.secondary }}
                              />
                              <span
                                className="h-5 w-5 rounded-full shadow-sm ring-1 ring-black/5 -ml-2"
                                style={{ backgroundColor: preset.accent }}
                              />
                            </div>
                            <span
                              className="text-xs tracking-wide opacity-70"
                            >
                              {preset.mode === 'dark' ? 'Dark' : 'Light'}
                            </span>
                          </div>
                          <div className="px-4 py-3 bg-card">
                            <p className="text-sm font-medium">{preset.name}</p>
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                              {preset.description}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Custom marker */}
            {isCustomTheme && (
              <div className="flex items-center gap-3 rounded-xl border-2 border-primary bg-primary/5 p-3">
                <div className="flex items-center gap-1.5">
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-black/5"
                    style={{ backgroundColor: branding.theme.primary }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-black/5 -ml-2"
                    style={{ backgroundColor: branding.theme.secondary }}
                  />
                  <span
                    className="h-5 w-5 rounded-full ring-1 ring-black/5 -ml-2"
                    style={{ backgroundColor: branding.theme.accent }}
                  />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium">Custom palette</p>
                  <p className="text-xs text-muted-foreground">
                    You&apos;ve customized the colors below.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Custom Color Pickers */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <ColorPicker
              label="Primary Color"
              value={branding.theme.primary}
              onChange={handleThemeColorChange('primary')}
            />
            <ColorPicker
              label="Secondary Color"
              value={branding.theme.secondary}
              onChange={handleThemeColorChange('secondary')}
            />
            <ColorPicker
              label="Accent Color"
              value={branding.theme.accent}
              onChange={handleThemeColorChange('accent')}
            />
          </div>

          {/* Theme Preview */}
          <div className="space-y-2">
            <Label>Preview</Label>
            <div className="p-4 rounded-lg border bg-card">
              <div className="flex flex-wrap gap-2 mb-3">
                <div
                  className="px-4 py-2 rounded-lg text-white text-sm font-medium"
                  style={{ backgroundColor: branding.theme.primary }}
                >
                  Primary Button
                </div>
                <div
                  className="px-4 py-2 rounded-lg text-white text-sm font-medium"
                  style={{ backgroundColor: branding.theme.secondary }}
                >
                  Secondary
                </div>
                <div
                  className="px-4 py-2 rounded-lg text-white text-sm font-medium"
                  style={{ backgroundColor: branding.theme.accent }}
                >
                  Accent
                </div>
              </div>
              <div
                className="h-2 rounded-full"
                style={{
                  background: `linear-gradient(to right, ${branding.theme.primary}, ${branding.theme.secondary}, ${branding.theme.accent})`,
                }}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Theme Mode */}
      <Card>
        <CardHeader>
          <CardTitle>Theme Mode</CardTitle>
          <CardDescription>
            Choose the default color scheme for your event
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {THEME_MODES.map((mode) => (
              <button
                key={mode.value}
                type="button"
                onClick={() => handleThemeModeChange(mode.value)}
                className={cn(
                  'flex items-center w-full p-4 rounded-lg border-2 text-left transition-all',
                  'hover:border-primary/50 hover:bg-accent/50',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  branding.theme.mode === mode.value
                    ? 'border-primary bg-primary/5'
                    : 'border-border'
                )}
              >
                <div
                  className={cn(
                    'flex items-center justify-center w-5 h-5 rounded-full border-2 mr-4 flex-shrink-0',
                    branding.theme.mode === mode.value
                      ? 'border-primary bg-primary'
                      : 'border-muted-foreground'
                  )}
                >
                  {branding.theme.mode === mode.value && (
                    <div className="w-2 h-2 rounded-full bg-primary-foreground" />
                  )}
                </div>
                <div>
                  <span className="font-medium">{mode.label}</span>
                  <p className="text-sm text-muted-foreground">
                    {mode.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Social Links */}
      <Card>
        <CardHeader>
          <CardTitle>Social Links</CardTitle>
          <CardDescription>
            Add links to your event&apos;s social media and website
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Twitter */}
          <div className="space-y-2">
            <Label htmlFor="twitter">Twitter / X</Label>
            <Input
              id="twitter"
              placeholder="https://twitter.com/yourevent or @handle"
              value={branding.social.twitter}
              onChange={handleSocialChange('twitter')}
            />
            <p className="text-xs text-muted-foreground">
              Enter your Twitter URL or @handle
            </p>
          </div>

          {/* Telegram */}
          <div className="space-y-2">
            <Label htmlFor="telegram">Telegram</Label>
            <Input
              id="telegram"
              placeholder="https://t.me/yourchannel"
              value={branding.social.telegram}
              onChange={handleSocialChange('telegram')}
            />
            <p className="text-xs text-muted-foreground">
              Enter your Telegram channel or group URL
            </p>
          </div>

          {/* Discord */}
          <div className="space-y-2">
            <Label htmlFor="discord">Discord</Label>
            <Input
              id="discord"
              placeholder="https://discord.gg/yourserver"
              value={branding.social.discord}
              onChange={handleSocialChange('discord')}
            />
            <p className="text-xs text-muted-foreground">
              Enter your Discord invite URL
            </p>
          </div>

          {/* Website */}
          <div className="space-y-2">
            <Label htmlFor="website">Website</Label>
            <Input
              id="website"
              placeholder="https://yourevent.com"
              value={branding.social.website}
              onChange={handleSocialChange('website')}
            />
            <p className="text-xs text-muted-foreground">
              Enter your event&apos;s website URL
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default BrandingStep;
