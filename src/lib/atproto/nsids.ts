/**
 * Every NSID Schelling Point reads or writes, in one place.
 *
 * `community.lexicon.*`, `coop.lexicon.*` and `freeschool.draft.*` are BORROWED
 * records: never modified, never extended (sidecar rule, spec §4.3). Their JSON
 * is vendored under `lexicons/vendor/`. `schellingpoint.draft.*` are ours,
 * under `lexicons/schellingpoint/draft/`.
 *
 * Isomorphic and dependency-free: safe to import from client components.
 */
export const NSID = {
  // community.lexicon — canonical, vendored verbatim
  event: 'community.lexicon.calendar.event',
  rsvp: 'community.lexicon.calendar.rsvp',
  locationAddress: 'community.lexicon.location.address',
  locationGeo: 'community.lexicon.location.geo',
  locationFsq: 'community.lexicon.location.fsq',
  locationHthree: 'community.lexicon.location.hthree',

  // coop.lexicon — ASSUMED shapes (see lexicons/vendor/README.md)
  eventConfig: 'coop.lexicon.event.config',
  eventListing: 'coop.lexicon.event.listing',
  membership: 'coop.lexicon.membership',

  // freeschool.draft — reused verbatim
  policy: 'freeschool.draft.policy',
  approval: 'freeschool.draft.approval',

  // schellingpoint.draft — ours
  gathering: 'schellingpoint.draft.gathering',
  proposal: 'schellingpoint.draft.proposal',
  cohost: 'schellingpoint.draft.cohost',
  timePreference: 'schellingpoint.draft.timePreference',
  track: 'schellingpoint.draft.track',
  venue: 'schellingpoint.draft.venue',
  slotGrid: 'schellingpoint.draft.slotGrid',
  slot: 'schellingpoint.draft.slot',
  tally: 'schellingpoint.draft.tally',
  endorsement: 'schellingpoint.draft.endorsement',
} as const

export type NsidKey = keyof typeof NSID
export type Nsid = (typeof NSID)[NsidKey]

/** The ten record collections we own (spec §14.B). */
export const SCHELLINGPOINT_COLLECTIONS: readonly Nsid[] = [
  NSID.gathering,
  NSID.proposal,
  NSID.cohost,
  NSID.timePreference,
  NSID.track,
  NSID.venue,
  NSID.slotGrid,
  NSID.slot,
  NSID.tally,
  NSID.endorsement,
]

/**
 * Collections the indexer (Jetstream consumer / listRecords backfill) keeps in
 * `at_records`. Location lexicons are object defs, not records, so they are
 * not listed: they only ever appear inline in an event or venue.
 */
export const INDEXED_COLLECTIONS: readonly Nsid[] = [
  NSID.event,
  NSID.rsvp,
  NSID.eventConfig,
  NSID.eventListing,
  NSID.membership,
  NSID.policy,
  NSID.approval,
  ...SCHELLINGPOINT_COLLECTIONS,
]

/** `mode` / `status` fragment tokens on community.lexicon.calendar.event. */
export const EVENT_MODE = {
  inperson: `${NSID.event}#inperson`,
  virtual: `${NSID.event}#virtual`,
  hybrid: `${NSID.event}#hybrid`,
} as const

export const EVENT_STATUS = {
  planned: `${NSID.event}#planned`,
  scheduled: `${NSID.event}#scheduled`,
  rescheduled: `${NSID.event}#rescheduled`,
  cancelled: `${NSID.event}#cancelled`,
  postponed: `${NSID.event}#postponed`,
} as const

/** `status` fragment tokens on community.lexicon.calendar.rsvp. */
export const RSVP_STATUS = {
  going: `${NSID.rsvp}#going`,
  interested: `${NSID.rsvp}#interested`,
  notgoing: `${NSID.rsvp}#notgoing`,
} as const
