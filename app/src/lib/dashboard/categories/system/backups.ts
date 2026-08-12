import { hostFacts, type ReplicationPair } from '../../host-facts'

/* ── Backups ──────────────────────────────────────────────────────────── */

/**
 * What survives this machine, and what does not.
 *
 * The second half is the point and is the reason this is a tab rather than a
 * panel on Pools. Replication is easy to show and easy to believe: syncoid
 * exits 0 on a run that copied nothing, the replica MIRRORS the source rather
 * than archiving it, and both pools are in the same box on the same shelf. The
 * list of things no snapshot covers is the honest other half.
 */
export type BackupsData = {
  pairs: ReplicationPair[]
  /** Datasets enrolled in snapshots, and those deliberately not. */
  coverage: { name: string; snapshots: number; usedBytes: number }[]
  unsnapshotted: { name: string; usedBytes: number }[]
  totalReplicatedBytes: number
}

export async function loadBackups(): Promise<BackupsData> {
  const facts = await hostFacts()
  const datasets = facts.datasets.filter((d) => d.name.includes('/'))

  return {
    pairs: facts.replication,
    coverage: datasets
      .filter((d) => d.snapshots > 0)
      .map((d) => ({ name: d.name, snapshots: d.snapshots, usedBytes: d.usedBytes }))
      .sort((a, b) => b.usedBytes - a.usedBytes),
    unsnapshotted: datasets
      .filter((d) => d.snapshots === 0)
      .map((d) => ({ name: d.name, usedBytes: d.usedBytes }))
      .sort((a, b) => b.usedBytes - a.usedBytes),
    totalReplicatedBytes: facts.replication.reduce((n, p) => {
      const target = facts.datasets.find((d) => d.name === p.target)
      return n + (target?.usedBytes ?? 0)
    }, 0),
  }
}
