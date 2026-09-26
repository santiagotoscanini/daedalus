// The Claude and Shotter pages' pure helpers: the version verdicts, the live
// session filter, the shot-run issue phrase.
//
// Types ONLY from lib/dashboard. The module behind them reads the host
// snapshot through node:fs, and a value import from there would put that in
// the browser bundle — see the warning at the foot of lib/dashboard/claude.ts.
// That is why these derived helpers live beside the view and not beside the
// loader.
import type { ClaudeData, ClaudeFacts, ClaudeSession } from '../../lib/dashboard/claude'
import type { VersionGap } from '../../lib/dashboard/github'
import type { ShotCounts } from '../../lib/dashboard/shotter'
import { num } from '../../lib/format'
import type { Tone } from '../../lib/tone'

/* ── derived from the payload ─────────────────────────────────────────────
   Beside the view rather than beside the loader, and not by preference: the
   loader's module reads the host snapshot through node:fs, so importing a
   value from it here is what takes the page down. */

/** Mid-turn now, by the session's own word or by its clock. */
export function working(session: Pick<ClaudeSession, 'status' | 'lastActivityAt'>): boolean {
  if (session.status === 'busy') return true
  return session.lastActivityAt !== null && Date.now() - session.lastActivityAt < 60_000
}

/** Sessions actually connected, newest first. */
export function liveSessions(facts: ClaudeFacts): ClaudeSession[] {
  return facts.sessions
    .filter((s) => s.alive)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

export type Verdict = { label: string; tone: Tone; note: string }

/**
 * The version verdict, and why it is three-way rather than two.
 *
 * "Behind" here means two different things and they have different remedies.
 * The flake being behind upstream is a `nix flake update` away and is what
 * every other service on this dashboard means by the word. The unit running
 * an OLDER build than the flake already holds is a restart away — and it is
 * the one that hides, because the store path is right, the rebuild succeeded,
 * and nothing anywhere says the process never came back onto it.
 */
export function versionVerdict(data: ClaudeData): Verdict {
  const { remote, cli } = data.facts
  if (remote.version !== null && cli.version !== null && remote.version !== cli.version) {
    return {
      label: 'restart pending',
      tone: 'warn',
      note: `The flake holds ${cli.version} and the running server is ${remote.version}, so this unit has not been restarted onto what the last rebuild built.`,
    }
  }
  if (data.gap.installed === null) return { label: 'unknown', tone: 'muted', note: '' }
  if (data.gap.latest === null) {
    return { label: 'unknown', tone: 'muted', note: data.gap.note ?? 'GitHub did not answer.' }
  }
  const behind = data.gap.behind.length
  return behind === 0
    ? { label: 'current', tone: 'ok', note: 'Nothing has been published above this one.' }
    : {
        label: behind === 1 ? '1 release behind' : `${String(behind)} releases behind`,
        tone: 'warn',
        note: '',
      }
}

/**
 * Simpler than the Claude verdict on purpose: shotter has no restart-pending
 * state to detect — the image tag embeds the pin, so a rebuild that moves it
 * rebuilds the image, and every run after that is on the new one.
 */
export function shotterVerdict(gap: VersionGap): Verdict {
  if (gap.installed === null) {
    return {
      label: 'unknown',
      tone: 'muted',
      note: 'The pin has not reached this container — a rebuild older than the env var.',
    }
  }
  if (gap.latest === null) {
    return { label: 'unknown', tone: 'muted', note: gap.note ?? 'GitHub did not answer.' }
  }
  const behind = gap.behind.length
  return behind === 0
    ? { label: 'current', tone: 'ok', note: 'Nothing has been published above this one.' }
    : {
        label: behind === 1 ? '1 release behind' : `${String(behind)} releases behind`,
        tone: 'warn',
        note: '',
      }
}

/** The counters that matter, compressed to one phrase; null = a clean page. */
export function issueSummary(c: ShotCounts): string | null {
  const parts = [
    c.consoleError > 0 ? `${num(c.consoleError)} console` : null,
    c.pageError > 0 ? `${num(c.pageError)} page-err` : null,
    c.requestFailed > 0 ? `${num(c.requestFailed)} req-failed` : null,
    c.http4xx > 0 ? `${num(c.http4xx)}× 4xx` : null,
    c.http5xx > 0 ? `${num(c.http5xx)}× 5xx` : null,
  ].filter((p) => p !== null)
  return parts.length === 0 ? null : parts.join(' · ')
}
