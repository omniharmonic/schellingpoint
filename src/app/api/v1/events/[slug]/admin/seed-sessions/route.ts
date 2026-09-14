/**
 * Generate test sessions for auto-scheduler testing
 * POST - Create 25-30 test sessions with varied constraints
 * DELETE - Remove seeded test sessions
 */

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, createRequestClient } from '@/lib/supabase/server'
import { getUserFromRequest } from '@/lib/api/getUser'

const TEST_SESSIONS = [
  // Time slot conflicts (5 sessions wanting morning keynote time)
  { title: 'Opening Keynote: The Future of DAOs', expectedAttendance: 100, trackPreference: 'governance', description: 'A high-energy opening session exploring the evolution and future of decentralized autonomous organizations.' },
  { title: 'Morning Meditation & Intention Setting', expectedAttendance: 50, trackPreference: null, description: 'Start your day with mindfulness practices tailored for builders and innovators.' },
  { title: 'Breakfast Discussion: Web3 Ethics', expectedAttendance: 30, trackPreference: 'culture', description: 'An informal discussion over breakfast about ethical considerations in decentralized systems.' },
  { title: 'Early Bird Workshop: Solidity Basics', expectedAttendance: 40, trackPreference: 'technical', description: 'A hands-on workshop for beginners to learn the fundamentals of Solidity smart contract development.' },
  { title: 'Dawn Yoga for Builders', expectedAttendance: 25, trackPreference: null, description: 'Stretch, breathe, and energize before diving into a day of building and collaboration.' },

  // Presenter conflicts (3 sessions by same person - will use proposer)
  { title: 'Zero-Knowledge Proofs 101', expectedAttendance: 60, trackPreference: 'technical', presenterConflict: true, description: 'An introduction to ZK proofs: what they are, why they matter, and how they work.' },
  { title: 'Advanced ZK Circuits', expectedAttendance: 40, trackPreference: 'technical', presenterConflict: true, description: 'Deep dive into building efficient ZK circuits for real-world applications.' },
  { title: 'ZK for Privacy Applications', expectedAttendance: 45, trackPreference: 'technical', presenterConflict: true, description: 'Exploring how zero-knowledge proofs enable privacy-preserving applications on public blockchains.' },

  // Large venue requirements (need big rooms)
  { title: 'Community Town Hall', expectedAttendance: 150, trackPreference: 'governance', description: 'An open forum for the community to discuss priorities, concerns, and celebrate wins.' },
  { title: 'Demo Day: Showcase Your Project', expectedAttendance: 120, trackPreference: null, description: 'Teams present their projects in quick 5-minute demos. Expect innovation and inspiration!' },
  { title: 'Panel: Scaling Ethereum', expectedAttendance: 100, trackPreference: 'technical', description: 'Leading researchers and builders discuss the latest in L2s, rollups, and scaling solutions.' },
  { title: 'Fireside Chat: Founders Stories', expectedAttendance: 80, trackPreference: 'culture', description: 'Candid conversations with founders about their journeys, failures, and lessons learned.' },

  // Multi-slot workshops (need consecutive slots)
  { title: 'Full-Stack DApp Workshop', expectedAttendance: 35, trackPreference: 'technical', multiSlot: true, description: 'Build a complete decentralized application from scratch. Bring your laptop!' },
  { title: 'Governance Design Workshop', expectedAttendance: 30, trackPreference: 'governance', multiSlot: true, description: 'Learn to design effective governance systems through hands-on exercises and case studies.' },

  // Track-assigned sessions
  { title: 'Token Engineering Deep Dive', expectedAttendance: 40, trackPreference: 'technical', description: 'Explore the art and science of designing token economies that align incentives.' },
  { title: 'Smart Contract Security Patterns', expectedAttendance: 45, trackPreference: 'technical', description: 'Learn battle-tested patterns to write secure smart contracts and avoid common pitfalls.' },
  { title: 'DAO Treasury Management', expectedAttendance: 35, trackPreference: 'governance', description: 'Best practices for managing DAO treasuries: diversification, risk, and sustainability.' },
  { title: 'Quadratic Funding Explained', expectedAttendance: 50, trackPreference: 'governance', description: 'Understanding quadratic funding and its applications for public goods funding.' },
  { title: 'Regenerative Finance Panel', expectedAttendance: 55, trackPreference: 'culture', description: 'How can finance be a force for ecological and social regeneration?' },
  { title: 'Art & NFTs: Beyond Profile Pictures', expectedAttendance: 40, trackPreference: 'culture', description: 'Exploring the intersection of art, culture, and blockchain technology.' },

  // Flexible sessions (no special constraints)
  { title: 'Lightning Talks: 5 Minute Pitches', expectedAttendance: 60, trackPreference: null, description: 'Rapid-fire presentations where anyone can share an idea, project, or insight in 5 minutes.' },
  { title: 'Networking Lunch Discussion', expectedAttendance: 50, trackPreference: null, description: 'Structured networking over lunch with rotating table topics.' },
  { title: 'Open Space: Bring Your Topic', expectedAttendance: 30, trackPreference: null, description: 'Unconference-style session where attendees propose and vote on topics in real-time.' },
  { title: 'AMA: Ask the Core Team', expectedAttendance: 70, trackPreference: null, description: 'Your chance to ask anything to the protocol core team.' },
  { title: 'Closing Circle & Reflections', expectedAttendance: 80, trackPreference: null, description: 'End the event with gratitude, reflections, and commitments for the future.' },
  { title: 'Hackathon Project Showcase', expectedAttendance: 65, trackPreference: null, description: 'Winners and participants present what they built during the hackathon.' },
  { title: 'Birds of a Feather: Find Your Tribe', expectedAttendance: 40, trackPreference: null, description: 'Self-organizing groups around shared interests. Find your people!' },
  { title: 'Impromptu Sessions Board', expectedAttendance: 25, trackPreference: null, description: 'Check the board for spontaneous sessions proposed throughout the day.' },
]

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params

  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createAdminClient()

  // Get event and verify admin
  const { data: event } = await supabase
    .from('events')
    .select('id')
    .eq('slug', slug)
    .single()

  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const { data: membership } = await supabase
    .from('event_members')
    .select('role')
    .eq('event_id', event.id)
    .eq('user_id', user.id)
    .single()

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Get tracks for assignment
  const { data: tracks } = await supabase
    .from('tracks')
    .select('id, name')
    .eq('event_id', event.id)

  const trackMap: Record<string, string> = {}
  tracks?.forEach(t => {
    const name = t.name.toLowerCase()
    if (name.includes('tech') || name.includes('dev') || name.includes('build')) trackMap['technical'] = t.id
    if (name.includes('gov') || name.includes('dao')) trackMap['governance'] = t.id
    if (name.includes('cult') || name.includes('commun') || name.includes('social')) trackMap['culture'] = t.id
  })

  // Create sessions
  const sessionsToCreate = TEST_SESSIONS.map((s) => ({
    event_id: event.id,
    title: `[TEST] ${s.title}`,
    description: s.description,
    status: 'approved',
    proposer_id: user.id,
    expected_attendance: s.expectedAttendance,
    track_id: s.trackPreference ? trackMap[s.trackPreference] || null : null,
  }))

  const { data: created, error } = await createRequestClient(request)
    .from('sessions')
    .insert(sessionsToCreate)
    .select('id, title')

  if (error) {
    console.error('Error creating test sessions:', error)
    return NextResponse.json({ error: 'Failed to create sessions' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    created: created?.length || 0,
    message: `Created ${created?.length} test sessions (prefixed with [TEST])`,
  })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params

  const user = await getUserFromRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await createAdminClient()

  // Get event and verify admin
  const { data: event } = await supabase
    .from('events')
    .select('id')
    .eq('slug', slug)
    .single()

  if (!event) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const { data: membership } = await supabase
    .from('event_members')
    .select('role')
    .eq('event_id', event.id)
    .eq('user_id', user.id)
    .single()

  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Delete test sessions (identified by [TEST] prefix)
  const { data: deleted, error } = await supabase
    .from('sessions')
    .delete()
    .eq('event_id', event.id)
    .like('title', '[TEST]%')
    .select('id')

  if (error) {
    console.error('Error deleting test sessions:', error)
    return NextResponse.json({ error: 'Failed to delete test sessions' }, { status: 500 })
  }

  return NextResponse.json({
    success: true,
    deleted: deleted?.length || 0,
    message: `Deleted ${deleted?.length || 0} test sessions`,
  })
}
