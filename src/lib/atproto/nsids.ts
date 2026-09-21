/**
 * Every NSID Schelling Point reads or writes, in one place.
 *
 * `community.lexicon.*`, `coop.lexicon.*`, `freeschool.draft.*` and `app.bsky.*` are BORROWED
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

  // app.bsky — borrowed verbatim (vendored under lexicons/vendor/bsky/)
  actorProfile: 'app.bsky.actor.profile',
  /** The gathering account's own posts (design §7). Facets/embeds are object defs, not records. */
  post: 'app.bsky.feed.post',

  // freeschool.draft — reused verbatim
  policy: 'freeschool.draft.policy',
  approval: 'freeschool.draft.approval',
  series: 'freeschool.draft.series',
  occurrence: 'freeschool.draft.occurrence',
  skill: 'freeschool.draft.skill',

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
  NSID.series,
  NSID.occurrence,
  ...SCHELLINGPOINT_COLLECTIONS,
]

/**
 * What a GATHERING repo holds (reconciliation scope for `events.actor_did`). Everything the
 * gathering actor writes, nothing a person writes.
 */
export const GATHERING_COLLECTIONS: readonly Nsid[] = [
  NSID.gathering,
  NSID.policy,
  NSID.event,
  NSID.eventConfig,
  NSID.eventListing,
  NSID.membership,
  NSID.venue,
  NSID.track,
  NSID.slotGrid,
  NSID.slot,
  NSID.tally,
  NSID.proposal,
  NSID.series,
  NSID.occurrence,
  // The gathering account's own `app.bsky.actor.profile` (rkey `self`); not indexed (it is not in
  // `INDEXED_COLLECTIONS`, so reconciliation skips it and Jetstream never subscribes to it).
  NSID.actorProfile,
  // The gathering account's feed posts (design §7): in scope for the privacy audit's live scan
  // (foreign DIDs only via `feed_posts.mentions`, host-name check over post text); not indexed by
  // Jetstream — the app's own `feed_posts` ledger is the source of truth.
  NSID.post,
]

/** What a PERSON's repo holds that matters to us (reconciliation scope for `accounts.did`). */
export const PARTICIPANT_COLLECTIONS: readonly Nsid[] = [
  NSID.proposal,
  NSID.cohost,
  NSID.endorsement,
  NSID.timePreference,
  NSID.rsvp,
  NSID.approval,
]

/**
 * Jetstream `wantedCollections`: our own NSIDs plus every borrowed record we read. The skill
 * taxonomy is included so an authority edit reaches the cache before the 24 h refresh.
 */
export const JETSTREAM_COLLECTIONS: readonly Nsid[] = [...INDEXED_COLLECTIONS, NSID.skill]

/** Collections we borrow and must never extend (sidecar rule). */
export const BORROWED_PREFIXES: readonly string[] = ['community.lexicon.', 'coop.lexicon.', 'freeschool.draft.', 'app.bsky.']

export function isBorrowedNsid(nsid: string): boolean {
  return BORROWED_PREFIXES.some((p) => nsid.startsWith(p))
}

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
