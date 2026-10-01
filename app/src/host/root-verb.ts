import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../core/ctx'
import { type Decoder, decode } from '../lib/contract/decode'
import { errorText } from '../lib/redact'
import { env } from './env'

// A root verb that reports as it runs — the image update; the build keeps a
// heartbeat reader of its own (host/build-verb.ts) — the way a page wants it:
// started through the controller's `root.run` with `detach` (the request is
// the payload, and the answer comes once the verb's unit has started), its
// progress and its end in `<verb>-status.json`, which the unit writes into the
// root-only verbs directory (nix daedalus-lib.nix `verbsDir`, mounted
// read-only at /verbs).
//
// The status file's `id` is the run's id: the page that started a run waits
// for the file to name it. Whether a `running` file is still true is not
// guessed from a clock: the controller holds every run it started
// (`root.follow`), and the helper's `status` knows whether the verb's unit
// runs at all. A file still saying `running` for a run that has ended — the
// box went down mid-run, and nothing was left to mark it — reads as failed.

/** What every verb's status carries; the rest is the verb's own. */
export type RootVerbStatus = {
  id: string | null
  state: string
  phase: string
  error: string
}

/** How a start went: the run's id, or why there is none. */
export type RootStart =
  | { ok: true; id: string }
  | { ok: false; code: 'busy' | 'unavailable'; reason: string }

type WithController = Pick<Ctx, 'controller'>

export type RootVerb<S extends RootVerbStatus> = {
  idle: S
  readStatus: (ctx: WithController) => Promise<S>
  start: (ctx: WithController, payload: string) => Promise<RootStart>
}

/** Throttled server-side complaint: a broken host agent says so once a minute. */
const lastLogged = new Map<string, number>()
function logOnce(file: string, message: string): void {
  const now = Date.now()
  if (now - (lastLogged.get(file) ?? 0) < 60_000) return
  lastLogged.set(file, now)
  console.error(`[root-verb] ${file}: ${message}`)
}

/** How long the helper's `status` may take before the file is believed as it is. */
const STATUS_WAIT_MS = 10_000

/**
 * Whether run `id` of `verb` has ended: from the controller's run store, else
 * (a controller that restarted forgot it) from whether the verb's unit runs
 * at all. Null when neither can say — the file is then believed.
 */
async function runEnded(
  ctx: WithController,
  verb: string,
  id: string,
): Promise<{ detail: string } | null> {
  const c = ctx.controller
  try {
    const f = await c.rootFollow(id, Number.MAX_SAFE_INTEGER)
    return f.run.outcome === null ? null : { detail: f.run.detail }
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'not_found')) return null
  }
  try {
    const s = await c.rootRun('status', {}, STATUS_WAIT_MS)
    const state = s.verbs.find((v) => v.verb === verb)?.activeState
    return state === 'inactive' || state === 'failed' ? { detail: '' } : null
  } catch {
    return null
  }
}

export function defineRootVerb<S extends RootVerbStatus>(opts: {
  /** The helper's verb, and the status file's stem: `<verb>-status.json`. */
  verb: string
  /**
   * The status file's shape. Every field is `optional(…, <resting value>)`,
   * so decoding `{}` IS the idle status.
   */
  status: Decoder<S>
  /** The words for a run that ended without its last status: what to check. */
  ended: (status: S) => string
}): RootVerb<S> {
  const file = `${opts.verb}-status.json`
  // Read per call rather than at module load, so tests can point it at a
  // temp directory; in the container the value never changes.
  const path = (): string => join(env.get('VERBS_DIR') ?? '/verbs', file)
  const idle = decode(opts.status, {})

  async function readFileStatus(): Promise<S> {
    let raw: string
    try {
      raw = await readFile(path(), 'utf8')
    } catch {
      // No status yet: this verb has never run here.
      return idle
    }
    // The file exists, so anything wrong with it is a broken agent rather
    // than a resting state: idle all the same, with a line saying which.
    try {
      return decode(opts.status, JSON.parse(raw))
    } catch (e) {
      logOnce(file, errorText(e))
      return idle
    }
  }

  return {
    idle,

    async readStatus(ctx) {
      const s = await readFileStatus()
      if (s.state !== 'running' || s.id === null) return s
      const ended = await runEnded(ctx, opts.verb, s.id)
      if (ended === null) return s
      const why = ended.detail === '' ? '' : ` (${ended.detail})`
      return { ...s, state: 'failed', error: `${opts.ended(s)}${why}` }
    },

    async start(ctx, payload) {
      try {
        const r = await ctx.controller.rootStart(opts.verb, {}, payload)
        if (r.outcome === null) return { ok: true, id: r.run }
        const reason = r.detail === '' ? `the ${opts.verb} was ${r.outcome}` : r.detail
        return { ok: false, code: r.outcome === 'refused' ? 'busy' : 'unavailable', reason }
      } catch (e) {
        return { ok: false, code: 'unavailable', reason: errorText(e) }
      }
    },
  }
}
