import { test, expect } from '@playwright/test'
import { NSID, SCHELLINGPOINT_COLLECTIONS } from '../src/lib/atproto/nsids'
import { deterministicRkey, isTid, tid } from '../src/lib/atproto/rkey'
import {
  addressLocation,
  assertNoForeignDid,
  buildCohostRecord,
  buildEndorsementRecord,
  buildEventConfig,
  buildGatheringCalendarEvent,
  buildGatheringRecord,
  buildPolicyRecord,
  buildProposalRecord,
  buildRsvpRecord,
  buildSessionCalendarEvent,
  buildSlotGridRecord,
  buildSlotRecord,
  buildTallyRecord,
  buildTrackRecord,
  buildVenueRecord,
  ForeignDidError,
} from '../src/lib/atproto/records'
import {
  assertNoUnknownFields,
  assertValidRecord,
  isValidRecord,
  lexiconRecordProperties,
  LOADED_LEXICON_IDS,
} from '../src/lib/atproto/validate'

const GATHERING_DID = 'did:plc:z72i7hdynmk6r22z27h6tvur'
const PROPOSER_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz'
const COHOST_DID = 'did:plc:44ybard66vv44zksje25o7dz'
const CID = 'bafyreigdcnuvcw5cwtnfn7tmd3cwmqyaqqfj2yzjvz7sjclp33sdnylmqe'
const GATHERING_URI = `at://${GATHERING_DID}/${NSID.gathering}/self`
const PROPOSAL_REF = { uri: `at://${PROPOSER_DID}/${NSID.proposal}/3lbxyzabc2k2a`, cid: CID }
const EVENT_REF = { uri: `at://${GATHERING_DID}/${NSID.event}/3lbxyzabc2k2b`, cid: CID }
const NOW = '2026-09-14T12:00:00.000Z'

const venueAddress = addressLocation({ name: 'Boulder Theater', street: '2032 14th St', locality: 'Boulder', region: 'CO', postalCode: '80302', country: 'US' })

test('every lexicon under lexicons/ is loaded, including all ten schellingpoint.draft.*', () => {
  for (const nsid of SCHELLINGPOINT_COLLECTIONS) expect(LOADED_LEXICON_IDS).toContain(nsid)
  for (const nsid of [NSID.event, NSID.rsvp, NSID.eventConfig, NSID.policy, NSID.approval, NSID.locationAddress]) {
    expect(LOADED_LEXICON_IDS).toContain(nsid)
  }
})

