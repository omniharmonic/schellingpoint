'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowUpRight, Check, Plus, Minus, RotateCcw, MoveUpRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const chapters = [
  { name: 'Propose', title: 'A good question is a good beginning.', text: 'You don’t need a finished talk. Bring a question, a skill, or something you’re figuring out. Propose a conversation, a workshop, or a session worth sharing.', detail: 'Organizers can review proposals before the community sees them.', prompt: 'Try adding an idea to the room.' },
  { name: 'Vote', title: 'Put your curiosity to work.', text: 'Everyone gets a budget of credits. With quadratic voting, one vote costs one credit, two cost four, and three cost nine. Support a few different ideas or put more behind the one you love.', detail: 'Organizers choose the credit budget and voting method for each event.', prompt: 'Try dividing nine credits between these ideas.' },
  { name: 'Gather', title: 'Shared interest becomes shared time.', text: 'Organizers turn the community’s choices into a program, matching sessions with rooms and times. Save the sessions you want to attend. Then show up and see what happens.', detail: 'Votes guide the program. Organizers still make the final scheduling decisions.', prompt: 'The example program carries your ideas forward.' },
]
const initialIdeas = ['What can we build together?', 'A city that belongs to everyone', 'Make something with your hands']

export function GatheringHero() {
  const [selected, setSelected] = useState(0)
  const topics = ['A question', 'A skill to share', 'An unfinished idea', 'A different perspective']
  return <section className="gathering-hero">
    <div className="hero-intro">
      <h1>The best part is who shows up.</h1>
      <p>An unconference shaped by its people. Bring ideas, choose sessions together, and make room for what happens next.</p>
      <div className="flex flex-wrap gap-3 mt-8"><Link href="/create" className="bold-cta">Create a gathering <Plus className="h-5 w-5"/></Link><a href="#how-it-works" className="bold-cta bold-cta-outline">See how it works <ArrowDown className="h-5 w-5"/></a></div>
      <a href="#upcoming" className="inline-flex items-center gap-2 mt-7 text-sm font-semibold underline underline-offset-4">Find a gathering <ArrowUpRight className="h-4 w-4"/></a>
    </div>
    <div className="possibility-field">
      <div className="field-caption"><span className="inline-block h-2 w-2 rounded-full bg-current"/> A room full of possibility</div>
      <svg viewBox="0 0 500 480" aria-hidden="true" className="field-lines"><g fill="none" stroke="currentColor" strokeWidth="1" opacity=".25"><circle cx="250" cy="240" r="180"/><ellipse cx="250" cy="240" rx="100" ry="180" transform="rotate(45 250 240)"/><ellipse cx="250" cy="240" rx="100" ry="180" transform="rotate(-45 250 240)"/><path d="M250 60 410 150 410 330 250 420 90 330 90 150Z M250 60 90 330H410ZM250 420 90 150H410Z"/></g><g stroke="currentColor" strokeWidth="2" fill="none"><path d={['M90 150 250 240 410 330', 'M410 150 250 240 90 330', 'M90 330 250 240 250 60', 'M410 330 250 240 250 420'][selected]}/></g></svg>
      <div className="field-center" key={selected}><span>{['What if…', 'Let’s try…', 'Imagine…', 'Yes, and…'][selected]}</span><p>{['we learned from each other?', 'something none of us could do alone.', 'where an idea could take us.', 'there’s room for your point of view.'][selected]}</p></div>
      {topics.map((topic, index) => <button key={topic} className={`field-topic ${['field-topic-0', 'field-topic-1', 'field-topic-2', 'field-topic-3'][index]}`} aria-pressed={selected === index} onClick={() => setSelected(index)}>{topic}<Plus className="h-4 w-4"/></button>)}
      <p className="field-footer">Choose what you’ll bring.</p>
    </div>
  </section>
}

