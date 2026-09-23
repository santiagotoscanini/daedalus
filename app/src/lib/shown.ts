import { useState } from 'react'

/**
 * The value a control shows: what was just chosen, until the page catches
 * up — then whatever the page says.
 *
 * A switch or a picker here saves on the spot and the page re-reads
 * itself after (`router.invalidate()`); the fact it is drawn from arrives
 * with that read, on a tab that probes the LAN a second or two later. A
 * control that flips only then feels broken for exactly that long. So the
 * choice is shown at once and held until the saved fact CHANGES — to the
 * choice when the save went through, to something else when another hand
 * moved it — or until the save is over and reported a failure, when the
 * old fact is the truth again.
 */
export function useShown<T>(value: T, busy: boolean, failed = false): [T, (chosen: T) => void] {
  // The choice, and the fact it was made against; a fact that differs from
  // it is the page having caught up.
  const [held, hold] = useState<{ chosen: T; over: T } | null>(null)
  const caughtUp = held !== null && !Object.is(value, held.over)
  const gaveUp = held !== null && !busy && failed
  if (caughtUp || gaveUp) hold(null)
  const shown = held === null || caughtUp || gaveUp ? value : held.chosen
  return [shown, (chosen) => hold({ chosen, over: value })]
}
