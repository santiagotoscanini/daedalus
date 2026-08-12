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

import { swrValue } from '../cache'
import { arrayOf, bool, type Decoder, nullable, num, obj, optional, str } from '../contract/decode'
import { readSnapshot } from '../contract/snapshot'

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

/** A unit systemd reports as failed, named — the count alone sends you hunting. */
export type FailedUnit = {
  unit: string
  description: string | null
  activeState: string | null
  subState: string | null
}

/**
 * One timer and how its last run ended.
 *
 * `result`/`exitStatus` default to success/0 on a service that has never run
 * — systemd's defaults, not a claim — so `lastAt` is what says whether they
 * mean anything: null lastAt is a timer that has not fired since boot.
 */
export type JobRun = {
  timer: string
  service: string | null
  /** Epoch seconds. Null = no next elapse scheduled. */
  nextAt: number | null
  /** Epoch seconds. Null = never fired since boot. */
  lastAt: number | null
  result: string | null
  exitStatus: number | null
}

export type HostFacts = {
  disks: SmartDisk[]
  pools: ZpoolFacts[]
  datasets: DatasetFacts[]
  replication: ReplicationPair[]
  generations: { id: number; date: string; current: boolean }[]
  kernel: string | null
  hardware: Hardware
  failedUnits: FailedUnit[]
  jobs: JobRun[]
}

export const NO_FACTS: HostFacts = {
  disks: [],
  pools: [],
  datasets: [],
  replication: [],
  generations: [],
  kernel: null,
  hardware: NO_HARDWARE,
  failedUnits: [],
  jobs: [],
}

// Shorthands: the snapshot script emits null for anything a tool would not
// say, and a key can be absent entirely when written by an older script —
// both must land as null, because a dash and a crash are different products.
const ns = optional(nullable(str), null)
const nn = optional(nullable(num), null)
const nb = optional(nullable(bool), null)

const smartDisk: Decoder<SmartDisk> = obj({
  device: str,
  model: ns,
  family: ns,
  serial: ns,
  firmware: ns,
  sizeBytes: nn,
  rotationRate: nn,
  passed: nb,
  temperature: nn,
  powerOnHours: nn,
  powerCycles: nn,
  reallocated: nn,
  pending: nn,
  uncorrectable: nn,
  crcErrors: nn,
  percentageUsed: nn,
  spareAvailable: nn,
  mediaErrors: nn,
  unsafeShutdowns: nn,
  criticalWarning: nn,
  selfTests: optional(
    arrayOf(obj({ type: ns, status: ns, passed: optional(bool, false), hours: nn })),
    [],
  ),
})

const zpool: Decoder<ZpoolFacts> = obj({
  name: str,
  sizeBytes: num,
  allocBytes: num,
  freeBytes: num,
  fragPct: nn,
  capacityPct: num,
  health: str,
  state: ns,
  vdevs: optional(arrayOf(obj({ name: str, state: ns })), []),
  scrub: optional(
    nullable(obj({ state: ns, startedAt: nn, endedAt: nn, examined: nn, errors: nn })),
    null,
  ),
})

const dataset: Decoder<DatasetFacts> = obj({
  name: str,
  usedBytes: num,
  snapshotBytes: num,
  referencedBytes: num,
  availableBytes: num,
  mountpoint: ns,
  snapshots: num,
})

const replicationPair: Decoder<ReplicationPair> = obj({
  source: str,
  target: str,
  sourceLatest: ns,
  sourceAt: nn,
  targetLatest: ns,
  targetAt: nn,
  targetSnapshots: num,
  lagSeconds: nn,
})

const hardware: Decoder<Hardware> = obj({
  board: obj({
    vendor: ns,
    model: ns,
    version: ns,
    bios: obj({ vendor: ns, version: ns, date: ns }),
  }),
  chassis: obj({ vendor: ns }),
  cpu: obj({ model: ns, socket: ns, cores: nn, threads: nn, maxMhz: nn }),
  memory: obj({
    slots: nn,
    maxCapacityGb: nn,
    populated: nn,
    totalGb: nn,
    modules: optional(
      arrayOf(
        obj({
          locator: ns,
          sizeGb: nn,
          type: ns,
          speedMts: nn,
          manufacturer: ns,
          partNumber: ns,
          rank: nn,
        }),
      ),
      [],
    ),
  }),
})

const hostFactsShape = obj({
  disks: optional(arrayOf(smartDisk), []),
  pools: optional(arrayOf(zpool), []),
  datasets: optional(arrayOf(dataset), []),
  replication: optional(arrayOf(replicationPair), []),
  generations: optional(arrayOf(obj({ id: num, date: str, current: optional(bool, false) })), []),
  kernel: ns,
  // A snapshot written by an older script has no hardware key at all; the
  // page must cost a few dashes then, not a crash in every consumer that
  // reaches for `hardware.board`.
  hardware: optional(hardware, NO_HARDWARE),
  // Same rule for the two newest keys: absent from an older snapshot means
  // empty, not broken.
  failedUnits: optional(
    arrayOf(obj({ unit: str, description: ns, activeState: ns, subState: ns })),
    [],
  ),
  jobs: optional(
    arrayOf(obj({ timer: str, service: ns, nextAt: nn, lastAt: nn, result: ns, exitStatus: nn })),
    [],
  ),
})

const TTL_MS = 60_000

// A failed read keeps the previous answer (lib/cache.ts) — a missing snapshot
// would blank three tabs at once. A decode error still surfaces in the log.
const cached = swrValue({ ttlMs: TTL_MS, retryMs: TTL_MS }, async () => {
  const result = await readSnapshot({
    path: process.env.HOST_FACTS_PATH ?? '/system/system.json',
    decoder: hostFactsShape,
    fallback: NO_FACTS,
    // Written every 10 minutes; twice that plus slack means the timer stopped.
    maxAgeMs: 25 * 60_000,
  })
  return result.available ? result.data : null
})

export async function hostFacts(): Promise<HostFacts> {
  return (await cached()) ?? NO_FACTS
}
