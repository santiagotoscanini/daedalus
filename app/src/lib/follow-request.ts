// A verb that answers with a request id at once and reports how it went
// later, in a document the page reads again: a model loaded on a machine's
// provider, a Claude session resumed or stopped. The wait lives in the
// browser — it can be interrupted, and no server request is held open for
// it. The server side is two functions: one that sends and answers the id,
// and one readFn that says how that request stands (the controller's
// `actions.get`: one `ActionOutcome`, whichever document reports it), or
// null while the document does not list it yet. components/verb-request.ts
// is the hook.

import type { ActionOutcome } from '../host/controller/generated'

/**
 * Ask `get` every `intervalMs` until it names an ending, or `waitMs` passes. A
 * read that throws counts as "not yet": the answer may be one poll away.
 * Resolves, never rejects; `stop()` returning true ends it early, with the
 * work left to the machine.
 */
export async function followRequest(
  get: () => Promise<ActionOutcome | null>,
  opts: {
    waitMs: number
    intervalMs?: number
    onProgress?: (o: ActionOutcome) => void
    stop?: () => boolean
  },
): Promise<ActionOutcome> {
  const deadline = Date.now() + opts.waitMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1_000))
    if (opts.stop?.() === true) break
    const o = await get().catch(() => null)
    if (o === null) continue
    if (o.state !== 'running') return o
    opts.onProgress?.(o)
  }
  return {
    state: 'failed',
    detail: `no outcome within ${String(Math.round(opts.waitMs / 1000))} s; the machine may still finish it`,
  }
}
