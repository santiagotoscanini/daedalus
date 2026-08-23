import { useEffect, useRef, useState } from 'react'

// Polling a host-side status file, without being lied to by it.
//
// Every host action here is a file drop: the server function returns as soon
// as the request file is written, which is BEFORE the host has done anything —
// so for a second or two the status file still shows the PREVIOUS run's
// terminal state. A poller that trusts the file alone reads that stale `done`,
// declares victory, and flips the button back to idle while a multi-minute
// rebuild is just starting. That was the Apply bar's oldest bug.
//
// The fix is a claim: start() records the id the submit returned, and until
// the status file speaks for THAT id, whatever it says is somebody else's
// history — the poller keeps waiting. A status that stays foreign past
// `claimTimeoutMs` means the host agent never picked the request up (a crashed
// path unit), and settles as a synthesized failure rather than spinning
// forever.

type HostStatus = { id: string | null; state: string; error: string }

export function usePolledStatus<S extends HostStatus>(opts: {
  initial: S
  fetch: () => Promise<S>
  /** Settled = not running. Override for status shapes with more states. */
  isTerminal?: (s: S) => boolean
  /** Runs once per settle — router.invalidate lives in the caller. */
  onSettle?: (s: S) => void
  intervalMs?: number
  claimTimeoutMs?: number
}): {
  status: S
  running: boolean
  /**
   * Fire a host action. `submit` returns the request id to claim, or null
   * when the request was refused (the caller shows the reason); a throw
   * counts as refused.
   */
  start: (submit: () => Promise<string | null>) => void
} {
  const [status, setStatus] = useState<S>(opts.initial)
  const [claim, setClaim] = useState<{ id: string; at: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // The callbacks are fresh closures every render; going through a ref keeps
  // the poll effect from tearing down the interval on each one.
  const latest = useRef(opts)
  latest.current = opts

  const running = submitting || claim !== null || status.state === 'running'

  useEffect(() => {
    if (!running) return
    // Between click and claim there is no id to poll for — reading the file
    // now is exactly the stale-status bug this hook exists to prevent.
    if (submitting && claim === null) return

    const interval = setInterval(() => {
      void latest.current.fetch().then((s) => {
        const terminal = latest.current.isTerminal ?? ((x: S) => x.state !== 'running')

        if (claim === null) {
          // Watching a flow somebody else started (a page opened mid-apply).
          setStatus(s)
          if (terminal(s)) {
            setSubmitting(false)
            latest.current.onSettle?.(s)
          }
          return
        }

        if (s.id === claim.id) {
          setStatus(s)
          if (terminal(s)) {
            setClaim(null)
            setSubmitting(false)
            latest.current.onSettle?.(s)
          }
          return
        }

        if (Date.now() - claim.at > (latest.current.claimTimeoutMs ?? 60_000)) {
          // Synthesized rather than read: the file never mentioned our id, so
          // there is nothing true to show about this request except that the
          // host did not come for it. Every status shape here carries
          // state/error, which is all this writes.
          const timedOut = {
            ...s,
            id: claim.id,
            state: 'failed',
            error: 'the host did not pick this request up. Is its path unit alive?',
          } as S
          setClaim(null)
          setSubmitting(false)
          setStatus(timedOut)
          latest.current.onSettle?.(timedOut)
        }
        // Still foreign, still inside the pickup window: keep waiting.
      })
    }, latest.current.intervalMs ?? 2_000)

    return () => {
      clearInterval(interval)
    }
  }, [running, submitting, claim])

  return {
    status,
    running,
    start: (submit) => {
      setSubmitting(true)
      void submit()
        .then((id) => {
          if (id === null) setSubmitting(false)
          else setClaim({ id, at: Date.now() })
        })
        .catch(() => {
          // The caller's submit shows its own errors; here it just un-runs.
          setSubmitting(false)
        })
    },
  }
}
