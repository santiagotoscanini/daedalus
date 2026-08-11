// What the host knows about itself and no scrape can reach.
//
// Published by daedalus-system-snapshot (stacks/daedalus/host/system-snapshot.sh)
// because this app is a container: `smartctl` needs root and a raw device,
// `zpool status` needs the pool, and `usedbysnapshots` is a ZFS property
// rather than a filesystem statistic. Every one of those is a fact about the
// machine that prometheus has no collector for.
//
// Read at most once per TTL, and a failed read keeps the previous answer —
// same rule as images.ts, and for a sharper reason here: a missing snapshot
// would blank three tabs at once, and a file that is ten minutes stale about
// facts which move in hours is strictly better than that.

import { readFile } from 'node:fs/promises'

export type SmartDisk = {
  device: string
  model: string | null
  family: string | null
  serial: string | null
  firmware: string | null
  sizeBytes: number | null
  /** RPM, or 0/null for solid state. */
  rotationRate: number | null
  /** The drive's own one-word verdict. Null = could not be asked. */
  passed: boolean | null
  temperature: number | null
  powerOnHours: number | null
  powerCycles: number | null
  /** ATA. The two that actually predict a failing disk. */
  reallocated: number | null
  pending: number | null
  uncorrectable: number | null
  /** ATA. A CABLE fault, not a disk one — different remedy. */
  crcErrors: number | null
  /** NVMe. Write endurance consumed, not disk usage — the spec named it badly. */
  percentageUsed: number | null
  spareAvailable: number | null
  mediaErrors: number | null
  unsafeShutdowns: number | null
  criticalWarning: number | null
  /** Newest first, as the drive stores it. */
  selfTests: {
    type: string | null
    status: string | null
    passed: boolean
    /** The drive's power-on hours WHEN THE TEST RAN — it has no calendar. */
    hours: number | null
  }[]
}

export type ZpoolFacts = {
  name: string
  sizeBytes: number
  allocBytes: number
  freeBytes: number
  fragPct: number | null
  capacityPct: number
  health: string
  state: string | null
  vdevs: { name: string; state: string | null }[]
  scrub: {
    state: string | null
    startedAt: number | null
    endedAt: number | null
    examined: number | null
    errors: number | null
  } | null
}

export type DatasetFacts = {
  name: string
  usedBytes: number
  snapshotBytes: number
  referencedBytes: number
  availableBytes: number
  mountpoint: string | null
  snapshots: number
}

export type ReplicationPair = {
  source: string
  target: string
  sourceLatest: string | null
  sourceAt: number | null
  targetLatest: string | null
  targetAt: number | null
  targetSnapshots: number
  /** Null = one side could not be read, which is not "up to date". */
  lagSeconds: number | null
}

/**
 * What the machine IS, from SMBIOS.
 *
 * None of it changes between reboots, which is exactly why it was missing:
 * every other number here moves, so the reader was built for things that
 * move. The dashboard could report the cpu at 40% without being able to say
 * which cpu, and 64 GB in use without being able to say what is in the slots
 * or how many are free.
 *
 * `null` throughout rather than optional, because a field that is absent and
 * a field that could not be read must render the same way — as a dash, not as
 * a gap in the layout.
 */
export type MemoryModule = {
  locator: string | null
  sizeGb: number | null
  type: string | null
  speedMts: number | null
  manufacturer: string | null
  partNumber: string | null
  rank: number | null
}

export type Hardware = {
  board: {
    vendor: string | null
    model: string | null
    version: string | null
    /**
     * Read and not compared against anything. MSI publishes no
     * machine-readable feed of BIOS releases, so a "2 behind" verdict here
     * would mean scraping a vendor page that changes shape without notice —
     * and a version panel that lies is worse than one that only states what
     * is installed.
     */
    bios: { vendor: string | null; version: string | null; date: string | null }
  }
  chassis: { vendor: string | null }
  cpu: {
    model: string | null
    socket: string | null
    cores: number | null
    threads: number | null
    maxMhz: number | null
  }
  memory: {
    slots: number | null
    maxCapacityGb: number | null
    populated: number | null
    totalGb: number | null
    modules: MemoryModule[]
  }
}

export const NO_HARDWARE: Hardware = {
  board: {
    vendor: null,
    model: null,
    version: null,
    bios: { vendor: null, version: null, date: null },
  },
  chassis: { vendor: null },
  cpu: { model: null, socket: null, cores: null, threads: null, maxMhz: null },
  memory: { slots: null, maxCapacityGb: null, populated: null, totalGb: null, modules: [] },
}

export type HostFacts = {
  disks: SmartDisk[]
  pools: ZpoolFacts[]
  datasets: DatasetFacts[]
  replication: ReplicationPair[]
  generations: { id: number; date: string; current: boolean }[]
  kernel: string | null
  hardware: Hardware
}

export const NO_FACTS: HostFacts = {
  disks: [],
  pools: [],
  datasets: [],
  replication: [],
  generations: [],
  kernel: null,
  hardware: NO_HARDWARE,
}

const TTL_MS = 60_000
let cache: { at: number; facts: HostFacts } | null = null

export async function hostFacts(): Promise<HostFacts> {
  const now = Date.now()
  if (cache !== null && now - cache.at < TTL_MS) return cache.facts

  try {
    const raw = await readFile(process.env.HOST_FACTS_PATH ?? '/system/system.json', 'utf8')
    const parsed = JSON.parse(raw) as HostFacts
    // `hardware` is younger than this file's other keys, so a snapshot written
    // by the previous version of the script has none — and the whole point of
    // keeping a stale snapshot on a failed read is that the page stays up.
    // Defaulting it here means an old file costs a few dashes, not a crash in
    // every consumer that reaches for `hardware.board`.
    const facts: HostFacts = { ...parsed, hardware: parsed.hardware ?? NO_HARDWARE }
    cache = { at: now, facts }
    return facts
  } catch {
    if (cache !== null) return cache.facts
    cache = { at: now, facts: NO_FACTS }
    return NO_FACTS
  }
}
