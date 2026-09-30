import type { Ctx } from '../core/ctx'
import type { Tone } from '../lib/tone'
import { ControllerError, type SessionHostStatus } from './controller/wire'
import { type RootAnswer, runRoot } from './root'

// The session host (session-host/, nix/stacks/daedalus/session-host.nix): the
// box's own process that holds santree's terminals, which a machine reaches
// through its agent once its policy turns santree on. The controller reads its
// status file and writes its allow-list; the page reads the one through
// `santree.status` and restarts it through the root helper's
// `session-host-restart`, the only way a new build takes over. The restart
// ends every live terminal, so the page says how many before it asks.

/** The session host as Settings › Machines draws it: one line and the restart's confirm. */
export type SessionHostLine = {
  chip: string
  tone: Tone
  /** The running build; null without a status file. */
  version: string | null
  /** Values after it: the live terminals and the machines connected. */
  facts: string[]
  /** A newer build is installed; the restart applies it. */
  restartPending: boolean
  /** What the confirm step says before a restart. */
  confirm: string
  /** Why the controller cannot read the host or write its allow-list, when it cannot. */
  error: string | null
}

const CHIP: Record<SessionHostStatus['state'], { chip: string; tone: Tone }> = {
  running: { chip: 'running', tone: 'ok' },
  stale: { chip: 'not answering', tone: 'warn' },
  stopped: { chip: 'stopped', tone: 'bad' },
  missing: { chip: 'not running', tone: 'bad' },
}

const plural = (n: number, one: string) => `${String(n)} ${one}${n === 1 ? '' : 's'}`

export function sessionHostLine(s: SessionHostStatus): SessionHostLine {
  const up = s.state === 'running' || s.state === 'stale'
  const facts: string[] = []
  if (up) {
    facts.push(plural(s.livePtys, 'live terminal'))
    facts.push(
      s.connections.length === 0
        ? 'no machine connected'
        : s.connections.map((c) => `${c.name ?? c.node} (${String(c.count)})`).join(', '),
    )
  }
  return {
    ...CHIP[s.state],
    version: s.version,
    facts,
    restartPending: s.restartPending,
    confirm: restartConfirm(up ? s.livePtys : 0),
    error: s.error,
  }
}

function restartConfirm(livePtys: number): string {
  return livePtys === 0
    ? 'No terminal is live, so restarting the session host ends nothing.'
    : `Restarting the session host ends ${plural(livePtys, 'live terminal')}.`
}

/**
 * The line, or null on a box without a session host (the controller answers
 * `unavailable`), where the page shows nothing. A controller that cannot be
 * asked is a line that says why.
 */
export async function readSessionHost(
  ctx: Pick<Ctx, 'controller'>,
): Promise<SessionHostLine | null> {
  try {
    return sessionHostLine(await ctx.controller.santreeStatus())
  } catch (e) {
    if (e instanceof ControllerError && e.code === 'unavailable') return null
    return {
      chip: 'unknown',
      tone: 'muted',
      version: null,
      facts: [],
      restartPending: false,
      confirm: 'Restarting the session host ends every live terminal.',
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

/** The helper waits 150 s for the unit (session-host.nix `rootVerbs`); this is that and slack. */
const RESTART_WAIT_MS = 160_000

export async function restartSessionHost(
  ctx: Pick<Ctx, 'controller'>,
  input: { actor: string },
): Promise<RootAnswer> {
  console.info(`[session-host] restart asked by ${input.actor}`)
  return runRoot(ctx, 'session-host-restart', {}, RESTART_WAIT_MS)
}
