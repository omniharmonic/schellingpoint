/**
 * Who a session is by, as the viewer may see it (isomorphic: used by server metadata and
 * client cards). A linked host's own display name plus accepted co-hosts; a host-less
 * session is an "Unclaimed proposal", and organizers also see the label they listed it under.
 */
import type { SessionView } from './read'

export interface HostBylineParts {
  /** The line as `hostByline` renders it. */
  name: string
  /** The host's `@handle` (without the `@`), when there is a linked host with one. */
  handle: string | null
  /** Accepted co-hosts' handles, in order, `null` where a co-host has none. */
  cohost_handles: (string | null)[]
}

/**
 * The byline plus the handles the UI shows under it (release design §5.3). `hostByline` stays a
 * string for the existing card and metadata callers.
 */
export function hostBylineParts(session: Pick<SessionView, 'host' | 'cohosts' | 'listed_as'>): HostBylineParts {
  return {
    name: hostByline(session),
    handle: session.host?.handle ?? null,
    cohost_handles: session.cohosts.map((c) => c.handle ?? null),
  }
}

export function hostByline(session: Pick<SessionView, 'host' | 'cohosts' | 'listed_as'>): string {
  const cohostNames = session.cohosts
    .map((c) => c.display_name || (c.handle ? `@${c.handle}` : null))
    .filter(Boolean) as string[]
  if (!session.host) {
    const base = session.listed_as ? `Listed as ${session.listed_as} · unclaimed` : 'Unclaimed proposal'
    return cohostNames.length ? `${base} · with ${cohostNames.join(', ')}` : base
  }
  let line = session.host.display_name || (session.host.handle ? `@${session.host.handle}` : 'A participant')
  if (cohostNames.length === 1) line += ` & ${cohostNames[0]}`
  else if (cohostNames.length > 1) line += ` & ${cohostNames.length} others`
  return line
}
