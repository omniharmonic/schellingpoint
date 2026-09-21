import type { Metadata } from 'next'
import { MapPageClient } from './MapPageClient'

export const metadata: Metadata = { title: 'Map' }

/** `/e/[slug]/map` (spec §8.4). Access is decided by the event layout; data comes from the sessions API by tier. */
export default function MapPage() {
  return <MapPageClient />
}
