'use client';

import * as React from 'react';
import { AlertTriangle, Fingerprint, Globe, Loader2, Lock, ScrollText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { WarningBox } from '@/components/WarningBox';
import { ELLIPSIS } from '@/lib/format';
import { apiFetch, ApiError } from '@/lib/api/client';
import { Field } from '@/app/e/[slug]/admin/settings/_components/SectionCard';
import { HANDLE_LABEL_MAX, MAX_SLUG_LENGTH, type WizardState, type WizardAction } from '../useWizardState';

/**
 * Step 1, "Identity": what the gathering is called, its address, and the network identity it
 * gets (spec §8). Creating the gathering mints its own DID on our PDS; this step shows the
 * handle it will get and says plainly what becomes public and when, before anything is created.
 * It mirrors "Network identity" in the organizer settings.
 */

interface IdentityStepProps {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}

interface SlugCheck {
  available: boolean;
  error?: string;
  suggestions?: string[];
  handle?: { handle: string | null; domain: string; generated: boolean; reason: 'too-long' | null };
}

const MAX_NAME_LENGTH = 100;

/** Generate a URL-friendly slug from a name. */
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .replace(/-+/g, '-')
    .substring(0, MAX_SLUG_LENGTH)
    .replace(/^-+|-+$/g, '');
}

/** The longest prefix of `slug` that fits a handle label and still ends in a letter or number. */
function shortenForHandle(slug: string): string {
  return slug.slice(0, HANDLE_LABEL_MAX).replace(/-+$/, '');
}

