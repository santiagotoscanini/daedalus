import type { Tone } from '../tone'

// One verdict over every machine's Lemonade, for the AI row's dot on the
// rail: green when every server that should run runs, amber when something
// wants a look (an update, an install the agent cannot manage, an agent too
// old to report one, a report that is not current, nobody logged on, a server
// its user quit), red when one that should run does not. Pure:
// host/providers/status.ts gathers the facts.
//
// Only machines the box has a stake in count: one that offers Lemonade to the
// gateway (its policy), or one the box asked to run it or pinned a release
// on. A laptop with Lemonade installed for its own use is that machine's
// business, whatever its agent reports of it.

/**
 * What the agent can say of the install: `found` (it read the install's own
 * record, and can manage it), `none` (it speaks install and power and found
 * no record — an older installer), `unreported` (its agent predates install
 * and power, or has not said hello since the controller started).
 */
export type InstallKnown = 'found' | 'none' | 'unreported'

export type LemonadeFacts = {
  /** The machine, as the pages name it. */
  name: string
  /** Its policy offers its Lemonade to the gateway (Settings › Machines). */
  offered: boolean
  /** Connected, and its last providers document is recent. */
  current: boolean
  /** What its agent last reported of Lemonade; null when it finds none. */
  report: {
    running: boolean
    install: InstallKnown
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

/** One machine's verdict and why, or null for a machine the box has no stake in. */
function verdict(f: LemonadeFacts): { tone: StatusDot['tone']; reason: string | null } | null {
  const r = f.report
  const wanted = r?.wanted ?? f.wanted
  if (!f.offered && wanted === null && !f.pinned) return null
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
  if (r.install === 'unreported') {
    return { tone: 'warn', reason: 'its agent is too old to report the install; update the agent' }
  }
  if (r.install === 'none') return { tone: 'warn', reason: 'an install the agent cannot manage' }
  if (f.updateAvailable) return { tone: 'warn', reason: 'an update is available' }
  return { tone: 'ok', reason: null }
}

const RANK = { ok: 0, warn: 1, bad: 2 } as const

/** The dot over every machine, or null when none the box has a stake in has Lemonade. */
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

/**
 * What the agent can say of the install, from whether it speaks install and
 * power (`speaks`: null without a hello) and what it reported.
 */
export function installKnown(
  speaks: boolean | null,
  install: object | null | undefined,
): InstallKnown {
  if (speaks !== true) return 'unreported'
  return install == null ? 'none' : 'found'
}
