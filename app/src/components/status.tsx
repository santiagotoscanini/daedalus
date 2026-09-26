import { useEffect, useRef, useState } from 'react'
import { errorText } from '../lib/redact'
import type { Result } from '../lib/result'

// Polling a host-side status file, without being lied to by it.
//
// Every host action here is a file drop: the server function returns as soon
// as the request file is written, which is BEFORE the host has done anything —
// so for a second or two the status file still shows the PREVIOUS run's
// terminal state. A poller that trusts the file alone reads that stale `done`,
// declares victory, and flips the button back to idle while a multi-minute
// rebuild is just starting.
//
// The fix is a claim: start() records the id the submit returned, and until
// the status file speaks for THAT id, whatever it says is somebody else's
// history — the poller keeps waiting. A status that stays foreign past
// `claimTimeoutMs` means the host agent never picked the request up (a crashed
// path unit), and settles as a synthesized failure rather than spinning
// forever.
//
// The other half is `refusal`: a request that never became a run at all. The
// host can decline one (already busy, nothing to do) and the server function
// can throw before the host is even asked (an app that builds from source has
// no image to pull; a repo is not one of this box's). Both live here rather
// than in each caller, so no button can swallow the throw and spin, reset and
// say nothing. A submit is a Result and a rejection becomes one, so there is
// no path out of this hook that leaves a failure unsaid.

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
  /** Why the last click never became a run, or null. Render it. */
  refusal: string | null
  /**
   * Fire a host action. `submit` resolves with the request id to claim, or
   * with the reason it was refused; a rejection is a refusal too, and its
   * message becomes the reason.
   */
  start: (submit: () => Promise<Result<string>>) => void
} {
  const [status, setStatus] = useState<S>(opts.initial)
  const [claim, setClaim] = useState<{ id: string; at: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)

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
    refusal,
    start: (submit) => {
      setSubmitting(true)
      setRefusal(null)
      void submit()
        .then((r) => {
          if (r.ok) setClaim({ id: r.value, at: Date.now() })
          else {
            setSubmitting(false)
            setRefusal(r.reason)
          }
        })
        .catch((e: unknown) => {
          // A rejection means the request was never published, so there is no
          // id to claim and no status file that will ever mention this click.
          // The message is the only account of it there will be.
          setSubmitting(false)
          setRefusal(errorText(e))
        })
    },
  }
}
