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
  expect(inPerson.uris).toEqual([{ uri: 'https://schellingpoint.app/e/ethboulder/sessions/abc', name: 'Schelling Point' }])

  const virtual = buildSessionCalendarEvent({
    name: 'Call',
    startsAt: '2026-02-21T16:00:00Z',
    endsAt: '2026-02-21T17:00:00Z',
    customLocation: 'https://meet.jit.si/ethboulder',
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
      custom_location: 'Pearl Street',
      created_at: NOW,
      imported_from: 'schellingpoint-supabase',
      // Fields a row carries that must NOT reach the record:
      ...({ host_name: 'Alice Smith', host_id: 'uuid', venue_id: 'uuid', total_votes: 99 } as object),
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
    place: 'Pearl Street',
    imported: true,
    importedFrom: 'schellingpoint-supabase',
    createdAt: NOW,
  })
  expect(JSON.stringify(record)).not.toMatch(/Alice|host_name|host_id|venue_id|total_votes|uuid|99/)
  expect(() => assertValidRecord(NSID.proposal, record)).not.toThrow()
})
