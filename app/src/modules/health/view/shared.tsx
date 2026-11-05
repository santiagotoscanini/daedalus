import type { ReactNode } from 'react'
import { CAPTION, FOOT } from '../../../components/tokens'
import type { VersionGap } from '../../../lib/dashboard/github'

export { VersionAside } from '../../../components/release-notes'

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