test('builders produce lexicon-valid records', () => {
  const records: Array<[string, object]> = [
    [
      NSID.gathering,
      buildGatheringRecord({
        name: 'EthBoulder 2026',
        description: 'An unconference.',
        region: 'Boulder, CO',
        startsAt: '2026-02-20T16:00:00Z',
        endsAt: '2026-02-22T23:00:00Z',
        event: EVENT_REF,
        phase: 'proposals',
        policy: `at://${GATHERING_DID}/${NSID.policy}/3lbxyzabc2k2c`,
        handleDomain: 'ethboulder.schellingpoint.app',
        website: 'https://ethboulder.xyz',
        peers: ['did:plc:cohere4bard66vv44zksje25'],
        tags: ['Skillshare', 'ethereum'],
        createdAt: NOW,
      }),
    ],
    [
      NSID.event,
      buildGatheringCalendarEvent({
        name: 'EthBoulder 2026',
        description: 'Three days.',
        startsAt: '2026-02-20T16:00:00Z',
        endsAt: '2026-02-22T23:00:00Z',
        locations: [venueAddress],
        uris: [{ uri: 'https://schellingpoint.app/e/ethboulder', name: 'Schelling Point' }],
        createdAt: NOW,
      }),
    ],
    [
      NSID.policy,
      buildPolicyRecord({
        title: 'EthBoulder rules',
        version: '1',
        effectiveAt: NOW,
        createdAt: NOW,
        config: { votingMechanism: 'quadratic', creditsPerVoter: 100, requireProposalApproval: false, allowedFormats: ['talk', 'workshop'] },
      }),
    ],
    [NSID.venue, buildVenueRecord({ name: 'Main Hall', slug: 'main-hall', capacity: 200, features: ['projector', ' mic '], style: 'theater', primary: true, locations: [venueAddress], createdAt: NOW })],
    [NSID.track, buildTrackRecord({ name: 'Regen', slug: 'regen', color: '#00aa55', displayOrder: 1, active: true, createdAt: NOW })],
    [
      NSID.slotGrid,
      buildSlotGridRecord({
        gathering: GATHERING_URI,
        venue: `at://${GATHERING_DID}/${NSID.venue}/3lbxyzabc2k2d`,
        day: '2026-02-21',
        timezone: 'America/Denver',
        slots: [
          { startsAt: '2026-02-21T17:00:00Z', endsAt: '2026-02-21T17:30:00Z', label: 'Coffee', kind: 'break' },
          { startsAt: '2026-02-21T16:00:00Z', endsAt: '2026-02-21T17:00:00Z', label: 'Block A' },
        ],
        createdAt: NOW,
      }),
    ],
    [
      NSID.event,
      buildSessionCalendarEvent({
        name: 'Quadratic funding in practice',
        description: 'Public description.',
        startsAt: '2026-02-21T16:00:00Z',
        endsAt: '2026-02-21T17:00:00Z',
        venueAddress,
        sessionUrl: 'https://schellingpoint.app/e/ethboulder/sessions/abc',
        createdAt: NOW,
      }),
    ],
    [NSID.eventConfig, buildEventConfig({ event: EVENT_REF, timezone: 'America/Denver', capacity: 200, gatheringDid: GATHERING_DID, tags: ['ethereum'], createdAt: NOW })],
    [NSID.slot, buildSlotRecord({ gathering: GATHERING_URI, event: EVENT_REF, proposal: PROPOSAL_REF, startsAt: '2026-02-21T16:00:00Z', endsAt: '2026-02-21T17:00:00Z', createdAt: NOW })],
    [
      NSID.proposal,
      buildProposalRecord({
        gatheringUri: GATHERING_URI,
        session: { title: 'Quadratic funding in practice', description: 'Hands on.', format: 'workshop', duration: 60, topic_tags: ['qf', 'public goods'], expected_attendance: 40, required_features: ['projector'], created_at: NOW },
      }),
    ],
    [NSID.cohost, buildCohostRecord({ proposal: PROPOSAL_REF, role: 'facilitator', displayOrder: 1, createdAt: NOW })],
    [NSID.endorsement, buildEndorsementRecord({ proposal: PROPOSAL_REF, note: 'Please run this.', createdAt: NOW })],
    [NSID.rsvp, buildRsvpRecord({ subject: EVENT_REF, status: 'going' })],
    [
      NSID.tally,
      buildTallyRecord({
        gathering: GATHERING_URI,
        round: 'pre-event',
        mechanism: 'quadratic',
        creditsPerVoter: 100,
        ballotsCast: 12,
        k: 3,
        entries: [{ proposal: PROPOSAL_REF, voters: 5, votes: 9, credits: 25 }],
        closedAt: NOW,
        createdAt: NOW,
      }),
    ],
  ]
  for (const [nsid, record] of records) {
    expect((record as { $type: string }).$type, `${nsid} $type`).toBe(nsid)
    expect(() => assertValidRecord(nsid, record), nsid).not.toThrow()
    expect(isValidRecord(nsid, record)).toBe(true)
  }
  // Builders drop empties and normalise: no undefined keys, features trimmed, slots sorted.
  const venue = records[3][1] as { features: string[] }
  expect(venue.features).toEqual(['projector', 'mic'])
  const grid = records[5][1] as { slots: Array<{ label: string; kind: string }> }
  expect(grid.slots.map((s) => s.label)).toEqual(['Block A', 'Coffee'])
  expect(grid.slots[0].kind).toBe('session')
  for (const [, record] of records) expect(Object.values(record)).not.toContain(undefined)
})