export function IdentityStep({ state, dispatch }: IdentityStepProps) {
  const { basics } = state;
  const slug = basics.slug;
  const errors = state.validation.identity ?? [];
  const [check, setCheck] = React.useState<SlugCheck | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [origin, setOrigin] = React.useState('');

  // Track whether the organizer edited the URL by hand; until then it follows the name.
  const [slugManuallyEdited, setSlugManuallyEdited] = React.useState(
    () => Boolean(basics.name && basics.slug && basics.slug !== generateSlug(basics.name))
  );

  React.useEffect(() => { setOrigin(window.location.origin); }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (!slug) { setCheck(null); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      apiFetch<SlugCheck>('/api/events/validate-slug', { method: 'POST', json: { slug } })
        .then((result) => { if (!cancelled) setCheck(result); })
        .catch((err) => {
          if (cancelled) return;
          setCheck({ available: false, error: err instanceof ApiError ? err.message : 'Could not check this URL right now.' });
        })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [slug]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    dispatch({ type: 'UPDATE_BASICS', payload: slugManuallyEdited ? { name } : { name, slug: generateSlug(name) } });
  };

  const handleSlugChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '').substring(0, MAX_SLUG_LENGTH);
    setSlugManuallyEdited(true);
    dispatch({ type: 'UPDATE_BASICS', payload: { slug: next } });
  };

  const applySlug = (value: string) => {
    setSlugManuallyEdited(true);
    dispatch({ type: 'UPDATE_BASICS', payload: { slug: value } });
  };

  const preview = check?.handle;
  const domain = preview?.domain;
  const tooLong = slug.length > HANDLE_LABEL_MAX;
  const shorter = tooLong ? shortenForHandle(slug) : null;
  const nameError = errors.find((e) => /name/i.test(e)) ?? null;
  const slugError = errors.find((e) => /URL|characters/i.test(e)) ?? null;
  const ackError = errors.find((e) => /public/i.test(e)) ?? null;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="h-5 w-5 text-primary" aria-hidden="true" />
            Your gathering’s identity
          </CardTitle>
          <CardDescription>
            Its name and address here, and its own identity on the open social network (ATProto) — separate from yours, held for the gathering by this service.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Field label="Gathering name" htmlFor="name" error={nameError} hint={`${basics.name.length}/${MAX_NAME_LENGTH}`}>
            <Input
              id="name"
              placeholder="e.g. Front Range Commons"
              value={basics.name}
              onChange={handleNameChange}
              maxLength={MAX_NAME_LENGTH}
              error={!!nameError}
              autoComplete="off"
            />
          </Field>

          <Field
            label="Gathering URL"
            htmlFor="slug"
            error={slugError}
            hint={`${slug.length}/${MAX_SLUG_LENGTH} · Lowercase letters, numbers and hyphens. This also becomes the gathering’s own address and handle on the network.`}
          >
            <Input
              id="slug"
              placeholder="your-gathering"
              value={slug}
              onChange={handleSlugChange}
              maxLength={MAX_SLUG_LENGTH}
              error={!!slugError}
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <div className="rounded-xl border bg-secondary/40 p-4 space-y-3" aria-live="polite">
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Checking the name{ELLIPSIS}</p>
            ) : check && !check.available ? (
              <div className="space-y-2" role="alert">
                <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />{check.error || 'This event URL is already taken.'}</p>
                {check.suggestions && check.suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {check.suggestions.map((s) => (
                      <Button key={s} type="button" size="sm" variant="outline" onClick={() => applySlug(s)}>{s}</Button>
                    ))}
                  </div>
                )}
              </div>
            ) : preview ? (
              <>
                <div>
                  <p className="text-xs text-muted-foreground">Handle</p>
                  {preview.handle ? (
                    <p className="font-mono text-lg break-all">@{preview.handle}</p>
                  ) : (
                    <p className="text-sm">A generated handle, like <span className="font-mono">@calmotter417.{domain}</span></p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Addresses</p>
                  <p className="font-mono text-sm break-all">{origin ? `${origin}/e/${slug}` : `/e/${slug}`}</p>
                  {domain && <p className="font-mono text-sm break-all">https://{slug}.{domain}</p>}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Choose an event URL to see the handle the gathering will get.</p>
            )}
          </div>

          {tooLong && shorter && (
            <WarningBox title="This URL is longer than a handle can be">
              <p>Handles can be at most {HANDLE_LABEL_MAX} characters before the domain, and <span className="font-mono">{slug}</span> is {slug.length}. The gathering will get a generated handle unless you use a shorter URL.</p>
              <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => applySlug(shorter)}>Use “{shorter}” instead</Button>
            </WarningBox>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What becomes public, and when</CardTitle>
          <CardDescription>Records on the network are copied by anyone who follows it. Deleting them later does not recall the copies.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div className="flex gap-3">
            <Lock className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p><span className="font-medium">Now, while it is a draft:</span> only the identity exists. No gathering content is published yet. You can delete the draft and close its account; its public identity history may remain.</p>
          </div>
          <div className="flex gap-3">
            <Globe className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p><span className="font-medium">When you publish it:</span> the gathering’s name, dates, description, public location and participation rules become public records in its own repository.</p>
          </div>
          <div className="flex gap-3">
            <ScrollText className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p><span className="font-medium">When you publish the schedule:</span> each scheduled session becomes a permanent public calendar record. Moving or cancelling one afterwards needs the approvals you set in the Voting step, and leaves a public trace.</p>
          </div>
          <p className="text-muted-foreground">
            Who voted for what is never published — only counts from at least {state.voting.policyThresholds.feedbackK} voters (“Fewest voters before a count is shown”, in the Voting step). Membership lists are never published. Proposals belong to the people who wrote them.
          </p>

          <div className="flex items-start gap-3 rounded-xl border p-4">
            <Checkbox
              id="identity-ack"
              checked={state.identity.acknowledged}
              onCheckedChange={(checked) => dispatch({ type: 'UPDATE_IDENTITY', payload: { acknowledged: checked === true } })}
              aria-describedby={ackError ? 'identity-ack-error' : undefined}
            />
            <Label htmlFor="identity-ack" className="text-sm font-normal leading-relaxed cursor-pointer">
              I understand that creating this gathering gives it a public identity, and that publishing it and its schedule creates permanent public records.
            </Label>
          </div>
          {ackError ? (
            <p id="identity-ack-error" className="text-xs text-destructive" role="alert">{ackError}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default IdentityStep;
