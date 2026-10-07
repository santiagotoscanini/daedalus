import { MONO, NOTE } from '../../../components/tokens'
import type { VersionGap } from '../../../lib/dashboard/github'

// What more than one Health tab draws with.

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
