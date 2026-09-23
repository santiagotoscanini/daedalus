import { useEffect, useState } from 'react'

// A deferred value as a plain value: undefined until the promise first
// settles, the last answer while the next one is in flight, and remembered
// across navigations by key.
//
// For the places that render ONE element from a streamed value and have
// nothing to put in its place — the account button at the rail's foot.
// <Await> there would draw the same element as a Suspense fallback and
// again as the content, and the swap between the two is a remount, which
// closes the menu if it is open when the account lands.

const memory = new Map<string, unknown>()

export function useSettled<T>(key: string, promise: Promise<T>): T | undefined {
  const [, tick] = useState(0)
  useEffect(() => {
    let live = true
    promise.then(
      (v) => {
        if (!live) return
        memory.set(key, v)
        tick((n) => n + 1)
      },
      () => {
        // A failed read leaves the last answer standing; the next loader run
        // brings a new promise.
      },
    )
    return () => {
      live = false
    }
  }, [key, promise])
  return typeof window === 'undefined' ? undefined : (memory.get(key) as T | undefined)
}
