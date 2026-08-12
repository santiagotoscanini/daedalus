import { type DatasetFacts, hostFacts, type ZpoolFacts } from '../../host-facts'

/* ── Pools ────────────────────────────────────────────────────────────── */

export type PoolsData = {
  pools: ZpoolFacts[]
  datasets: DatasetFacts[]
  /** Total snapshot bytes across every dataset — the growth to watch. */
  snapshotBytes: number
  snapshots: number
}

export async function loadPools(): Promise<PoolsData> {
  const facts = await hostFacts()
  // Only the datasets that are their own thing: a pool root reports its
  // children's usage as well, so including it double-counts every number
  // beside it.
  const datasets = facts.datasets.filter((d) => d.name.includes('/'))

  return {
    pools: facts.pools,
    datasets: [...datasets].sort((a, b) => b.usedBytes - a.usedBytes),
    snapshotBytes: datasets.reduce((n, d) => n + d.snapshotBytes, 0),
    snapshots: datasets.reduce((n, d) => n + d.snapshots, 0),
  }
}
