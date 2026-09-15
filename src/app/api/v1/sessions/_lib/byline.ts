/**
 * Who a session is by, as the viewer may see it (isomorphic: used by server metadata and
 * client cards). A linked host's own display name plus accepted co-hosts; a host-less
 * session is an "Unclaimed proposal", and organizers also see the label they listed it under.
 */
import type { SessionView } from './read'

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