test('validation rejects a record that violates its lexicon', () => {
  expect(isValidRecord(NSID.proposal, { $type: NSID.proposal, gathering: GATHERING_URI, title: 'x', format: 'talk', durationMinutes: 2, createdAt: NOW })).toBe(false)
  expect(isValidRecord(NSID.cohost, { $type: NSID.cohost, proposal: { uri: PROPOSAL_REF.uri }, createdAt: NOW })).toBe(false)
  expect(() => assertValidRecord(NSID.tally, { $type: NSID.tally, gathering: GATHERING_URI })).toThrow(/tally record is invalid/)
})

test('deterministicRkey is stable and 13 chars of a-z2-7', () => {
  const a = deterministicRkey(PROPOSAL_REF.uri, '2026-02-21T16:00:00Z')
  expect(a).toMatch(/^[a-z2-7]{13}$/)
  expect(deterministicRkey(PROPOSAL_REF.uri, '2026-02-21T16:00:00Z')).toBe(a)
  expect(deterministicRkey(PROPOSAL_REF.uri, '2026-02-21T17:00:00Z')).not.toBe(a)
  expect(deterministicRkey('a', 'bc')).not.toBe(deterministicRkey('ab', 'c'))
  expect(() => deterministicRkey()).toThrow()
})

test('tid() is monotonic and 13 chars', () => {
  let prev = tid()
  expect(prev).toHaveLength(13)
  expect(isTid(prev)).toBe(true)
  for (let i = 0; i < 2000; i++) {
    const next = tid()
    expect(next).toHaveLength(13)
    expect(next > prev).toBe(true)
    prev = next
  }
})

test('assertNoForeignDid rejects a proposal that smuggles a cohost DID', () => {
  const clean = buildProposalRecord({
    gatheringUri: GATHERING_URI,
    session: { title: 'A session', format: 'talk', duration: 30, created_at: NOW },
  })
  expect(() => assertNoForeignDid(clean, PROPOSER_DID, { gatheringDid: GATHERING_DID })).not.toThrow()

  // Smuggled as an extra field...
  expect(() => assertNoForeignDid({ ...clean, cohost: COHOST_DID }, PROPOSER_DID)).toThrow(ForeignDidError)
  // ...in an array...
  expect(() => assertNoForeignDid({ ...clean, cohosts: [COHOST_DID] }, PROPOSER_DID)).toThrow(/R9/)
  // ...or buried in free text.
  expect(() => assertNoForeignDid({ ...clean, description: `with ${COHOST_DID} as cohost` }, PROPOSER_DID)).toThrow(ForeignDidError)
  // The author's own DID is fine anywhere.
  expect(() => assertNoForeignDid({ ...clean, author: PROPOSER_DID }, PROPOSER_DID)).not.toThrow()
})

test('assertNoForeignDid allows the gathering DID only where the spec says', () => {
  const cfg = buildEventConfig({ event: EVENT_REF, gatheringDid: GATHERING_DID, createdAt: NOW })
  expect(() => assertNoForeignDid(cfg, GATHERING_DID, { gatheringDid: GATHERING_DID })).not.toThrow()
  // A config written by a proposer may still name the gathering in `school`.
  expect(() => assertNoForeignDid(cfg, PROPOSER_DID, { gatheringDid: GATHERING_DID })).not.toThrow()
  // ...but not some other DID in `school`.
  expect(() => assertNoForeignDid({ ...cfg, school: COHOST_DID }, PROPOSER_DID, { gatheringDid: GATHERING_DID })).toThrow(ForeignDidError)
  // Peers are organisations; a gathering may list them.
  const gathering = buildGatheringRecord({ name: 'G', peers: ['did:plc:cohere4bard66vv44zksje25'], createdAt: NOW })
  expect(() => assertNoForeignDid(gathering, GATHERING_DID)).not.toThrow()
  // At-URI references to other people's records are references, not claims.
  const cohost = buildCohostRecord({ proposal: PROPOSAL_REF, createdAt: NOW })
  expect(() => assertNoForeignDid(cohost, COHOST_DID)).not.toThrow()
})

