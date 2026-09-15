import { NextResponse } from 'next/server'
import { sql } from '@/lib/db'
import { isValidSlugFormat, suggestAlternativeSlugs } from '@/lib/utils/slug'
import { previewGatheringHandle, slugLabelProblem, type GatheringHandlePreview } from '@/lib/events/identity'

/**
 * POST /api/events/validate-slug  { slug }
 *
 * → { available, suggestions?, error?, handle? }
 *
 * A slug is the gathering's URL, its subdomain `<slug>.<domain>` and (when it fits the PDS's
 * 18-character label limit) its handle, so availability covers all three namespaces:
 * existing events, reserved labels and existing member handles. `handle` previews the
 * identity the gathering will get (`generated: true` when the slug is too long to be one).
 * Unauthenticated and read-only: it discloses only that a name is taken.
 */

interface ValidateSlugResponse {
  available: boolean
  suggestions?: string[]
  error?: string
  handle?: GatheringHandlePreview
}

async function availableAmong(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return []
  const taken = await sql<{ slug: string }[]>`select slug from events where slug in ${sql(slugs)}`
  const takenSet = new Set(taken.map((r) => r.slug))
  const free: string[] = []
  for (const slug of slugs) {
    if (takenSet.has(slug)) continue
    if (await slugLabelProblem(slug, { checkPds: false })) continue
    free.push(slug)
  }
  return free
}

export async function POST(request: Request): Promise<NextResponse<ValidateSlugResponse>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ available: false, error: 'Invalid JSON body' }, { status: 400 })
  }
  const slug = body && typeof body === 'object' ? (body as { slug?: unknown }).slug : undefined
  if (!slug || typeof slug !== 'string') {
    return NextResponse.json({ available: false, error: 'Slug is required' }, { status: 400 })
  }

  const format = isValidSlugFormat(slug)
  if (!format.valid) return NextResponse.json({ available: false, error: format.error }, { status: 400 })

  try {
    const problem = await slugLabelProblem(slug)
    if (problem?.code === 'InvalidLabel') {
      return NextResponse.json({ available: false, error: problem.error }, { status: 400 })
    }
    const existing = await sql`select 1 from events where slug = ${slug} limit 1`
    if (existing.length > 0 || problem) {
      const suggestions = await availableAmong(suggestAlternativeSlugs(slug))
      return NextResponse.json({
        available: false,
        ...(problem ? { error: problem.error } : {}),
        suggestions: suggestions.slice(0, 3),
      })
    }
    return NextResponse.json({ available: true, handle: previewGatheringHandle(slug) })
  } catch (error) {
    console.error('Error validating slug:', error)
    return NextResponse.json({ available: false, error: 'Failed to check slug availability' }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({ error: 'Method not allowed. Use POST.' }, { status: 405 })
}
