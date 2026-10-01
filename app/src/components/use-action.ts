import { useRouter } from '@tanstack/react-router'
import { useCallback, useState, useTransition } from 'react'
import { isRecord } from '../lib/is-record'
import { errorText } from '../lib/redact'

// The one life of a button that asks the server for something: clear the
// last error and notice, run the call, then either show what went wrong or
// finish — the caller's `onDone` step (close an editor, clear a field,
// navigate), a success `notice`, and a reload of the page's loader so what it
// changed shows. `busy` is the transition's pending flag, so it stays up
// through the reload and the render it causes as well as the call.
//
// What counts as failure: a throw, shown through `errorText`, and a
// Result-shaped refusal (`{ ok: false, reason }`, lib/result.ts), shown as
// its reason. A refusal still reloads — the box answered, and what it
// refused against may be newer than the page — but skips `onDone` and the
// notice. `invalidate: false` is for a call that changes nothing the loader
// reads (a reveal) or that leaves the page (`onDone` navigates).

type Refused = { ok: false; reason: string }

type ActionOptions<T> = {
  /** A step after success and before the reload. */
  onDone?: (value: Exclude<T, Refused>) => unknown
  /** Said in `notice` once the call has succeeded. */
  notice?: string | ((value: Exclude<T, Refused>) => string)
  /** Reload the page's loader afterwards. Default true. */
  invalidate?: boolean
}

const refusal = (v: unknown): string | null =>
  isRecord(v) && v.ok === false && typeof v.reason === 'string' ? v.reason : null

export function useAction() {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const run = useCallback(
    <T>(fn: () => Promise<T>, opts: ActionOptions<T> = {}) => {
      setError(null)
      setNotice(null)
      start(async () => {
        try {
          const out = await fn()
          const refused = refusal(out)
          if (refused !== null) {
            setError(refused)
          } else {
            const value = out as Exclude<T, Refused>
            await opts.onDone?.(value)
            if (opts.notice !== undefined) {
              setNotice(typeof opts.notice === 'string' ? opts.notice : opts.notice(value))
            }
          }
          if (opts.invalidate !== false) await router.invalidate()
        } catch (e) {
          setError(errorText(e))
        }
      })
    },
    [router],
  )
  const clear = useCallback(() => {
    setError(null)
    setNotice(null)
  }, [])

  return { run, busy, error, notice, clear }
}