test('tally k-suppression hides counts under k', () => {
  const low = { uri: `at://${PROPOSER_DID}/${NSID.proposal}/3lbxyzabc2k2e`, cid: CID }
  const tally = buildTallyRecord({
    gathering: GATHERING_URI,
    round: 'pre-event',
    mechanism: 'quadratic',
    k: 3,
    entries: [
      { proposal: PROPOSAL_REF, voters: 3, votes: 4, credits: 10 },
      { proposal: low, voters: 2, votes: 40, credits: 1600 },
    ],
    closedAt: NOW,
    createdAt: NOW,
  })
  expect(() => assertValidRecord(NSID.tally, tally)).not.toThrow()
  expect(tally.entries).toHaveLength(2)
  expect(tally.entries![0]).toEqual({ proposal: PROPOSAL_REF, suppressed: false, voters: 3, votes: 4, credits: 10 })
  expect(tally.entries![1]).toEqual({ proposal: low, suppressed: true })
  expect(Object.keys(tally.entries![1])).toEqual(['proposal', 'suppressed'])
  expect(JSON.stringify(tally)).not.toContain('1600')
  expect(() => buildTallyRecord({ ...tally, k: 0, entries: [], round: 'pre-event', mechanism: 'quadratic' })).toThrow(/positive integer/)
})

test('buildSessionCalendarEvent emits only fields community.lexicon.calendar.event defines', () => {
  const allowed = new Set(lexiconRecordProperties(NSID.event))
  expect(allowed).toEqual(new Set(['$type', 'name', 'description', 'createdAt', 'startsAt', 'endsAt', 'mode', 'status', 'locations', 'uris', 'rsvpExpected']))

  const inPerson = buildSessionCalendarEvent({
    name: 'Talk',
    description: 'Public only.',
    startsAt: '2026-02-21T16:00:00Z',
    endsAt: '2026-02-21T17:00:00Z',
    venueAddress,
    sessionUrl: 'https://schellingpoint.app/e/ethboulder/sessions/abc',
    createdAt: NOW,
  })
  for (const key of Object.keys(inPerson)) expect(allowed, key).toContain(key)
  expect(() => assertNoUnknownFields(NSID.event, inPerson)).not.toThrow()
  expect(() => assertNoUnknownFields(NSID.event, { ...inPerson, voteCount: 12 })).toThrow(/voteCount/)
  expect(inPerson.mode).toBe(`${NSID.event}#inperson`)
  expect(inPerson.status).toBe(`${NSID.event}#scheduled`)
  expect(inPerson.locations).toEqual([venueAddress])
  expect(inPerson.uris).toEqual([{ uri: 'https://schellingpoint.app/e/ethboulder/sessions/abc', name: 'Session page' }])

  const virtual = buildSessionCalendarEvent({
    name: 'Call',
    startsAt: '2026-02-21T16:00:00Z',
    endsAt: '2026-02-21T17:00:00Z',
    virtual: true,
    venueAddress,
    cancelled: true,
    sessionUrl: 'https://schellingpoint.app/e/ethboulder/sessions/def',
    createdAt: NOW,
  })
  expect(virtual.mode).toBe(`${NSID.event}#virtual`)
  expect(virtual.status).toBe(`${NSID.event}#cancelled`)
  expect(virtual.locations).toBeUndefined()
  expect(virtual.description).toBeUndefined()
  expect(() => assertValidRecord(NSID.event, virtual)).not.toThrow()

  // The borrowed rsvp lexicon has exactly two fields; we add nothing.
  expect(Object.keys(buildRsvpRecord({ subject: EVENT_REF, status: 'interested' })).sort()).toEqual(['$type', 'status', 'subject'])
})

