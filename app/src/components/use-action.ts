import { useRouter } from '@tanstack/react-router'
import { useCallback, useState, useTransition } from 'react'
import { errorText } from '../lib/redact'

// The common life of a button that asks the server for something: clear the
// last error, run the call, reload the page's loader so what it changed
// shows, or put the failure (through `errorText`) where the button can say
// it. `busy` is the transition's pending flag, so it stays up through the
// reload as well as the call.
//
// Deliberately NOT here, so those sites stay hand-written: a result's
// `{ ok: false, reason }` shown as the error, a success notice, a step
// between the call and the reload (closing an editor, clearing a field), a
// busy flag held in state and reset in `.finally` rather than a transition's
// pending flag (not interchangeable: a transition also holds through the
// render its updates cause), and any other error wording. Folding one of
// those in would change what that site does.

export function useAction() {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    (fn: () => Promise<unknown>) => {
      setError(null)
      start(async () => {
        try {
          await fn()
          await router.invalidate()
        } catch (e) {
          setError(errorText(e))
        }
      })
    },
    [router],
  )
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return { run, busy, error, clearError }
}
