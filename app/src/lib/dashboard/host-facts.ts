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

export type HostFacts = {
  disks: SmartDisk[]
  pools: ZpoolFacts[]
  datasets: DatasetFacts[]
  replication: ReplicationPair[]
  generations: { id: number; date: string; current: boolean }[]
  kernel: string | null
}

export const NO_FACTS: HostFacts = {
  disks: [],
  pools: [],
  datasets: [],
  replication: [],
  generations: [],
  kernel: null,
}

const TTL_MS = 60_000
let cache: { at: number; facts: HostFacts } | null = null

export async function hostFacts(): Promise<HostFacts> {
  const now = Date.now()
  if (cache !== null && now - cache.at < TTL_MS) return cache.facts

  try {
    const raw = await readFile(process.env.HOST_FACTS_PATH ?? '/system/system.json', 'utf8')
    const facts = JSON.parse(raw) as HostFacts
    cache = { at: now, facts }
    return facts
  } catch {
    if (cache !== null) return cache.facts
    cache = { at: now, facts: NO_FACTS }
    return NO_FACTS
  }
}