test('buildProposalRecord never carries host, cohost or schedule fields', () => {
  const record = buildProposalRecord({
    gatheringUri: GATHERING_URI,
    trackUri: `at://${GATHERING_DID}/${NSID.track}/3lbxyzabc2k2f`,
    session: {
      title: 'Self-hosted meetup',
      format: 'discussion',
      duration: 90,
      is_self_hosted: true,
      self_hosted_start_time: '2026-02-21T20:00:00Z',
      self_hosted_end_time: '2026-02-21T21:30:00Z',
      public_place: 'Near Pearl Street',
      created_at: NOW,
      imported_from: 'schellingpoint-supabase',
      // Fields a row carries that must NOT reach the record:
      ...({ host_name: 'Alice Smith', host_id: 'uuid', venue_id: 'uuid', total_votes: 99, custom_location: '1234 Secret Lane' } as object),
    },
  })
  expect(record).toEqual({
    $type: NSID.proposal,
    gathering: GATHERING_URI,
    title: 'Self-hosted meetup',
    format: 'discussion',
    durationMinutes: 90,
    track: `at://${GATHERING_DID}/${NSID.track}/3lbxyzabc2k2f`,
    selfHosted: true,
    startsAt: '2026-02-21T20:00:00.000Z',
    endsAt: '2026-02-21T21:30:00.000Z',
    place: 'Near Pearl Street',
    imported: true,
    importedFrom: 'schellingpoint-supabase',
    createdAt: NOW,
  })
  expect(JSON.stringify(record)).not.toMatch(/Alice|host_name|host_id|venue_id|total_votes|uuid|99|Secret|1234/)
  expect(() => assertValidRecord(NSID.proposal, record)).not.toThrow()
})

/* ───────────────────────── wave 1: F additions ───────────────────────── */

import {
  buildApprovalRecord,
  buildListingRecord,
  buildMembershipRecord,
  buildOccurrenceRecord,
  buildSeriesRecord,
  buildTimePreferenceRecord,
  decideListingEdit,
  membershipClaimRkey,
  normalizeTags,
  routesOnTags,
  rruleFor,
  venueLocation,
} from '../src/lib/atproto/records'

test('a self-hosted session’s exact address never reaches the proposal or the calendar event', () => {
  const exact = '1234 Secret Lane, Apt 5, Boulder CO 80302'
  // The builder takes no exact-address input at all; a row that carries one leaks nothing.
  const row = {
    title: 'Kitchen table cryptography',
    format: 'workshop',
    duration: 60,
    is_self_hosted: true,
    self_hosted_start_time: '2026-02-21T20:00:00Z',
    self_hosted_end_time: '2026-02-21T21:00:00Z',
    created_at: NOW,
    ...({ custom_location: exact } as object),
  }
  const withoutLabel = buildProposalRecord({ gatheringUri: GATHERING_URI, session: row })
  expect(withoutLabel.place).toBeUndefined()
  const withLabel = buildProposalRecord({ gatheringUri: GATHERING_URI, session: { ...row, public_place: 'North Boulder' } })
  expect(withLabel.place).toBe('North Boulder')
  const event = buildSessionCalendarEvent({
    name: row.title,
    startsAt: row.self_hosted_start_time,
    endsAt: row.self_hosted_end_time,
    venueAddress: null,
    sessionUrl: 'https://unconference.events/e/demo/sessions/x',
    createdAt: NOW,
  })
  for (const record of [withoutLabel, withLabel, event]) {
    const json = JSON.stringify(record)
    for (const part of ['1234', 'Secret', 'Apt 5', '80302']) expect(json).not.toContain(part)
  }
})

test('venueLocation coarsens a private residence to its locality', () => {
  const home = venueLocation({ name: 'Sam’s living room', street: '77 Maple Ave', locality: 'Whittier', region: 'CO', postalCode: '80205', country: 'US', privateResidence: true })
  expect(home).toEqual({ $type: NSID.locationAddress, country: 'US', locality: 'Whittier', region: 'CO' })
  expect(JSON.stringify(home)).not.toMatch(/Maple|80205|Sam/)
  expect(venueLocation({ street: '77 Maple Ave', privateResidence: true })).toBeNull()
  const hall = venueLocation({ name: 'Main Hall', street: '2032 14th St', locality: 'Boulder', country: 'US' })
  expect(hall?.street).toBe('2032 14th St')
  expect(() => assertValidRecord(NSID.venue, buildVenueRecord({ name: 'Home', locations: [home!], createdAt: NOW }))).not.toThrow()
})

