/**
 * The Now line's copy, as a pure function (mobile shell design §1, §3.1).
 *
 * State in, one sentence out, `now` passed in — so every state can be asserted without a clock and
 * the component below it has nothing to decide. Nothing here is ever a count of other people's
 * votes: the states read a round's window and the viewer's own remaining credits, never a tally
 * (spec §5.3).
 */

import { plural } from '@/lib/format'

export type NowState =
  | 'voting-upcoming'
  | 'voting-open'
  | 'attendance-open'
  | 'waiting'
  | 'schedule-out'
  | 'over'

export interface NowLineInput {
  /** Gathering slug, for the action link. */
  slug: string
  /** The gathering's own name, used in the "over" sentence. */
  name: string
  /** `completed` / `archived`: the gathering is over. */
  eventStatus: string
  /** The schedule has been published. */
  schedulePublished: boolean
  /** The pre-event round, as `useVoting` reports it. */
  voting: {
    status: 'none' | 'upcoming' | 'open' | 'closed'
    opensAt: string | null
    closesAt: string | null
    /** The viewer's own remaining credits; null when signed out. */
    remaining: number | null
  }
  /** The attendance round (design §11) while it accepts votes. */
  attendance: { open: boolean; live: number; liveSaved: number }
  /** Sessions the viewer saved. */
  saved: number
  /** Approved + scheduled sessions. */
  sessions: number
  /** Members; null for non-members (the roster is members-only). */
  participants: number | null
  /** At least one session's feedback window is open. */
  feedbackOpen: boolean
}

export interface NowLineCopy {
  state: NowState
  /** The bold sentence. */
  headline: string
  /** The quieter second line: the counts. Empty when there is nothing to count. */
  second: string
  action: { label: string; href: string } | null
  /** The headline contains a countdown, so it has to be recomputed as the clock moves. */
  ticking: boolean
}

/**
 * "2 days 3 h" · "3 h 12 min" · "12 min 30 s" · "12 min" · "30 s" · "under a minute" · "now".
 * `precision: 'minute'` is what `prefers-reduced-motion` gets.
 */
export function formatCountdown(ms: number, precision: 'second' | 'minute' = 'second'): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'now'
  const total = Math.floor(ms / 1000)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0) return `${plural(days, 'day')} ${hours} h`
  if (hours > 0) return `${hours} h ${minutes} min`
  if (minutes > 0) return precision === 'second' ? `${minutes} min ${seconds} s` : `${minutes} min`
  return precision === 'second' ? `${seconds} s` : 'under a minute'
}

function at(iso: string | null): number | null {
  if (!iso) return null
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? t : null
}

/** The second line: sessions, and participants for members. A comma, never a middle dot. */
function counts(input: NowLineInput): string {
  const parts = [plural(input.sessions, 'session')]
  if (input.participants !== null) parts.push(plural(input.participants, 'person', 'people'))
  return parts.join(', ')
}

export function describeNow(input: NowLineInput, now: number, precision: 'second' | 'minute' = 'second'): NowLineCopy {
  const base = `/e/${input.slug}`
  const second = counts(input)
  const over = input.eventStatus === 'completed' || input.eventStatus === 'archived'

  // Happening now wins: a person standing in a room has one thing to do.
  if (input.attendance.open) {
    const live = input.attendance.live
    const headline =
      live === 0
        ? 'Happening now: nothing is in session.'
        : input.attendance.liveSaved > 0
          ? `Happening now: ${plural(live, 'session')}, ${input.attendance.liveSaved} you saved.`
          : `Happening now: ${plural(live, 'session')}.`
    return {
      state: 'attendance-open',
      headline,
      second,
      action: { label: 'My schedule', href: `${base}/schedule?view=mine` },
      ticking: false,
    }
  }

  if (over) {
    return {
      state: 'over',
      headline: `Thanks for being part of ${input.name}.`,
      second,
      action: input.feedbackOpen ? { label: 'Feedback', href: `${base}/schedule?view=mine` } : null,
      ticking: false,
    }
  }

  if (input.voting.status === 'open') {
    const closes = at(input.voting.closesAt)
    const left = input.voting.remaining
    const when = closes === null ? 'soon' : `in ${formatCountdown(closes - now, precision)}`
    const credits = left === null ? '' : ` — ${plural(left, 'credit')} left`
    return {
      state: 'voting-open',
      headline: `Voting closes ${when}${credits}.`,
      second,
      action: { label: 'Vote', href: `${base}/sessions` },
      ticking: closes !== null,
    }
  }

  if (input.voting.status === 'upcoming') {
    const opens = at(input.voting.opensAt)
    const when = opens === null ? 'soon' : `in ${formatCountdown(opens - now, precision)}`
    return {
      state: 'voting-upcoming',
      headline: `Voting opens ${when}.`,
      second,
      action: { label: 'Browse sessions', href: `${base}/sessions` },
      ticking: opens !== null,
    }
  }

  // Between rounds.
  if (input.schedulePublished) {
    return {
      state: 'schedule-out',
      headline:
        input.saved > 0
          ? `The schedule is out. ${plural(input.saved, 'session')} saved.`
          : 'The schedule is out. Save the sessions you want to be in.',
      second,
      action: { label: 'Schedule', href: `${base}/schedule` },
      ticking: false,
    }
  }
  return {
    state: 'waiting',
    headline:
      input.voting.status === 'closed'
        ? 'Voting has closed. The schedule is not out yet.'
        : 'The schedule is not out yet.',
    second,
    action: { label: 'Browse sessions', href: `${base}/sessions` },
    ticking: false,
  }
}

