import { useEffect, useState } from 'react'
import { type BuildView, isOpenBuild } from '../../lib/build-display'
import { fetchBuild } from '../../server/builds'
import { useNow, usePoll } from '../poll'

// The build page's one live value: the build as the loader read it, re-read
// every few seconds while it is still open. `open` gates both the poll and the
// ticking clock, so a finished build costs nothing to leave on screen.

export function useLiveBuild(
  name: string,
  initial: BuildView,
): { build: BuildView; open: boolean; now: number | null } {
  const [build, setBuild] = useState(initial)
  useEffect(() => {
    setBuild(initial)
  }, [initial])

  const open = isOpenBuild(build.state)
  const now = useNow(open)

  usePoll(
    async () => {
      const b = await fetchBuild({ data: { app: name, id: build.id } }).catch(() => null)
      if (b !== null) setBuild(b)
    },
    3000,
    open,
  )

  return { build, open, now }
}