test('listing, membership, approval, time preference and series records are valid and name no one', () => {
  const listing = buildListingRecord({ event: EVENT_REF, gatheringDid: GATHERING_DID, tags: ['Skill Share', 'skill share', 'regen'], createdAt: NOW })
  expect(listing.tags).toEqual(['skill-share', 'regen'])
  expect(() => assertValidRecord(NSID.eventListing, listing)).not.toThrow()
  expect(() => assertNoUnknownFields(NSID.eventListing, listing)).not.toThrow()
  expect(() => assertNoForeignDid(listing, GATHERING_DID, { gatheringDid: GATHERING_DID })).not.toThrow()
  expect(() => buildListingRecord({ event: { uri: EVENT_REF.uri, cid: '' }, gatheringDid: GATHERING_DID, createdAt: NOW })).toThrow(/uri and cid/)

  const claim = buildMembershipRecord({ subjectDid: PROPOSER_DID, role: 20, gatheringDid: GATHERING_DID, createdAt: NOW })
  expect(() => assertValidRecord(NSID.membership, claim)).not.toThrow()
  expect(() => assertNoForeignDid(claim, GATHERING_DID, { gatheringDid: GATHERING_DID })).toThrow(ForeignDidError)
  expect(() => assertNoForeignDid(claim, GATHERING_DID, { gatheringDid: GATHERING_DID, consentedSubjectDid: PROPOSER_DID })).not.toThrow()
  expect(() => assertNoForeignDid({ ...claim, note: COHOST_DID }, GATHERING_DID, { gatheringDid: GATHERING_DID, consentedSubjectDid: PROPOSER_DID })).toThrow(ForeignDidError)
  const rkey = membershipClaimRkey(GATHERING_DID, PROPOSER_DID)
  expect(rkey).toMatch(/^[a-z2-7]{13}$/)
  expect(membershipClaimRkey(GATHERING_DID, PROPOSER_DID)).toBe(rkey)
  expect(membershipClaimRkey(GATHERING_DID, COHOST_DID)).not.toBe(rkey)

  const approval = buildApprovalRecord({ proposal: `at://${GATHERING_DID}/${NSID.slot}/3lbxyzabc2k2z`, action: 'other', subjectRecord: EVENT_REF.uri, reason: 'Speaker flight delayed', createdAt: NOW })
  expect(() => assertValidRecord(NSID.approval, approval)).not.toThrow()
  expect(() => assertNoUnknownFields(NSID.approval, approval)).not.toThrow()
  expect(approval).not.toHaveProperty('subjectDid')
  expect(() => assertNoForeignDid(approval, COHOST_DID)).not.toThrow()

  const pref = buildTimePreferenceRecord({
    proposal: PROPOSAL_REF,
    windows: [{ startsAt: '2026-02-21T16:00:00Z', endsAt: '2026-02-21T18:00:00Z', preference: 1 }],
    blackouts: [{ startsAt: '2026-02-22T16:00:00Z', endsAt: '2026-02-22T23:00:00Z' }],
    createdAt: NOW,
  })
  expect(pref.windows![0]!.startsAt).toBe('2026-02-21T16:00:00.000Z')
  expect(() => assertValidRecord(NSID.timePreference, pref)).not.toThrow()

  expect(rruleFor({ freq: 'weekly', interval: 2, byDay: ['TU'], count: 8 })).toBe('FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=8')
  expect(() => rruleFor({ freq: 'weekly', count: 2, until: NOW })).toThrow(/count or until/)
  const series = buildSeriesRecord({ firstEvent: EVENT_REF, freq: 'monthly', timezone: 'America/Denver', until: '2027-01-01T00:00:00Z', createdAt: NOW })
  expect(series.rrule).toBe('FREQ=MONTHLY;UNTIL=20270101T000000Z')
  expect(() => assertValidRecord(NSID.series, series)).not.toThrow()
  expect(() => assertNoUnknownFields(NSID.series, series)).not.toThrow()
  const occurrence = buildOccurrenceRecord({ event: EVENT_REF, series: { uri: `at://${GATHERING_DID}/${NSID.series}/3lbxyzabc2k2y`, cid: CID }, originalStartsAt: NOW, sequence: 2, createdAt: NOW })
  expect(() => assertValidRecord(NSID.occurrence, occurrence)).not.toThrow()
})

