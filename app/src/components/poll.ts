import { useEffect, useRef, useState } from 'react'

// The two client-side clocks this dashboard runs: one that ticks, and one that
// asks.

/**
 * `Date.now()` after mount only, ticking every second while `active`.
 *
 * Null through the server render AND the first client render, so both produce
 * the same markup and hydration has nothing to disagree about. A duration or a
 * countdown computed from `Date.now()` during render is the classic way to
 * break that — and a running build's elapsed time rendered on the server would
 * never match the client's anyway.
 */
export function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const t = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(t)
    }
  }, [active])
  return now
}

/**
 * Call `fn` every `ms` while `active`, never twice at once.
 *
 * The in-flight guard is the point. Callers poll server functions that read a
 * host file or a database, on a 3–5s tick against a box that is often
 * rebuilding: without it a request slower than the interval is overlapped by
 * the next one, and since nothing orders the answers, a slow reply landing
 * after a fast one would put the OLDER state on the page until the next tick.
 * Skipping a tick while one is outstanding costs at most one period of
 * latency and cannot reorder anything.
 *
 * `fn` is read through a ref: it is a fresh closure every render, and taking it
 * as a dependency would tear the interval down and restart it on each one —
 * a poll that never quite reaches its own period. The ref means every tick
 * still calls the NEWEST closure, so the values it reads are current.
 *
 * A tab nobody can see asks nothing: ticks are skipped while the document is
 * hidden, and the first thing it does on coming back is ask once, so what
 * shows is current rather than up to a period old.
 */
export function usePoll(fn: () => Promise<void>, ms: number, active: boolean): void {
  const latest = useRef(fn)
  latest.current = fn

  useEffect(() => {
    if (!active) return
    let inFlight = false
    const tick = () => {
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      void latest.current().finally(() => {
        inFlight = false
      })
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    const t = setInterval(tick, ms)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, ms])
}

/**
 * A loader value kept live: `initial` until the loader hands over a new one,
 * replaced by what `fetch` answers every `ms` while `active` says the value
 * can still move. `fetch` is given the value it is replacing; a failed or null read
 * keeps it, and the next tick asks again.
 */
export function useLiveValue<T>(
  initial: T,
  fetch: (current: T) => Promise<T | null>,
  ms: number | ((current: T) => number),
  active: (current: T) => boolean,
): T {
  const [value, setValue] = useState(initial)
  useEffect(() => {
    setValue(initial)
  }, [initial])

  usePoll(
    async () => {
      const next = await fetch(value).catch(() => null)
      if (next !== null) setValue(next)
    },
    typeof ms === 'number' ? ms : ms(value),
    active(value),
  )
  return value
}
