import type { LogNeighbour } from '../../../components/logs'
import { DASH } from '../../../lib/format'
import { type Part, partById } from '../../../lib/hardware/catalog'

/* The part vocabulary is one module for every machine (components/part.tsx);
   these tabs keep reading it from here. */
export {
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
  PartHead,
  PartPhoto,
} from '../../../components/part'

/* ── shared ───────────────────────────────────────────────────────────── */

/* The board and row vocabulary every category page uses lives in
   components/tokens.ts. These tabs call four of them by their own longer
   names, which is why this is an aliased re-export rather than an import in
   each tab. */
export {
  EMPTY as VIZ_EMPTY,
  FOOT as BOARD_FOOT,
  LIST,
  MONO,
  MONO_FACE,
  NOTE as BOARD_NOTE,
  ROW,
  ROW_MAIN,
  ROW_N,
  ROW_SIDE,
  SUB as BOARD_SUB,
} from '../../../components/tokens'

/**
 * The host reader behind Disks, Pools and Backups.
 *
 * A neighbour on exactly the three tabs that depend on it, for the reason
 * `LogNeighbour` exists: when a temperature stops changing or a scrub date
 * goes stale, this is the log that says whether the thing that reads them ran.
 */
export const SYSTEM_SNAPSHOT: LogNeighbour = {
  source: { unit: 'daedalus-system-snapshot.service' },
  label: 'System snapshot',
  role: 'where these numbers come from',
  note: 'Runs smartctl, zpool and zfs as root every ten minutes and publishes the result, because this dashboard is a container and none of those three can be run from one. One line per run with the counts. It fails silently from the reader’s side: a stale file shows yesterday’s temperatures as though they were now. Its failures also send mail; see fleet.monitoredJobs in stacks/daedalus.',
}

/**
 * The two readers behind Host and Memory.
 *
 * Same argument as `SYSTEM_SNAPSHOT`: every number on those two tabs comes
 * from one of these, and without their logs a gauge that had quietly stopped
 * moving looks exactly like a machine that had quietly gone idle.
 */
export const HOST_READERS: readonly LogNeighbour[] = [
  {
    source: { container: 'node-exporter' },
    label: 'node-exporter',
    role: 'the host’s own numbers',
    note: 'CPU, load, memory, pressure stall, filesystems, hwmon temperatures and the NIC counters. It runs on --network=host because it reads the real /proc, /sys and interfaces; a bridge namespace would show it the container’s. That is why this is one of the few containers here with a published port rather than a traefik-net address.',
  },
  {
    source: { unit: 'host-liveness-exporter.service' },
    label: 'host-liveness-exporter',
    role: 'per-container CPU, memory and OOM kills',
    note: 'A timer, not a daemon: every 60s it walks the rootless cgroup tree under user@1000.service that no packaged exporter can see, and writes the result as a textfile for node-exporter to serve. That 60s tick is also why the per-container numbers here are quantised, so a short rate window over them is reading the timer rather than the workload. A container that vanishes from these panels is usually this not having run.',
  },
]

/** Hours → a duration phrase (`36h`, `12d`, `2.3y`). */
export function hours(h: number | null): string {
  if (h === null) return DASH
  if (h < 48) return `${String(h)}h`
  const years = h / 24 / 365
  return years >= 1 ? `${years.toFixed(1)}y` : `${String(Math.round(h / 24))}d`
}

/**
 * What each part IS, since no interface on the machine will say.
 *
 * SMBIOS knows the board, the cpu and the memory modules, and that is where
 * this page reads them from. It has never heard of the cooler, the case or
 * the power supply — nothing in a PC reports those — so those three, and the
 * memory kit's catalog entry, are CHOSEN here by catalog id
 * (lib/hardware/catalog.ts: the photo, the name
 * and the spec of every part this house has bought, one entry each). A
 * node chooses the same three on Settings › Machines; the box chooses them
 * in code, because the box is configuration.
 */
const BOX_PARTS = {
  case: 'jonsbo-n4',
  cooler: 'noctua-nh-l9x65',
  psu: 'evga-supernova-650-gm',
  memory: 'corsair-vengeance-lpx-64',
} as const

function chosen(id: string): Part {
  const p = partById(id)
  if (p === null) throw new Error(`the catalog has no part ${id}`)
  return p
}

export const PARTS = {
  case: chosen(BOX_PARTS.case),
  cooler: chosen(BOX_PARTS.cooler),
  psu: chosen(BOX_PARTS.psu),
  memory: chosen(BOX_PARTS.memory),
}
