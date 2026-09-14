import { test, expect } from '@playwright/test'
import { safeReturnPath } from '../src/lib/auth-redirect'
import { votesToCredits, nextVoteCost } from '../src/lib/utils'

test('sign-in keeps local event destinations and their filters', () => {
  expect(safeReturnPath('/e/community/sessions?track=learning')).toBe('/e/community/sessions?track=learning')
  expect(safeReturnPath('/create')).toBe('/create')
})

test('sign-in rejects external and executable destinations', () => {
  for (const value of ['https://example.com', '//example.com', '/\\example.com', 'javascript:alert(1)', '/\n/example.com', '', null, undefined]) {
    expect(safeReturnPath(value)).toBe('/')
  }
})

test('onboarding examples match quadratic voting costs', () => {
  expect([1, 2, 3].map(n => votesToCredits(n, 'quadratic'))).toEqual([1, 4, 9])
  expect([0, 1, 2].map(n => nextVoteCost(n, 'quadratic'))).toEqual([1, 3, 5])
})

import { accessiblePrimary, hexToHslValues, getContrastingForeground } from '../src/lib/utils/color'

test('event theme supports short hex colors and readable primary shades', () => {
  expect(hexToHslValues('#fff')).toBe('0 0% 100%')
  expect(hexToHslValues('#0f0')).toBe('120 100% 50%')
  expect(getContrastingForeground('#fff')).toBe('0 0% 0%')
  expect(getContrastingForeground('#000')).toBe('0 0% 100%')
  expect(accessiblePrimary('#246653', false)).toBe('#246653')
  for (const dark of [false, true]) {
    for (const color of ['#B2FF00', '#fff', '#000', '#DCD5ED', '#246653']) {
      const result = accessiblePrimary(color, dark)
      const luminance = (hex: string) => {
        const rgb = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
      }
      const a = luminance(result), b = luminance(dark ? '#161d1b' : '#f7f9f8')
      expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toBeGreaterThanOrEqual(4.5)
    }
  }
})

import { formatCalendarDate, getEventDays, getEventDayLabel } from '../src/lib/events/dates'
test('calendar dates remain the selected day in the display', () => {
  expect(formatCalendarDate('2026-10-16', { month: 'long', day: 'numeric', year: 'numeric' })).toBe('October 16, 2026')
  expect(formatCalendarDate(new Date('2026-02-27'), { month: 'short', day: 'numeric' })).toBe('Feb 27')
})


test('event day filters preserve calendar boundaries across daylight saving', () => {
  expect(getEventDays(new Date('2026-03-07'), new Date('2026-03-09'))).toEqual(['2026-03-07', '2026-03-08', '2026-03-09'])
  expect(getEventDayLabel('2026-10-16', 'America/Denver')).toBe('Fri, Oct 16')
})
