// The scheduler's rate-limited logging, shared by the tick (scheduler.ts), the
// dispatcher (dispatch.ts) and the sweep (sweep.ts). The memory of what was
// logged lives on the SchedulerState it is handed, never here, so a Vite
// re-evaluation of any of these files forgets nothing.

import { errorText } from '../../lib/redact'
import type { SchedulerState } from './scheduler'

/** A failure of one kind is logged at most once per this. */
export const LOG_EVERY_MS = 60 * 60_000

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Log a failure once per kind per LOG_EVERY_MS. */
export function logOnce(state: SchedulerState, kind: string, message: string, now = Date.now()) {
  const last = state.logged[kind]
  if (isNum(last) && now - last < LOG_EVERY_MS) return
  const keys = Object.keys(state.logged)
  if (keys.length > 200) {
    for (const k of keys) {
      const at = state.logged[k]
      if (!isNum(at) || now - at >= LOG_EVERY_MS) delete state.logged[k]
    }
  }
  state.logged[kind] = now
  console.warn(`[builds] ${message}`)
}

export async function quietly(state: SchedulerState, kind: string, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (e) {
    logOnce(state, kind, `${kind} failed: ${errorText(e)}`)
  }
}
