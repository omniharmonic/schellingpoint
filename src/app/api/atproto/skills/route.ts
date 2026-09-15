/**
 * GET /api/atproto/skills?q=<text>&limit=<n>     search the shared skill taxonomy
 * GET /api/atproto/skills?uris=<at-uri>,<at-uri> resolve specific skills (label chips)
 *
 * Public: the taxonomy is the Free School skills authority's public records, cached in
 * `at_records` and refreshed at most every 24 h. Deprecated nodes are never offered.
 */
import { ensureSkillsFresh, getSkills, searchSkills, skillsAuthorityDid } from '@/lib/atproto/skills'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams
  let freshness: { refreshedAt: string | null; stale: boolean }
  try {
    freshness = await ensureSkillsFresh()
  } catch {
    return Response.json({ error: 'The skill taxonomy is unavailable right now' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
  }
  const urisParam = params.get('uris')
  if (urisParam !== null) {
    const uris = urisParam.split(',').map((u) => u.trim()).filter((u) => u.startsWith('at://')).slice(0, 50)
    const skills = await getSkills(uris)
    return Response.json({ authority: skillsAuthorityDid(), skills, ...freshness }, { headers: { 'Cache-Control': 'public, max-age=300' } })
  }
  const q = (params.get('q') ?? '').slice(0, 80)
  const limitRaw = Number(params.get('limit') ?? 20)
  const skills = await searchSkills(q, { limit: Number.isFinite(limitRaw) ? limitRaw : 20 })
  return Response.json({ authority: skillsAuthorityDid(), skills, ...freshness }, { headers: { 'Cache-Control': 'public, max-age=60' } })
}
