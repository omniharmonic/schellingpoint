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


import { addressIsPlaced, addressLine, geocodeParams } from '../src/lib/geo/coarse'
import { directionsHref } from '../src/lib/geo/directions'

// A street line on its own matches whichever same-named street a geocoder ranks first, anywhere
// in the world — an organizer's Boulder venue arrived in Falls Church, Virginia. The city, region
// and postal code have to be sent as Nominatim's structured parameters, where they constrain the
// match, and never squeezed into `q` alongside it (Nominatim refuses that combination outright).
test('a room address is geocoded by its parts, not by its street line', () => {
  const boulder = { street: '1500 Pearl St', locality: 'Boulder', region: 'CO', postalCode: '80302', country: 'US' }
  expect(addressLine(boulder)).toBe('1500 Pearl St, Boulder, CO, 80302, US')

  const params = geocodeParams(boulder)
  expect(Object.fromEntries(params)).toEqual({ street: '1500 Pearl St', city: 'Boulder', state: 'CO', postalcode: '80302', country: 'US' })
  expect(params.has('q')).toBe(false)

  // Missing parts are left out rather than sent empty, and whitespace is tidied.
  expect(Object.fromEntries(geocodeParams({ street: '  1500   Pearl St ', locality: 'Boulder', region: '', postalCode: null })))
    .toEqual({ street: '1500 Pearl St', city: 'Boulder' })

  // Free text (an address somebody typed) stays a `q` search, normalized the way the cache keys it.
  expect(Object.fromEntries(geocodeParams('  Pearl Street   Mall, Boulder '))).toEqual({ q: 'pearl street mall, boulder' })

  // A street with no city, region or postal code is not a place: it is asked as free text instead.
  expect(addressIsPlaced({ street: '1500 Pearl St' })).toBe(false)
  expect(addressIsPlaced(boulder)).toBe(true)
  expect(addressIsPlaced({ postalCode: '80302' })).toBe(true)
})

// "Get directions" carries the address the organizer wrote whenever there is one: a pin is only
// as good as the lookup that placed it, while every maps app resolves a written address itself.
test('directions carry the whole address, and fall back to a point only without one', () => {
  const full = '1500 Pearl St, Boulder, CO, 80302, US'
  expect(directionsHref({ query: full, lat: 38.88, lng: -77.17 }))
    .toBe(`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(full)}`)

  // A self-hosted session with a pin and no address: coordinates are all there is.
  expect(directionsHref({ lat: 40.0176, lng: -105.2797 }))
    .toBe('https://www.google.com/maps/dir/?api=1&destination=40.0176,-105.2797')

  // Nothing to point at, no link.
  expect(directionsHref({})).toBeNull()
  expect(directionsHref({ query: '   ', lat: null, lng: null })).toBeNull()
  // A half-point is not a point.
  expect(directionsHref({ lat: 40.0176, lng: null })).toBeNull()
})
