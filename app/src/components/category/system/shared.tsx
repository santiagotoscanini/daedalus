import { DASH } from '../../../lib/format'
import type { LogNeighbour } from '../../logs'

/* ── shared ───────────────────────────────────────────────────────────── */

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
 * Same argument as `SYSTEM_SNAPSHOT` and the same gap: every number on those
 * two tabs comes from one of these, and until now neither one's log was
 * reachable from anywhere in this dashboard — so a gauge that had quietly
 * stopped moving looked exactly like a machine that had quietly gone idle.
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

/** Seconds → a date, computed server-side is not needed: this is a duration. */
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
 * the power supply — nothing in a PC reports those — so those three are
 * written down here, and they are the only declared facts on the tab.
 *
 * Written down ONCE, next to the picture, rather than spread through the
 * markup: when one of them is replaced the edit is this table and nothing
 * else, and a part whose photo and specification live in the same object
 * cannot end up showing last year's cooler beside this year's numbers.
 */
type Part = {
  photo: { src: string; width: number; height: number } | null
  name: string
  detail: string
  specs: { k: string; v: string }[]
}

export const PARTS = {
  case: {
    photo: { src: '/part-case-jonsbo-n4.png', width: 700, height: 603 },
    name: 'Jonsbo N4',
    detail:
      'Steel and wood, six 3.5" bays. That is why this box is a NAS shape rather than a tower.',
    specs: [
      { k: 'Bays', v: '6 × 3.5" + 2 × 2.5"' },
      { k: 'Board', v: 'ITX / mATX' },
      { k: 'Size', v: '286 × 300 × 228 mm' },
      { k: 'Cooler clearance', v: '70 mm' },
      { k: 'PSU', v: 'SFX, up to 125 mm' },
    ],
  },
  memory: {
    photo: { src: '/part-ram-vengeance-lpx.png', width: 700, height: 256 },
    name: 'Corsair Vengeance LPX',
    detail:
      'Low-profile heat spreaders, which on a board this small is the specification that matters. A tall kit fouls the cooler.',
    specs: [],
  },
} satisfies Record<string, Part>

/** A part's photo and name, for the panels that have artwork. */
export function PartHead({ part }: { part: Part }) {
  return (
    <div className="part">
      <PartPhoto part={part} />
      <div className="part-id">
        <strong className="part-name">{part.name}</strong>
        <span className="part-detail">{part.detail}</span>
      </div>
    </div>
  )
}

export function PartPhoto({ part }: { part: Part }) {
  if (part.photo === null) return null
  return (
    <img
      className="part-photo"
      src={part.photo.src}
      alt=""
      width={part.photo.width}
      height={part.photo.height}
    />
  )
}
