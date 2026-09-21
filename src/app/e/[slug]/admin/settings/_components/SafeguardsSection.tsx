'use client'

import * as React from 'react'
import { Select } from '@/components/ui/select'
import { POLICY_THRESHOLD_BOUNDS, type GatheringPolicyThresholds } from '@/lib/events/policy'
import { plural } from '@/lib/format'
import type { Event } from '@/types/event'
import { SectionCard, SaveBar, Field, Toggle } from './SectionCard'
import { useSectionSave, sameValue } from './shared'

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

  const value = { destructiveActionStewards: stewards, feedbackK: k, publishRoles }
  const dirty = !sameValue(value, { destructiveActionStewards: thresholds.destructiveActionStewards, feedbackK: thresholds.feedbackK, publishRoles: thresholds.publishRoles })

  return <SectionCard id="safeguards" title="Safeguards" description="Rules that protect a published program and the people voting on it. They are part of the gathering’s public policy."
    onSubmit={() => save({ policy_thresholds: value }, 'Safeguards saved.')}
    footer={<SaveBar state={state} dirty={dirty} />}>
    <Field label="Approvals to move or cancel a published session" htmlFor="stewards" error={fieldError('destructiveActionStewards')}
      hint={`A published session is a public calendar record people may already rely on. ${stewards === 1 ? 'With 1, any single organizer can move or cancel one.' : `With ${stewards}, no single organizer can do it alone.`}`}>
      <Select id="stewards" value={stewards} onChange={e => setStewards(parseInt(e.target.value, 10))} wrapperClassName="max-w-[220px]" error={!!fieldError('destructiveActionStewards')}>
        {range(POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.min, POLICY_THRESHOLD_BOUNDS.destructiveActionStewards.max).map(n => <option key={n} value={n}>{plural(n, 'organizer')}</option>)}
      </Select>
    </Field>
    <Field label="Fewest voters before a count is shown" htmlFor="feedback-k" error={fieldError('feedbackK')}
      hint={`Vote and feedback results for a session appear only once at least ${plural(k, 'person', 'people')} took part, so no individual choice can be worked out.`}>
      <Select id="feedback-k" value={k} onChange={e => setK(parseInt(e.target.value, 10))} wrapperClassName="max-w-[220px]" error={!!fieldError('feedbackK')}>
        {range(POLICY_THRESHOLD_BOUNDS.feedbackK.min, POLICY_THRESHOLD_BOUNDS.feedbackK.max).map(n => <option key={n} value={n}>{plural(n, 'person', 'people')}</option>)}
      </Select>
    </Field>
    <Toggle id="publish-roles" checked={publishRoles} onChange={setPublishRoles} label="Let hosts and organizers publish their role"
      description="Off by default. When on, a host or organizer may add “I hosted at this gathering” to their public profile. Nobody’s role is published without their own opt-in." />
  </SectionCard>
}
