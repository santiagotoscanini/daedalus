import { BoardGrid } from '../../../../components/viz'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { num } from '../../../../lib/format'
import type { Tone } from '../../../../lib/tone'
import {
  AppleShipsBoard,
  InstalledLatelyBoard,
  Panel,
  Panel2,
  ThisMacRunsBoard,
} from './macos-boards'
import { NotReadable } from './shared'

/* ── macOS ────────────────────────────────────────────────────────────── */

/**
 * The Mac's own tab: what macOS it runs, and what Apple has shipped since.
 *
 * A Mac has no BIOS list and no Windows Update; it has one number, and
 * Apple moves everything — the firmware, the kernel, Safari — by moving
 * it. So the tab answers the one question in Apple's own words: the
 * version running, the point releases of its line it has not taken, each
 * with its date, its build, what Apple fixed (the release notes) and what
 * it closed (the security content), and the next major waiting past them.
 * Beside that, what Software Update on the machine is actually offering,
 * which is the same thing from the other end.
 *
 * Nothing here installs anything: the agent is a daemon and Apple does
 * not let a daemon restart a Mac into an installer.
 */
export function NodeMacosView({ d }: { d: NodeSystemData }) {
  const f = nodeMacosFacts({ d })
  if (f === null) return null
  const { t } = f

  return (
    <BoardGrid>
      <ThisMacRunsBoard f={f} />

      <AppleShipsBoard f={f} />

      <Panel f={f} />

      <Panel2 f={f} />

      <InstalledLatelyBoard f={f} />

      <NotReadable t={t} />
    </BoardGrid>
  )
}

/** What the page's boards read. */
function nodeMacosFacts({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  const t = d.telemetry
  const m = d.macos
  if (t === null || status === null) return null
  const u = t.updates
  const pending = u?.pending ?? []
  const newest = m?.line[0] ?? null
  const behind = m?.line.length ?? 0
  const verdict: { tone: Tone; label: string } =
    m === null || m.error !== null
      ? { tone: 'muted', label: 'not checked' }
      : behind === 0 && m.next === null
        ? { tone: 'ok', label: 'newest' }
        : behind === 0
          ? { tone: 'info', label: `${m.next?.name ?? 'next major'} is out` }
          : { tone: behind >= 3 ? 'bad' : 'warn', label: `${num(behind)} behind` }
  // The history also holds XProtect and Safari; the OS's own line is what dates the Mac.
  const lastInstalled = u?.installed.find((x) => /^macOS/i.test(x.title)) ?? null
  return { d, node, status, t, m, u, pending, newest, behind, verdict, lastInstalled }
}

export type NodeMacosFacts = NonNullable<ReturnType<typeof nodeMacosFacts>>
