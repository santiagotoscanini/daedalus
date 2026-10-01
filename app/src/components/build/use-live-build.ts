import { type BuildView, isOpenBuild } from '../../lib/build-display'
import { fetchBuild } from '../../server/builds'
import { useLiveValue, useNow } from '../poll'

// The build page's one live value: the build as the loader read it, re-read
// every few seconds while it is still open. `open` gates both the poll and the
// ticking clock, so a finished build costs nothing to leave on screen.

export function useLiveBuild(
  name: string,
  initial: BuildView,
): { build: BuildView; open: boolean; now: number | null } {
  const build = useLiveValue(
    initial,
    (b) => fetchBuild({ data: { app: name, id: b.id } }),
    3000,
    (b) => isOpenBuild(b.state),
  )
  const open = isOpenBuild(build.state)
  const now = useNow(open)
  return { build, open, now }
}