test('listing routing: tags intersect, removal is sticky, a changed event re-pins', () => {
  expect(normalizeTags([' Free School ', 'free-school', '', null, 'X'.repeat(80)])).toEqual(['free-school', 'x'.repeat(64)])
  expect(routesOnTags(['Skillshare'], ['skillshare', 'regen'])).toBe(true)
  expect(routesOnTags(['ethereum'], ['skillshare'])).toBe(false)
  expect(routesOnTags(['ethereum'], [])).toBe(false)
  expect(decideListingEdit({ everListed: false, isActivelyListed: false, routesNow: true })).toBe('create')
  expect(decideListingEdit({ everListed: true, isActivelyListed: false, routesNow: true })).toBe('none')
  expect(decideListingEdit({ everListed: true, isActivelyListed: true, routesNow: false })).toBe('remove')
  expect(decideListingEdit({ everListed: true, isActivelyListed: true, routesNow: true, cidChanged: true })).toBe('update')
  expect(decideListingEdit({ everListed: false, isActivelyListed: false, routesNow: false })).toBe('none')
})

test('the default policy needs two organisers for a destructive change', () => {
  const policy = buildPolicyRecord({ title: 'Rules', version: '1', effectiveAt: NOW, createdAt: NOW })
  expect(policy.thresholds).toMatchObject({ destructiveActionStewards: 2, feedbackK: 3, publishRoles: false })
  expect(policy.text).toContain('requires 2 organiser approval(s)')
})

import { expandRecurrence } from '../src/lib/atproto/recurrence'

test('recurrence keeps wall-clock time across DST, honours count, until, exdates and short months', () => {
  const tz = 'America/Denver'
  // Monday 19 Oct 2026 18:00 MDT; US DST ends 1 Nov 2026.
  const weekly = expandRecurrence('2026-10-20T00:00:00Z', { freq: 'weekly', count: 3, timezone: tz }, '2027-01-01T00:00:00Z')
  expect(weekly).toEqual([
    { sequence: 1, startsAt: '2026-10-20T00:00:00.000Z' },
    { sequence: 2, startsAt: '2026-10-27T00:00:00.000Z' },
    { sequence: 3, startsAt: '2026-11-03T01:00:00.000Z' },
  ])
  const skipped = expandRecurrence('2026-10-20T00:00:00Z', { freq: 'weekly', count: 3, exdates: ['2026-10-27T00:00:00Z'], timezone: tz }, '2027-01-01T00:00:00Z')
  expect(skipped.map((o) => o.sequence)).toEqual([1, 3])
  const twiceWeekly = expandRecurrence('2026-10-20T00:00:00Z', { freq: 'weekly', byDay: ['MO', 'TH'], until: '2026-10-31T00:00:00Z', timezone: tz }, '2027-01-01T00:00:00Z')
  expect(twiceWeekly.map((o) => o.startsAt)).toEqual(['2026-10-20T00:00:00.000Z', '2026-10-23T00:00:00.000Z', '2026-10-27T00:00:00.000Z', '2026-10-30T00:00:00.000Z'])
  const monthly = expandRecurrence('2027-01-31T17:00:00Z', { freq: 'monthly', count: 3, timezone: tz }, '2028-01-01T00:00:00Z')
  expect(monthly.map((o) => o.startsAt.slice(0, 10))).toEqual(['2027-01-31', '2027-03-31', '2027-05-31'])
  const horizon = expandRecurrence('2026-10-20T00:00:00Z', { freq: 'daily', interval: 2, timezone: tz }, '2026-10-25T00:00:00Z')
  expect(horizon).toHaveLength(3)
  expect(() => expandRecurrence(NOW, { freq: 'daily', count: 2, until: NOW, timezone: tz }, NOW)).toThrow(/count or until/)
})
