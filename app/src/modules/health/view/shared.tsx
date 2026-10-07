import type { ReactNode } from 'react'
import { CAPTION, FOOT, NOTE } from '../../../components/tokens'
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
 * Without `behind`, the version alone — for a board whose verdict the page
 * header already gives.
 */
export function VersionAside({ version, behind }: { version: string | null; behind?: number }) {
  return (
    <span className={`${NOTE} inline-flex items-center gap-2 whitespace-nowrap`}>
      <span className="font-mono text-[0.72rem]">{version ?? 'version unknown'}</span>
      {behind === undefined ? null : behind === 0 ? (
        <span>current</span>
      ) : (
        <Chip tone="warn">{behind} behind</Chip>
      )}
    </span>
  )
}

/**
 * A log board's foot with one service-specific note added: the default
 * caption and explanation (components/logs.tsx), then this tab's note — so a
 * tab that moves a fact out of its header loses nothing it would have shown.
 */
export function LogFoot({ container, children }: { container: string; children: ReactNode }) {
  return (
    <>
      <p className={CAPTION}>
        Rendered by Grafana from <code>{container}</code>, newest first.
      </p>
      <p className={FOOT}>
        The default is seven days because most services here are quiet between restarts, and a short
        window shows nothing for a service that is perfectly healthy. If the frame shows a login
        screen, open Grafana once in a tab: it needs a session it cannot obtain inside itself,
        because the IdP refuses to be framed.
      </p>
      <p className={FOOT}>{children}</p>
    </>
  )
}
