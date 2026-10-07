import { NOTE } from '../../../components/tokens'
import { Chip } from '../../../components/viz'
import type { VersionGap } from '../../../lib/dashboard/github'

// What more than one Health tab draws with.

/**
 * A changelog's title: the project's short name and nothing else. The verdict
 * moved to the board's corner (`VersionAside`), where a long title used to
 * truncate it away.
 */
export function gapTitle(label: string, _gap: VersionGap): string {
  return label
}

/**
 * The running version and its verdict, as a board's aside: "2.0.1 · current"
 * in muted ink, or the version beside an amber "N behind". Never broken.
 */
export function VersionAside({ version, behind }: { version: string | null; behind: number }) {
  return (
    <span className={`${NOTE} inline-flex items-center gap-2 whitespace-nowrap`}>
      <span className="font-mono text-[0.72rem]">{version ?? 'version unknown'}</span>
      {behind === 0 ? <span>current</span> : <Chip tone="warn">{behind} behind</Chip>}
    </span>
  )
}
