import { test, expect } from '@playwright/test'
import { INITIAL_STATE } from '../src/app/create/useWizardState'
import { validateWizardState } from '../src/lib/events/validate-creation'
import { saveWizardDraft, loadWizardDraft } from '../src/app/create/useWizardPersistence'

function validDraft() {
  const draft = structuredClone(INITIAL_STATE)
  draft.basics.name = 'Test gathering'
  draft.basics.slug = 'test-gathering'
  draft.dates.startDate = '2026-10-16'
  draft.dates.endDate = '2026-10-17'
  draft.dates.timezone = 'America/Denver'
  return draft
}

test('malformed creation payloads return validation errors instead of crashing', () => {
  for (const payload of [null, {}, { basics: {} }, { ...validDraft(), venues: null }]) {
    let result: { valid: boolean } | undefined
    expect(() => { result = validateWizardState(payload as never) }).not.toThrow()
    expect(result?.valid).toBe(false)
  }
})

test('reject invalid dates, fractional credits and unavailable schedule rooms', () => {
  const invalidDate = validDraft(); invalidDate.dates.startDate = '2026-02-31'
  const credits = validDraft(); credits.voting.credits = 2.5
  const room = validDraft(); room.schedule.timeSlots = [{ id: 'slot', venueId: 'missing', dayDate: '2026-10-16', startTime: '09:00', endTime: '10:00', isBreak: false, label: '' }]
  for (const draft of [invalidDate, credits, room]) expect(validateWizardState(draft).valid).toBe(false)
})

test('schedule stays inside event dates with positive duration and no room overlap', () => {
  const base = validDraft()
  base.venues = [{ id: 'room', name: 'Main room', capacity: 40, features: [], address: '' }]
  const slot = { id: 'a', venueId: 'room', dayDate: '2026-10-16', startTime: '09:00', endTime: '10:00', isBreak: false, label: '' }
  for (const slots of [[{...slot, dayDate: '2026-10-18'}], [{...slot, endTime:'08:00'}], [slot, {...slot,id:'b',startTime:'09:30'}]]) {
    expect(validateWizardState({...base, schedule:{timeSlots:slots}}).valid).toBe(false)
  }
  expect(validateWizardState({...base,schedule:{timeSlots:[slot]}}).valid).toBe(true)
})

test('saved drafts retain organizer topics through a reload', () => {
  const data = new Map<string, string>()
  const storage = { setItem: (key: string, value: string) => data.set(key,value), getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => data.delete(key) }
  Object.defineProperty(globalThis, 'window', { value: {localStorage:storage}, configurable:true })
  try {
    const draft = validDraft(); draft.suggestedTopics = ['Community', 'Ecology']
    saveWizardDraft(draft)
    expect(loadWizardDraft()?.suggestedTopics).toEqual(['Community','Ecology'])
  } finally { Reflect.deleteProperty(globalThis,'window') }
})

import { parseTimeInTimezone } from '../src/lib/events/timezone'
test('schedule conversion respects event timezone on DST changes and UTC+14', () => {
  expect(parseTimeInTimezone('09:00','2026-03-08','America/Denver').toISOString()).toBe('2026-03-08T15:00:00.000Z')
  expect(parseTimeInTimezone('09:00','2026-11-01','America/Denver').toISOString()).toBe('2026-11-01T16:00:00.000Z')
  expect(parseTimeInTimezone('09:00','2026-10-16','Pacific/Kiritimati').toISOString()).toBe('2026-10-15T19:00:00.000Z')
})

import { requireSavedRows } from '../src/lib/api/saved-rows'
test('a denied or empty mutation never reports success', async () => {
  await expect(requireSavedRows(new Response('[]',{status:200}))).rejects.toThrow('Nothing was changed')
  await expect(requireSavedRows(new Response('{}',{status:403}))).rejects.toThrow('permission')
  expect(await requireSavedRows(new Response('[{"id":"room"}]',{status:200}))).toEqual([{id:'room'}])
})

import { isParticipationOpen } from '../src/lib/events/lifecycle'
test('participation requires its phase and respects opening and closing boundaries', () => {
  const now = new Date('2026-10-16T15:00:00Z')
  expect(isParticipationOpen({status:'published'},'vote',now)).toBe(false)
  expect(isParticipationOpen({status:'proposals_open'},'propose',now)).toBe(true)
  expect(isParticipationOpen({status:'voting_open',votingOpensAt:now},'vote',now)).toBe(true)
  expect(isParticipationOpen({status:'voting_open',votingClosesAt:now},'vote',now)).toBe(false)
})