export function GatheringStory() {
  const [active, setActive] = useState(0)
  const [ideas, setIdeas] = useState(initialIdeas)
  const [draft, setDraft] = useState('')
  const [added, setAdded] = useState(false)
  const [votes, setVotes] = useState([1, 1, 0])
  const interacting = useRef(false)
  const steps = useRef<(HTMLElement | null)[]>([])
  const remaining = 9 - votes.reduce((total, n) => total + n * n, 0)
  useEffect(() => {
    const update = () => {
      if (interacting.current) return
      const target = window.innerHeight * .28
      let nearest = 0
      steps.current.forEach((el, index) => {
        if (el && el.getBoundingClientRect().top <= target) nearest = index
      })
      setActive(nearest)
    }
    let frame = 0
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { update(); frame = 0 }) }
    const resumeScroll = () => { interacting.current = false; onScroll() }
    const resumeKeyboardScroll = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End', ' '].includes(e.key)) resumeScroll()
    }
    update()
    window.addEventListener('wheel', resumeScroll, { passive: true })
    window.addEventListener('touchmove', resumeScroll, { passive: true })
    window.addEventListener('keydown', resumeKeyboardScroll)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => { window.removeEventListener('wheel', resumeScroll); window.removeEventListener('touchmove', resumeScroll); window.removeEventListener('keydown', resumeKeyboardScroll); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', onScroll); cancelAnimationFrame(frame) }
  }, [])

  const demo = (phase: number, mobile = false) => <div onFocusCapture={() => { interacting.current = true }} onPointerDownCapture={() => { interacting.current = true }} className={`story-demo ${['story-demo-0', 'story-demo-1', 'story-demo-2'][phase]}`}>
    <div className="demo-topline"><span>Try a little gathering</span><span>Interactive example</span></div>
    {phase === 0 ? <>
      <h3>What’s on your mind?</h3>
      <div className="idea-stack">{ideas.map((idea, index) => <div key={`${index}-${idea}`} className={`example-idea ${['example-idea-0', 'example-idea-1', 'example-idea-2'][index]}`}><span className="idea-pin"/><span>{idea}</span><MoveUpRight className="h-5 w-5 shrink-0"/></div>)}</div>
      <form onSubmit={e => { e.preventDefault(); if (!draft.trim()) return; setIdeas(prev => [prev[0], prev[1], draft.trim()]); setDraft(''); setAdded(true) }} className="idea-form"><label htmlFor={mobile ? "example-idea-mobile" : "example-idea-desktop"} className="text-sm font-semibold">Your session idea</label><div className="flex gap-2"><input id={mobile ? "example-idea-mobile" : "example-idea-desktop"} value={draft} onChange={e => setDraft(e.target.value)} maxLength={70} placeholder="What would you love to explore?"/><button type="submit" aria-label="Add your example idea" disabled={!draft.trim()}><Plus className="h-5 w-5"/></button></div><p role="status">{added ? 'Your idea is in. Scroll down to give it some support.' : 'Just an example. Nothing is published.'}</p></form>
    </> : phase === 1 ? <>
      <div className="vote-demo-heading"><h3>Follow your curiosity.</h3><div aria-live="polite"><strong>{remaining}</strong><span>of 9 credits left</span></div></div>
      <div className="vote-examples">{ideas.map((idea, index) => <div className="vote-example" key={index}><div><p>{idea}</p><span>{votes[index]} vote{votes[index] === 1 ? '' : 's'} · {votes[index] ** 2} credit{votes[index] === 1 ? '' : 's'}</span></div><div className="vote-stepper"><button aria-label={`Remove an example vote from ${idea}`} disabled={votes[index] === 0} onClick={() => setVotes(prev => prev.map((n, i) => i === index ? n - 1 : n))}><Minus className="h-4 w-4"/></button><strong>{votes[index]}</strong><button aria-label={`Add an example vote to ${idea}`} disabled={remaining < 2 * votes[index] + 1} onClick={() => setVotes(prev => prev.map((n, i) => i === index ? n + 1 : n))}><Plus className="h-4 w-4"/></button></div></div>)}</div>
      <div className="credit-dots" aria-hidden="true">{Array.from({length:9}, (_, i) => <span key={i} className={i < 9 - remaining ? 'spent' : ''}/>)}</div><div className="flex justify-between items-center gap-3 mt-4"><p className="text-sm">{remaining === 0 ? 'All nine credits have a purpose.' : 'Each extra vote costs a little more.'}</p><button className="demo-reset" onClick={() => setVotes([0, 0, 0])}><RotateCcw className="h-3.5 w-3.5"/>Reset</button></div>
    </> : <>
      <h3>Make room. Make connections.</h3>
      <div className="example-program"><div className="program-day"><strong>Saturday</strong><span>Your example gathering</span></div><div className="program-rooms"><span/><span>The commons</span><span>The studio</span></div><div className="program-row"><time>10:00</time><div className="program-session program-session-lilac"><span>Conversation</span><strong>{ideas[0]}</strong><span><Check className="h-3 w-3"/> Community interest: {votes[0]} votes</span></div><div className="program-session program-session-mint"><span>Workshop</span><strong>{ideas[2]}</strong><span><Check className="h-3 w-3"/> Community interest: {votes[2]} votes</span></div></div><div className="program-break"><time>11:00</time><span>Take a breath. Meet someone new.</span></div><div className="program-row"><time>11:30</time><div className="program-session program-session-yellow"><span>Discussion</span><strong>{ideas[1]}</strong><span><Check className="h-3 w-3"/> Community interest: {votes[1]} votes</span></div><div className="program-open">Leave a little space for the unexpected.</div></div></div>
      <p className="mt-5 text-sm">An illustration of a program, not an automatic ranking.</p>
    </>}
  </div>

  return <section id="how-it-works" className="gathering-story">
    <div className="story-heading"><h2>A program shaped<br/>by the people in it.</h2><p>From “what if” to “see you there.”<br/>Here’s how it comes together.</p></div>
    <div className="story-layout"><div className="story-stage"><nav aria-label="How it works chapters" className="story-chapters">{chapters.map((chapter, i) => <a key={chapter.name} href={`#chapter-${i}`} onClick={() => { interacting.current = false; setActive(i) }} aria-current={active === i ? 'step' : undefined}><span>{i + 1}</span>{chapter.name}</a>)}</nav>{demo(active)}</div><div className="story-copy">{chapters.map((chapter, i) => <article key={chapter.name} id={`chapter-${i}`} ref={el => { steps.current[i] = el }} className={cn('story-chapter', active === i && 'is-active')}><div className="chapter-number" aria-hidden="true">0{i + 1}</div><h3>{chapter.title}</h3><p>{chapter.text}</p><p className="chapter-detail">{chapter.detail}</p><div className="chapter-prompt"><ArrowDown className="h-4 w-4"/>{chapter.prompt}</div><div className="story-mobile-demo">{demo(i, true)}</div></article>)}</div></div>
    <div className="story-closing"><p>The structure holds the space.<br/>The people make the gathering.</p><Link href="/create" className="bold-cta">Make space for your people <ArrowUpRight className="h-5 w-5"/></Link></div>
  </section>
}
