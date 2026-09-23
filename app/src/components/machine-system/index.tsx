import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { NodeBoardView } from './board'
import { NodeBuildView } from './build'
import { NodeDisksView } from './disks'
import { NodeHostView } from './host'
import { NodeMemoryView } from './memory'
import { NoDocument } from './shared'
import { NodeUpdatesView } from './updates'

export { BoxHead, MachineHead } from './shared'

// The System page for a machine that is not this box: the box's own tabs,
// drawn from the one document its agent publishes.
//
// Same tab ids as the box's manifest (modules/system/manifest.ts) where
// the subject is the same — Host, Memory, Disks, Build, Updates — so a URL
// with `?tab=memory` means the memory of whichever machine is picked, and
// switching the picker keeps the tab. Pools and Backups are the box's
// alone: a laptop has no ZFS and nothing here replicates it.

export const NODE_TABS = [
  { id: 'host', label: 'Host', boardSpans: [8, 4, 4, 4, 4, 8, 4, 12] },
  { id: 'memory', label: 'Memory', boardSpans: [8, 4, 4, 8] },
  { id: 'disks', label: 'Disks', boardSpans: [4, 4, 4, 12] },
  { id: 'build', label: 'Build', boardSpans: [4, 4, 4, 6, 6, 12] },
  { id: 'board', label: 'Motherboard', boardSpans: [4, 8, 12] },
  { id: 'updates', label: 'Updates', boardSpans: [12, 12, 6, 6] },
  // Who maintains it, as on the box: the remote-control server the agent's
  // tray runs there. Drawn by components/claude-node.tsx from the node's
  // Claude report rather than from the telemetry document.
  {
    id: 'claude',
    label: 'Claude',
    icon: 'claude' as const,
    boardSpans: [6, 6, 12, 6],
    dividerBefore: true,
  },
] as const

export type NodeTabId = (typeof NODE_TABS)[number]['id']

export function resolveNodeTab(tab: string | undefined): NodeTabId {
  return NODE_TABS.find((t) => t.id === tab)?.id ?? 'host'
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
      ) : tab === 'board' ? (
        <NodeBoardView d={d} />
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
