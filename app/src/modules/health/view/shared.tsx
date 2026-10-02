import { FOOT_BASE, MONO, NOTE } from '../../../components/tokens'
import type { VersionGap } from '../../../lib/dashboard/github'

// What more than one Health tab draws with.

/* The one caption on these pages that is not grey. It states its own ink over
   the colourless base rather than layering a second text utility over `FOOT`,
   where source order in the emitted stylesheet — not the order in the string —
   would pick the winner. */
export const FOOT_WARN = `${FOOT_BASE} text-warning`

/** `<label> — current` or `<label> — N releases behind`: the verdict in the title. */
export function gapTitle(label: string, gap: VersionGap): string {
  const n = gap.behind.length
  if (n === 0) return `${label} — current`
  return `${label} — ${String(n)} ${n === 1 ? 'release behind' : 'releases behind'}`
}

/** The running version as a board's aside. */
export function VersionAside({ version }: { version: string | null }) {
  return (
    <span className={NOTE}>
      {version === null ? 'version unknown' : <span className={MONO}>{version}</span>}
    </span>
  )
}
