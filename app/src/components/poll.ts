import { useEffect, useRef, useState } from 'react'

// The two client-side clocks this dashboard runs: one that ticks, and one that
// asks.
//
// Both were written out per page — the same six lines of `setInterval`,
// `clearInterval` and a cleanup, four times — and the copies had quietly
// stopped agreeing: three of the four pollers fire again on schedule whether
// or not the previous request has come back, so one slow answer leaves several
// in flight at once and the newest one to return wins, which is not the newest
// one sent.

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
 * The in-flight guard is the reason this is a hook rather than four
 * `setInterval`s. These poll server functions that read a host file or a
 * database, on a 2–3s tick against a box that is often rebuilding: a request
 * that takes longer than the interval used to be overlapped by the next one,
 * and since nothing ordered the answers, a slow reply landing after a fast one
 * would put the OLDER state on the page and leave it there until the next
 * tick. Skipping a tick while one is outstanding costs at most one period of
 * latency and cannot reorder anything.
 *
 * `fn` is read through a ref: it is a fresh closure every render, and taking it
 * as a dependency would tear the interval down and restart it on each one —
 * a poll that never quite reaches its own period. The ref means every tick
 * still calls the NEWEST closure, so the values it reads are current.
 */
export function usePoll(fn: () => Promise<void>, ms: number, active: boolean): void {
  const latest = useRef(fn)
  latest.current = fn

  useEffect(() => {
    if (!active) return
    let inFlight = false
    const t = setInterval(() => {
      if (inFlight) return
      inFlight = true
      void latest.current().finally(() => {
        inFlight = false
      })
    }, ms)
    return () => {
      clearInterval(t)
    }
  }, [active, ms])
}
