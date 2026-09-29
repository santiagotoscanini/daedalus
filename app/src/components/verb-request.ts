import { useEffect, useRef, useState } from 'react'
import { followRequest, type VerbOutcome } from '../lib/follow-request'
import { errorText } from '../lib/redact'
import type { Result } from '../lib/result'

/**
 * lib/follow-request.ts as a hook: one request at a time, followed to its
 * ending in the browser, for a button that must say how its verb went. `outcome` is the last one
 * (or the running one), null before the first click; `send` answering not ok,
 * or throwing, is a refusal and never reached the machine.
 */
export function useVerbRequest(opts: {
  get: (request: string) => Promise<VerbOutcome | null>
  waitMs: number
  /** Once per ending — router.invalidate lives in the caller. */
  onSettle?: (o: VerbOutcome) => void
}): {
  busy: boolean
  outcome: VerbOutcome | null
  start: (send: () => Promise<Result<string>>) => void
} {
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<VerbOutcome | null>(null)
  const latest = useRef(opts)
  latest.current = opts
  const gone = useRef(false)
  useEffect(
    () => () => {
      gone.current = true
    },
    [],
  )

  return {
    busy,
    outcome,
    start: (send) => {
      setBusy(true)
      setOutcome({ state: 'running', detail: '' })
      void (async () => {
        let sent: Result<string>
        try {
          sent = await send()
        } catch (e) {
          sent = { ok: false, reason: errorText(e) }
        }
        const follow = (request: string) =>
          followRequest(() => latest.current.get(request), {
            waitMs: latest.current.waitMs,
            onProgress: (p) => {
              if (!gone.current) setOutcome(p)
            },
            stop: () => gone.current,
          })
        const o: VerbOutcome = sent.ok
          ? await follow(sent.value)
          : { state: 'refused', detail: sent.reason }
        if (gone.current) return
        setOutcome(o)
        setBusy(false)
        latest.current.onSettle?.(o)
      })()
    },
  }
}
