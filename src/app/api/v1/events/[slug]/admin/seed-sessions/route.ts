/**
 * Development test data for the auto-scheduler.
 *   POST   /api/v1/events/[slug]/admin/seed-sessions   create ~28 host-less "[TEST]" sessions
 *   DELETE /api/v1/events/[slug]/admin/seed-sessions   remove them (never ones published on the network)
 *
 * Disabled in production unless ALLOW_SEED_SESSIONS=true.
 */
import { asAccount } from '@/lib/db'
import { errorResponse, fail, json, requireOrganizer, rolesWith } from '@/lib/scheduling/admin-api'
import { insertCuratedSession } from '@/lib/scheduling/sessions'

export const dynamic = 'force-dynamic'

const ROLES = rolesWith('manageSchedule')

function seedingDisabled(): Response | null {
  if (process.env.NODE_ENV !== 'production' || process.env.ALLOW_SEED_SESSIONS === 'true') return null
  return fail(403, 'Test session seeding is disabled in production')
}

const TEST_SESSIONS: Array<{ title: string; expected: number; track: string | null; format: 'talk' | 'workshop' | 'discussion' | 'panel' | 'demo'; duration: number; description: string }> = [
  { title: 'Opening Circle: Why We Gather', expected: 100, track: 'governance', format: 'talk', duration: 60, description: 'A welcome session on the purpose and format of the gathering.' },
  { title: 'Morning Stretch & Intentions', expected: 50, track: null, format: 'discussion', duration: 30, description: 'Start the day together.' },
  { title: 'Breakfast Conversation: Ethics of Coordination', expected: 30, track: 'culture', format: 'discussion', duration: 60, description: 'An informal conversation about the ethics of coordination tools.' },
  { title: 'Early Workshop: Building a Budget Together', expected: 40, track: 'technical', format: 'workshop', duration: 90, description: 'Hands-on participatory budgeting.' },
  { title: 'Zero-Knowledge Proofs 101', expected: 60, track: 'technical', format: 'talk', duration: 60, description: 'What they are and why they matter.' },
  { title: 'Advanced ZK Circuits', expected: 40, track: 'technical', format: 'workshop', duration: 90, description: 'Building efficient circuits.' },
  { title: 'ZK for Privacy Applications', expected: 45, track: 'technical', format: 'talk', duration: 60, description: 'Privacy-preserving applications.' },
  { title: 'Community Town Hall', expected: 150, track: 'governance', format: 'discussion', duration: 60, description: 'An open forum for the community.' },
  { title: 'Demo Hour', expected: 120, track: null, format: 'demo', duration: 60, description: 'Short demos of community projects.' },
  { title: 'Panel: Scaling Local Networks', expected: 100, track: 'technical', format: 'panel', duration: 60, description: 'Researchers and builders discuss scale.' },
  { title: 'Fireside: Founders Stories', expected: 80, track: 'culture', format: 'talk', duration: 60, description: 'Candid conversations about what went wrong.' },
  { title: 'Full-Stack App Workshop', expected: 35, track: 'technical', format: 'workshop', duration: 90, description: 'Build a complete app from scratch.' },
  { title: 'Governance Design Workshop', expected: 30, track: 'governance', format: 'workshop', duration: 90, description: 'Design governance through exercises.' },
  { title: 'Token Engineering Deep Dive', expected: 40, track: 'technical', format: 'talk', duration: 60, description: 'Designing incentive systems.' },
  { title: 'Security Patterns', expected: 45, track: 'technical', format: 'talk', duration: 60, description: 'Battle-tested patterns.' },
  { title: 'Treasury Management', expected: 35, track: 'governance', format: 'discussion', duration: 60, description: 'Sustainable shared treasuries.' },
  { title: 'Quadratic Funding Explained', expected: 50, track: 'governance', format: 'talk', duration: 30, description: 'How quadratic funding works.' },
  { title: 'Regenerative Finance Panel', expected: 55, track: 'culture', format: 'panel', duration: 60, description: 'Finance for ecological regeneration.' },
  { title: 'Art Beyond Profile Pictures', expected: 40, track: 'culture', format: 'talk', duration: 60, description: 'Art, culture and open networks.' },
  { title: 'Lightning Talks', expected: 60, track: null, format: 'talk', duration: 60, description: 'Five-minute talks from anyone.' },
  { title: 'Lunch Table Topics', expected: 50, track: null, format: 'discussion', duration: 60, description: 'Structured networking over lunch.' },
  { title: 'Open Space: Bring Your Topic', expected: 30, track: null, format: 'discussion', duration: 60, description: 'Propose topics in the room.' },
  { title: 'Ask the Organizers', expected: 70, track: null, format: 'discussion', duration: 30, description: 'Questions about the gathering.' },
  { title: 'Closing Circle', expected: 80, track: null, format: 'discussion', duration: 60, description: 'Reflections and commitments.' },
  { title: 'Hackathon Showcase', expected: 65, track: null, format: 'demo', duration: 60, description: 'What people built.' },
  { title: 'Birds of a Feather', expected: 40, track: null, format: 'discussion', duration: 60, description: 'Self-organizing interest groups.' },
  { title: 'Impromptu Sessions Board', expected: 25, track: null, format: 'discussion', duration: 30, description: 'Spontaneous sessions.' },
]

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const disabled = seedingDisabled()
  if (disabled) return disabled
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx

  try {
    const created = await asAccount(ctx.viewer.accountId, async (tx) => {
      const tracks = await tx<{ id: string; name: string }[]>`select id, name from tracks where event_id = ${ctx.event.id}`
      const trackFor = (hint: string | null) => {
        if (!hint) return null
        const match = tracks.find((t) => {
          const name = t.name.toLowerCase()
          if (hint === 'technical') return /tech|dev|build|open source/.test(name)
          if (hint === 'governance') return /gov|dao|coord/.test(name)
          return /cult|commun|social|local/.test(name)
        })
        return match?.id ?? null
      }
      let n = 0
      for (const s of TEST_SESSIONS) {
        await insertCuratedSession(tx, ctx.event.id, ctx.viewer.accountId, {
          title: `[TEST] ${s.title}`,
          description: s.description,
          format: s.format,
          duration: s.duration,
          status: 'approved',
          track_id: trackFor(s.track),
          topic_tags: null,
          listed_host_name: null,
          time_slot_id: null,
          expected_attendance: s.expected,
          required_features: [],
        }, { importedFrom: 'seed' })
        n++
      }
      return n
    })
    return json({ success: true, created, message: `Created ${created} test sessions (prefixed with [TEST])` }, { status: 201 })
  } catch (e) {
    return errorResponse(e, 'seed sessions')
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const disabled = seedingDisabled()
  if (disabled) return disabled
  const { slug } = await params
  const ctx = await requireOrganizer(request, slug, ROLES)
  if (ctx instanceof Response) return ctx

  try {
    const deleted = await asAccount(ctx.viewer.accountId, (tx) => tx`
      delete from sessions
      where event_id = ${ctx.event.id} and title like '[TEST]%' and imported_from = 'seed'
        and not (calendar_event_uri is not null and slot_uri is not null and cancelled_at is null)
      returning id
    `)
    return json({ success: true, deleted: deleted.length, message: `Deleted ${deleted.length} test sessions` })
  } catch (e) {
    return errorResponse(e, 'delete seeded sessions')
  }
}
