import type { ReactNode } from 'react'
import type { LogNeighbour } from '../../../components/logs'
import { Pulse } from '../../../components/viz'

// What the Monitoring tabs draw with: the row-list vocabulary every tab
// shares, the severity → tone map (Alerts only) and the scrape exporters'
// log neighbours (Metrics only).

/* A flat list of named things, each led by a chip saying what kind it is and
   trailed by whatever detail that kind has. Rows of a table, not a stack of
   pills: a hairline between rows says the same thing at a fraction of the ink.
   The row rules hang off the list so the <li>s stay bare. */
export const LIST =
  'flex list-none flex-col [&>li]:flex [&>li]:min-w-0 [&>li]:items-center [&>li]:gap-2 [&>li]:px-0.5 [&>li]:py-2 [&>li]:text-[0.8rem] [&>li+li]:border-t [&>li+li]:border-hairline'
/* The name takes the slack, so the detail is pushed right without a spacer.
   Both truncate: one long row must not widen the panel. */
export const MAIN = 'min-w-0 flex-auto truncate text-foreground'
export const SIDE =
  'max-w-[60%] min-w-0 flex-[0_1_auto] truncate text-[0.75rem] tabular-nums text-muted-foreground'
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

/**
 * The all-clear, said in one line instead of a board.
 *
 * "Nothing firing" and "every target reporting" are the normal state, and a
 * half-page board holding one centred sentence spent the page's best space on
 * the absence of news. When something IS wrong the board comes back with the
 * list in it; until then this is a quiet line across the top of the grid.
 */
export function AllClear({
  title,
  detail,
  aside,
  note,
}: {
  title: string
  detail: ReactNode
  aside?: ReactNode
  /** The why: a second line of visible text, because touch has no hover. */
  note?: string
}) {
  return (
    <p className="col-span-12 m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.84rem] text-muted-foreground">
      <Pulse on={false} tone="ok" />
      <span className="text-foreground [font-weight:560]">{title}</span>
      <span>{detail}</span>
      {aside !== undefined && (
        <span className="ml-auto text-[0.75rem] text-muted-foreground">{aside}</span>
      )}
      {note !== undefined && (
        <span className="basis-full max-w-[40rem] text-[0.78rem] leading-[1.5] text-muted-foreground">
          {note}
        </span>
      )}
    </p>
  )
}
