import type { Tone } from '../tone'

// One verdict over every machine's Lemonade, for the AI row's dot on the
// rail: green when every server that should run runs, amber when something
// wants a look (an update, an install the agent cannot manage, a report that
// is not current, nobody logged on, a server its user quit), red when one that
// should run does not. Pure: host/providers/status.ts gathers the facts.

export type LemonadeFacts = {
  /** The machine, as the pages name it. */
  name: string
  /** Connected, and its last providers document is recent. */
  current: boolean
  /** What its agent last reported of Lemonade; null when it finds none. */
  report: {
    running: boolean
    /** The agent found the install itself (and so can manage it). */
    managed: boolean
    noUserSession: boolean
    manualOff: boolean
    wanted: 'start' | 'stop' | null
  } | null
  /** The policy's word: run it, pin a release. */
  wanted: 'start' | 'stop' | null
  pinned: boolean
  /** A newer stable release than the one it runs is published. */
  updateAvailable: boolean
}

export type StatusDot = { tone: Extract<Tone, 'ok' | 'warn' | 'bad'>; reasons: string[] }

/** One machine's verdict and why, or null for a machine with no Lemonade and nothing asked of it. */
function verdict(f: LemonadeFacts): { tone: StatusDot['tone']; reason: string | null } | null {
  const r = f.report
  const wanted = r?.wanted ?? f.wanted
  if (r === null && wanted === null && !f.pinned) return null
  if (!f.current) return { tone: 'warn', reason: 'no current report' }
  if (r === null) {
    return wanted === 'start'
      ? { tone: 'bad', reason: 'wanted, not installed' }
      : { tone: 'warn', reason: 'pinned, not installed' }
  }
  if (r.noUserSession) return { tone: 'warn', reason: 'nobody is logged on' }
  if (r.manualOff) return { tone: 'warn', reason: 'quit by its user' }
  if (wanted === 'start' && !r.running) return { tone: 'bad', reason: 'wanted, not running' }
  if (!r.managed) return { tone: 'warn', reason: 'an install the agent cannot manage' }
  if (f.updateAvailable) return { tone: 'warn', reason: 'an update is available' }
  return { tone: 'ok', reason: null }
}

const RANK = { ok: 0, warn: 1, bad: 2 } as const

/** The dot over every machine, or null when none has Lemonade or is asked to. */
export function lemonadeDot(machines: readonly LemonadeFacts[]): StatusDot | null {
  let tone: StatusDot['tone'] | null = null
  const reasons: string[] = []
  for (const f of machines) {
    const v = verdict(f)
    if (v === null) continue
    if (tone === null || RANK[v.tone] > RANK[tone]) tone = v.tone
    if (v.reason !== null) reasons.push(`${f.name}: ${v.reason}`)
  }
  return tone === null ? null : { tone, reasons }
}
