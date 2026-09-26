import type { LogNeighbour } from '../../../components/logs'

// What the Monitoring tabs draw with: the row-list vocabulary every tab
// shares, the severity → tone map (Alerts only) and the scrape exporters'
// log neighbours (Metrics only).

/* A flat list of named things, each led by a chip saying what kind it is and
   trailed by whatever detail that kind has. Rows of a table, not a stack of
   pills: a hairline between rows says the same thing at a fraction of the ink.
   The row rules hang off the list so the <li>s stay bare. */
export const LIST =
  'flex list-none flex-col [&>li]:flex [&>li]:min-w-0 [&>li]:items-center [&>li]:gap-[0.45rem] [&>li]:px-[0.1rem] [&>li]:py-[0.34rem] [&>li]:text-[0.77rem] [&>li+li]:border-t [&>li+li]:border-(--border-soft)'
/* The name takes the slack, so the detail is pushed right without a spacer.
   Both truncate: one long row must not widen the panel. */
export const MAIN = 'min-w-0 flex-auto truncate text-foreground'
export const SIDE =
  'max-w-[60%] min-w-0 flex-[0_1_auto] truncate text-[0.68rem] tabular-nums text-(--dim)'
export const NUM = 'min-w-[1.4rem] text-right tabular-nums text-foreground'

export const SEVERITY: Record<string, 'bad' | 'warn' | 'info'> = {
  critical: 'bad',
  serious: 'bad',
  warning: 'warn',
  info: 'info',
}

/**
 * The two things that produce most of what prometheus stores.
 *
 * Neither has a page anywhere and neither ever will — they are exporters, not
 * services anybody opens — but both are exactly the "you would come looking
 * here when the panel above went wrong" case that `LogNeighbour` is for: much
 * of the System category is drawn from them.
 */
export const SCRAPE_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'node-exporter' },
    label: 'node-exporter',
    role: 'the host’s own numbers',
    note: 'Everything the System › Host and Memory tabs draw: CPU, memory, filesystems, the NIC counters and the pressure stall figures. It runs on --network=host because it reads the real /proc, /sys and interfaces, which is also why it is the one target here published on a port rather than dialled over a bridge.',
  },
  {
    source: { unit: 'host-liveness-exporter.service' },
    label: 'host-liveness-exporter',
    role: 'per-container metrics, and the uplink probe',
    note: 'A timer, not a daemon: every 60s it walks the rootless cgroup tree that no packaged exporter can see (container CPU, memory, PIDs and OOM kills for all ~75 containers), pings the gateway and the internet for the Network › General dot, and writes a textfile for node-exporter to pick up. A metric here that stops moving is this not having run, and it looks identical to a container that is idle.',
  },
]
