'use client';

import * as React from 'react';
import { AlertTriangle, Fingerprint, Globe, Loader2, Lock, ScrollText } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { apiFetch, ApiError } from '@/lib/api/client';
import { HANDLE_LABEL_MAX, type WizardState, type WizardAction } from '../useWizardState';

/**
 * "Claim your gathering's identity" (spec §8). Creating the gathering mints its own DID on
 * our PDS; this step shows the handle it will get, and says plainly what becomes public
 * and when, before anything is created.
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

/** The longest prefix of `slug` that fits a handle label and still ends in a letter or number. */
function shortenForHandle(slug: string): string {
  return slug.slice(0, HANDLE_LABEL_MAX).replace(/-+$/, '');
}

export function IdentityStep({ state, dispatch }: IdentityStepProps) {
  const slug = state.basics.slug;
  const [check, setCheck] = React.useState<SlugCheck | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [origin, setOrigin] = React.useState('');

  React.useEffect(() => { setOrigin(window.location.origin); }, []);

  React.useEffect(() => {
    let cancelled = false;
    if (!slug) { setCheck(null); return; }
    setLoading(true);
    apiFetch<SlugCheck>('/api/events/validate-slug', { method: 'POST', json: { slug } })
      .then((result) => { if (!cancelled) setCheck(result); })
      .catch((err) => {
        if (cancelled) return;
        setCheck({ available: false, error: err instanceof ApiError ? err.message : 'Could not check this URL right now.' });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  const preview = check?.handle;
  const domain = preview?.domain;
  const tooLong = slug.length > HANDLE_LABEL_MAX;
  const shorter = tooLong ? shortenForHandle(slug) : null;

  const useShorter = () => {
    if (!shorter) return;
    dispatch({ type: 'UPDATE_BASICS', payload: { slug: shorter } });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Fingerprint className="h-5 w-5 text-primary" aria-hidden="true" />Your gathering’s identity</CardTitle>
          <CardDescription>
            Creating {state.basics.name.trim() || 'this gathering'} gives it its own identity on the open social network (ATProto) — separate from yours, held for the gathering by this service.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="rounded-xl border bg-secondary/40 p-4 space-y-3" aria-live="polite">
            {loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking the name…</p>
            ) : check && !check.available ? (
              <div className="space-y-2" role="alert">
                <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />{check.error || 'This event URL is already taken.'}</p>
                {check.suggestions && check.suggestions.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {check.suggestions.map((s) => (
                      <Button key={s} type="button" size="sm" variant="outline" onClick={() => dispatch({ type: 'UPDATE_BASICS', payload: { slug: s } })}>{s}</Button>
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
              <p className="text-sm text-muted-foreground">Choose an event URL in Basics to see the handle.</p>
            )}
          </div>

          {tooLong && shorter && (
            <div className="flex flex-wrap items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
              <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />
              <div className="flex-1 min-w-[200px] space-y-2">
                <p>Handles can be at most {HANDLE_LABEL_MAX} characters before the domain, and <span className="font-mono">{slug}</span> is {slug.length}. The gathering will get a generated handle unless you use a shorter URL.</p>
                <Button type="button" size="sm" variant="outline" onClick={useShorter}>Use “{shorter}” instead</Button>
              </div>
            </div>
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
            <p><span className="font-medium">Now, while it is a draft:</span> only the identity exists. Nothing about the gathering is written to the network, and a draft can still be deleted completely — identity included.</p>
          </div>
          <div className="flex gap-3">
            <Globe className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p><span className="font-medium">When you publish it:</span> the gathering’s name, dates, description, location and participation rules become public records in its own repository.</p>
          </div>
          <div className="flex gap-3">
            <ScrollText className="h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p><span className="font-medium">When you publish the schedule:</span> each scheduled session becomes a permanent public calendar record. Moving or cancelling one afterwards needs the approvals you set in the Voting step, and leaves a public trace.</p>
          </div>
          <p className="text-muted-foreground">Who voted for what is never published — only counts from at least {state.voting.policyThresholds.feedbackK} voters. Membership lists are never published. Proposals belong to the people who wrote them.</p>

          <div className="flex items-start gap-3 rounded-xl border p-4">
            <Checkbox
              id="identity-ack"
              checked={state.identity.acknowledged}
              onCheckedChange={(checked) => dispatch({ type: 'UPDATE_IDENTITY', payload: { acknowledged: checked === true } })}
            />
            <Label htmlFor="identity-ack" className="text-sm font-normal leading-relaxed cursor-pointer">
              I understand that creating this gathering gives it a public identity, and that publishing it and its schedule creates permanent public records.
            </Label>
          </div>
          {state.validation.identity?.length ? (
            <p className="text-sm text-destructive" role="alert">{state.validation.identity[0]}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

export default IdentityStep;
