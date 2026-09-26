import type { NodeSystemData } from '../../lib/dashboard/node-system'
import type { NavIconName } from '../nav-icon'
import { NodeBoardView } from './board'
import { NodeBrowsersView } from './browsers'
import { NodeBuildView } from './build'
import { NodeDisksView } from './disks'
import { NodeGraphicsView } from './graphics'
import { NodeHostView } from './host'
import { NodeMacosView } from './macos'
import { NodeMemoryView } from './memory'
import { NoDocument } from './shared'
import { NodeSoftwareView } from './software'
import { NodeUpdatesView } from './updates'

export { BoxHead, MachineHead } from './shared'

// The System page for a machine that is not this box, drawn from the one
// document its agent publishes — and shaped to the KIND of machine.
//
// Three kinds of node, three tab rows. Four tabs are the machine as a
// machine and are the same everywhere: Host, Memory, Disks, Build, with the
// box's ids so `?tab=memory` means the memory of whichever machine is picked.
// After them the row is the operating system's own story:
//
// - a Windows PC has a motherboard whose maker publishes firmware, a
//   graphics card whose driver is the thing a gamer updates, a software
//   inventory where runtimes and games live, and Windows Update;
// - a Mac has none of that. Its firmware moves with macOS, Apple publishes
//   one list of what is newer with notes, and its apps come from the App
//   Store, Homebrew and a folder; so it gets macOS and Apps;
// - any other OS gets Motherboard and Updates only.
//
// The box itself is not a node: its row, with pools, backups and the browser
// lab, is modules/system/manifest.ts.
//
// Claude and Chromium close every row: the remote-control server and the
// sessions' eyes exist on each machine.

export type NodeTabSpec = {
  id: string
  label: string
  boardSpans: readonly number[]
  icon?: NavIconName
  dividerBefore?: boolean
  /** Opens with a ServiceHead, which the skeleton has to know. */
  head?: boolean
}

const HOST: NodeTabSpec = { id: 'host', label: 'Host', boardSpans: [8, 4, 4, 4, 4, 8, 4, 12] }
const MEMORY: NodeTabSpec = { id: 'memory', label: 'Memory', boardSpans: [8, 4, 4, 8] }
const DISKS: NodeTabSpec = { id: 'disks', label: 'Disks', boardSpans: [4, 4, 4, 12] }
const BUILD: NodeTabSpec = { id: 'build', label: 'Build', boardSpans: [4, 4, 4, 4, 4, 4, 12] }
const BOARD: NodeTabSpec = { id: 'board', label: 'Motherboard', boardSpans: [4, 8, 12] }
const GRAPHICS: NodeTabSpec = { id: 'graphics', label: 'Graphics', boardSpans: [8, 4, 6, 6] }
const SOFTWARE: NodeTabSpec = {
  id: 'software',
  label: 'Software',
  boardSpans: [4, 4, 4, 6, 6, 12],
}
const UPDATES: NodeTabSpec = { id: 'updates', label: 'Updates', boardSpans: [4, 8, 12, 6, 6] }
const MACOS: NodeTabSpec = { id: 'macos', label: 'macOS', boardSpans: [4, 8, 12, 6, 6] }
const APPS: NodeTabSpec = { id: 'apps', label: 'Apps', boardSpans: [4, 4, 4, 12] }
// Who maintains it, as on the box: the remote-control server the agent's
// tray runs there. Drawn by components/claude-node.tsx from the node's
// Claude report rather than from the telemetry document.
const CLAUDE: NodeTabSpec = {
  id: 'claude',
  label: 'Claude',
  icon: 'claude',
  boardSpans: [6, 6, 12, 6],
  dividerBefore: true,
}
// The sessions' eyes, as Shotter is on the box: the Chromium-based
// browsers the machine has, against what their vendors ship today.
const BROWSERS: NodeTabSpec = {
  id: 'browsers',
  label: 'Chromium',
  boardSpans: [6, 6, 12],
  head: true,
}

const WINDOWS_TABS: readonly NodeTabSpec[] = [
  HOST,
  MEMORY,
  DISKS,
  BUILD,
  BOARD,
  GRAPHICS,
  SOFTWARE,
  UPDATES,
  CLAUDE,
  BROWSERS,
]
const MACOS_TABS: readonly NodeTabSpec[] = [
  HOST,
  MEMORY,
  DISKS,
  BUILD,
  MACOS,
  APPS,
  CLAUDE,
  BROWSERS,
]
const OTHER_TABS: readonly NodeTabSpec[] = [
  HOST,
  MEMORY,
  DISKS,
  BUILD,
  BOARD,
  UPDATES,
  CLAUDE,
  BROWSERS,
]

export function nodeTabsFor(os: string): readonly NodeTabSpec[] {
  return os === 'windows' ? WINDOWS_TABS : os === 'macos' ? MACOS_TABS : OTHER_TABS
}

export type NodeTabId =
  | 'host'
  | 'memory'
  | 'disks'
  | 'build'
  | 'board'
  | 'graphics'
  | 'software'
  | 'updates'
  | 'macos'
  | 'apps'
  | 'claude'
  | 'browsers'

// Switching the picker keeps the tab. Where the other machine has no such
// tab, the nearest subject is opened rather than Host: Updates on the box
// or the PC is macOS on the Mac, and the Mac's Apps are the PC's Software.
const NEAREST: Record<string, Record<string, NodeTabId>> = {
  macos: { updates: 'macos', board: 'macos', software: 'apps', graphics: 'apps' },
  windows: { macos: 'updates', apps: 'software' },
}

export function resolveNodeTab(os: string, tab: string | undefined): NodeTabId {
  const tabs = nodeTabsFor(os)
  const hit = tabs.find((t) => t.id === tab)
  if (hit !== undefined) return hit.id as NodeTabId
  const near = tab === undefined ? undefined : NEAREST[os]?.[tab]
  return near !== undefined && tabs.some((t) => t.id === near) ? near : 'host'
}

export function MachineSystemView({ d, tab }: { d: NodeSystemData; tab: NodeTabId }) {
  const ready = d.status !== null && d.telemetry !== null
  return (
    <>
      {!ready ? (
        <NoDocument d={d} />
      ) : tab === 'memory' ? (
        <NodeMemoryView d={d} />
      ) : tab === 'disks' ? (
        <NodeDisksView d={d} />
      ) : tab === 'browsers' ? (
        <NodeBrowsersView d={d} />
      ) : tab === 'board' ? (
        <NodeBoardView d={d} />
      ) : tab === 'graphics' ? (
        <NodeGraphicsView d={d} />
      ) : tab === 'software' || tab === 'apps' ? (
        <NodeSoftwareView d={d} />
      ) : tab === 'macos' ? (
        <NodeMacosView d={d} />
      ) : tab === 'build' ? (
        <NodeBuildView d={d} />
      ) : tab === 'updates' ? (
        <NodeUpdatesView d={d} />
      ) : (
        <NodeHostView d={d} />
      )}
    </>
  )
}
