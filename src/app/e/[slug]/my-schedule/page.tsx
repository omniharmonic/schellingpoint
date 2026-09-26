/**
 * `/e/[slug]/my-schedule` → `/e/[slug]/schedule?view=mine` (mobile shell design §4, §8).
 *
 * My schedule became a tab of Schedule so the mobile tab bar has one destination for "when things
 * happen" instead of two. The old URL is in notification action links, calendar toasts and
 * whatever anyone bookmarked, so it keeps working — as a redirect, not a second page.
 */
import { redirect } from 'next/navigation'

export default async function MySchedulePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  redirect(`/e/${encodeURIComponent(slug)}/schedule?view=mine`)
}
