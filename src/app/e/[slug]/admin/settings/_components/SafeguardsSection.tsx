'use client'

import * as React from 'react'
import { POLICY_THRESHOLD_BOUNDS, type GatheringPolicyThresholds } from '@/lib/events/policy'
import type { Event } from '@/types/event'
import { SectionCard, SaveBar, Field, Toggle } from './SectionCard'
import { useSectionSave } from './shared'

const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i)

/** Policy thresholds (`freeschool.draft.policy#thresholds`), public once the gathering is published. */
export function SafeguardsSection({ event, thresholds }: { event: Event; thresholds: GatheringPolicyThresholds }) {
  const { state, save } = useSectionSave(event.id)
  const [stewards, setStewards] = React.useState(thresholds.destructiveActionStewards)
  const [k, setK] = React.useState(thresholds.feedbackK)
  const [publishRoles, setPublishRoles] = React.useState(thresholds.publishRoles)
  const fieldError = (field: string) => (state.status === 'error' && (state.field === field || state.field === `policy_thresholds.${field}`) ? state.message : null)

  React.useEffect(() => {
    setStewards(thresholds.destructiveActionStewards); setK(thresholds.feedbackK); setPublishRoles(thresholds.publishRoles)
  }, [thresholds.destructiveActionStewards, thresholds.feedbackK, thresholds.publishRoles])

  return <SectionCard id="safeguards" title="Safeguards" description="Rules that protect a published program and the people voting on it. They are part of the gathering’s public policy."
    onSubmit={() => save({ policy_thresholds: { destructiveActionStewards: stewards, feedbackK: k, publishRoles } }, 'Safeguards saved.')}
    footer={<SaveBar state={state} />}>
    <Field label="Approvals to move or cancel a published session" htmlFor="stewards" error={fieldError('destructiveActionStewards')}
      hint={`A published session is a public calendar record people may already rely on. ${stewards === 1 ? 'With 1, any single organizer can move or cancel one.' : `With ${stewards}, no single organizer can do it alone.`}`}>
      <select id="stewards" value={stewards} onChange={e => setStewards(parseInt(e.target.value, 10))} className="w-full max-w-[220px] rounded-xl border bg-background p-3 text-sm">
        {range(POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.min, POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.max).map(n => <option key={n} value={n}>{n} organizer{n === 1 ? '' : 's'}</option>)}
      </select>
    </Field>
    <Field label="Fewest voters before a count is shown" htmlFor="feedback-k" error={fieldError('feedbackK')}
      hint={`Vote and feedback results for a session appear only once at least ${k} people took part, so no individual choice can be worked out.`}>
      <select id="feedback-k" value={k} onChange={e => setK(parseInt(e.target.value, 10))} className="w-full max-w-[220px] rounded-xl border bg-background p-3 text-sm">
        {range(POLICY_THRESHOLD_BOUNDS.feedbackK.min, POLICY_THRESHOLD_BOUNDS.feedbackK.max).map(n => <option key={n} value={n}>{n} people</option>)}
      </select>
    </Field>
    <Toggle id="publish-roles" checked={publishRoles} onChange={setPublishRoles} label="Let hosts and organizers publish their role"
      description="Off by default. When on, a host or organizer may add “I hosted at this gathering” to their public profile. Nobody’s role is published without their own opt-in." />
  </SectionCard>
}
