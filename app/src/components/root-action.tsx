import { useRef, useState } from 'react'
import type { RootAnswer } from '../host/root'
import { errorText } from '../lib/redact'

// A button that asks the root helper for one verb (host/root.ts) and shows its
// word. No status file and no polling: the server function answers when the
// verb's unit has finished, so the click's own promise is the whole flow —
// `running` until it settles, then the outcome. A rejection (the server
// function threw before the host was asked) is a failure with its message.

export function useRootAction(opts: { onSettle?: (a: RootAnswer) => void } = {}): {
  running: boolean
  /** The last click's answer, or null before the first. */
  answer: RootAnswer | null
  start: (submit: () => Promise<RootAnswer>) => void
} {
  const [running, setRunning] = useState(false)
  const [answer, setAnswer] = useState<RootAnswer | null>(null)
  const latest = useRef(opts)
  latest.current = opts

  const settle = (a: RootAnswer) => {
    setRunning(false)
    setAnswer(a)
    latest.current.onSettle?.(a)
  }

  return {
    running,
    answer,
    start: (submit) => {
      setRunning(true)
      setAnswer(null)
      void submit()
        .then(settle)
        .catch((e: unknown) => {
          settle({ outcome: 'failed', detail: errorText(e) })
        })
    },
  }
}
