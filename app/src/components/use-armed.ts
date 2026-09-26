import { useCallback, useEffect, useState } from 'react'

// The first half of every two-step button: armed, and disarmed again on its
// own after `ms` if nobody confirms. A press that costs something shows its
// cost first and must not stay loaded while the operator looks away — which
// is the whole of what this holds. Re-arming the same key does not restart
// the clock; arming a different one does.

/** One armed thing out of many, by key — `null` when nothing is armed. */
export function useArmedKey<K>(ms: number): [K | null, (key: K) => void, () => void] {
  const [armed, setArmed] = useState<K | null>(null)

  useEffect(() => {
    if (armed === null) return
    const t = setTimeout(() => {
      setArmed(null)
    }, ms)
    return () => {
      clearTimeout(t)
    }
  }, [armed, ms])

  const arm = useCallback((key: K) => {
    setArmed(() => key)
  }, [])
  const disarm = useCallback(() => {
    setArmed(null)
  }, [])
  return [armed, arm, disarm]
}

/** A single control's armed state. */
export function useArmed(ms: number): [boolean, () => void, () => void] {
  const [armed, armKey, disarm] = useArmedKey<true>(ms)
  const arm = useCallback(() => {
    armKey(true)
  }, [armKey])
  return [armed !== null, arm, disarm]
}
