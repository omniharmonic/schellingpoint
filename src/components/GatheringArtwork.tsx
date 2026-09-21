'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

const phases = [
  { name: 'Propose', title: 'It starts with a little curiosity.', description: 'Bring a question, a skill, or an unfinished idea. Anyone can start a session.', labels: ['A question', 'A skill to share', 'A new idea'] },
  { name: 'Vote', title: 'Find the energy in the room.', description: 'Put your credits behind the sessions you care about. Shared interest shapes the program.', labels: ['Shared curiosity', 'Your voice', 'Common ground'] },
  { name: 'Gather', title: 'Make room for the unexpected.', description: 'Meet around the ideas you chose together. The best part is what happens between people.', labels: ['Learn together', 'Meet your people', 'Make something'] },
]

/**
 * An explorable explanation, not a visualization of live participant data. Decorative colours
 * come from the theme tokens (`.gathering-art` sets `color` to the primary), so a gathering's
 * branding carries into the artwork.
 */
export function GatheringArtwork({ compact = false }: { compact?: boolean }) {
  const [phase, setPhase] = useState(0)
  const current = phases[phase]
  return (
    <div className={cn('gathering-art relative rounded-[2rem] bg-secondary overflow-hidden', compact ? 'p-5' : 'p-6 sm:p-8')}>
      <svg viewBox="0 0 500 365" className="w-full" aria-hidden="true">
        <g stroke="currentColor" fill="none" strokeWidth=".8" opacity=".2">
          <ellipse cx="250" cy="177" rx="180" ry="147" />
          <ellipse cx="250" cy="177" rx="95" ry="147" transform="rotate(55 250 177)" />
          <ellipse cx="250" cy="177" rx="95" ry="147" transform="rotate(-55 250 177)" />
          <path d="M250 30 405 110 405 248 250 324 95 248 95 110Z M250 30 250 324 M95 110 405 248 M405 110 95 248 M95 110H405 M95 248H405 M250 30 95 248 405 248Z M250 324 95 110 405 110Z" />
        </g>
        <g stroke="currentColor" fill="none" strokeWidth="1.4" opacity={phase === 0 ? '.3' : '.7'}>
          <path d="M152 123 310 100 348 241 178 251Z M152 123 348 241 M178 251 310 100" />
        </g>
        <circle cx="250" cy="180" r={phase === 2 ? 92 : 65} fill="hsl(var(--accent))" style={{ transition: 'r 350ms ease' }} />
        <g fill="hsl(var(--secondary))" stroke="currentColor" strokeWidth="1.4">
          <circle cx="152" cy="123" r={phase === 1 ? 22 : 15} />
          <circle cx="310" cy="100" r={phase === 1 ? 28 : 15} />
          <circle cx="348" cy="241" r={phase === 1 ? 20 : 15} />
          <circle cx="178" cy="251" r={phase === 1 ? 18 : 15} />
        </g>
        <g fill="currentColor">
          <circle cx="152" cy="123" r="4" /><circle cx="310" cy="100" r="4" />
          <circle cx="348" cy="241" r="4" /><circle cx="178" cy="251" r="4" />
          <circle cx="250" cy="30" r="3" /><circle cx="405" cy="110" r="3" />
          <circle cx="405" cy="248" r="3" /><circle cx="250" cy="324" r="3" />
          <circle cx="95" cy="248" r="3" /><circle cx="95" cy="110" r="3" />
        </g>
        <g fill="hsl(var(--foreground))" textAnchor="middle" fontFamily="BDO Grotesk, sans-serif">
          <text x="250" y="176" fontSize="23" fontWeight="600">{phase === 0 ? 'What if…' : phase === 1 ? 'Yes, and…' : 'Here, together.'}</text>
          <text x="250" y="199" fontSize="12">{phase === 0 ? 'an idea found its people?' : phase === 1 ? 'we chose it together?' : 'Something new begins.'}</text>
        </g>
        <g fontFamily="BDO Grotesk, sans-serif" fontSize="12" fill="currentColor">
          <rect x="13" y="67" width="130" height="32" rx="16" fill="hsl(var(--card))" /><text x="78" y="87" textAnchor="middle">{current.labels[0]}</text>
          <rect x="340" y="149" width="146" height="32" rx="16" fill="hsl(var(--card))" /><text x="413" y="169" textAnchor="middle">{current.labels[1]}</text>
          <rect x="28" y="279" width="140" height="32" rx="16" fill="hsl(var(--card))" /><text x="98" y="299" textAnchor="middle">{current.labels[2]}</text>
        </g>
      </svg>
      {!compact && <>
        <div className="flex gap-2 mb-5" role="group" aria-label="How a gathering takes shape">
          {phases.map((item, index) => (
            <button
              key={item.name}
              type="button"
              onClick={() => setPhase(index)}
              aria-pressed={phase === index}
              className="flex-1 rounded-full py-2.5 text-sm border border-primary/20 text-foreground transition-colors hover:bg-card/60"
            >
              {item.name}
            </button>
          ))}
        </div>
        <div aria-live="polite" className="min-h-[100px] text-foreground">
          <h2 className="text-lg font-semibold mb-1">{current.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground max-w-sm">{current.description}</p>
        </div>
      </>}
    </div>
  )
}

export function NetworkMark({ className }: { className?: string }) {
  return <svg viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true"><g stroke="currentColor" strokeWidth="1.5"><path d="m16 3 11 7v12l-11 7-11-7V10Z M16 3v26M5 10l22 12M27 10 5 22M5 10h22M5 22h22" /></g><g fill="currentColor"><circle cx="16" cy="3" r="2"/><circle cx="27" cy="10" r="2"/><circle cx="27" cy="22" r="2"/><circle cx="16" cy="29" r="2"/><circle cx="5" cy="22" r="2"/><circle cx="5" cy="10" r="2"/></g></svg>
}
