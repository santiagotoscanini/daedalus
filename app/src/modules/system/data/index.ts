// The System module's data half: the machine itself, a tab per layer.
//
// It was one page trying to be six. Host vitals, container memory, pool
// capacity, log volume and probe counts all shared a scroll, which meant none
// of them had room to say anything and two of them did not belong there at all
// — "is anything failing to report" is Monitoring's question, not this page's.
//
// ── where each tab's numbers come from ────────────────────────────────────
//
// Host, Memory and Database are pure prometheus: node_exporter, the cgroup
// reader in host-liveness-exporter, and postgres_exporter respectively. There
// is nothing to publish for them because they are already scraped every 60s.
//
// Disks, Pools and Backups are the opposite: SMART, self-test history, scrub
// state, `usedbysnapshots` and replication lag have NO prometheus collector on
// this box, and three of them need root and a raw device. Those come from the
// host snapshot — see lib/dashboard/host-facts and the script it documents.
//
// ── a note on container memory, because it looks alarming and is not ──────
//
// `container_memory_usage_bytes` is cgroup v2's memory.current, which INCLUDES
// page cache. A container doing file I/O sits at its limit forever and is
// perfectly healthy — the cache is reclaimed under pressure. The signal that a
// cap is genuinely too tight is container_oom_kills_total moving, which is why
// that counter is on the page and "percent of limit" is not.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type BackupsData, loadBackups } from './backups'
import { type BuildData, loadBuild } from './build'
import { type DatabaseData, loadDatabase } from './database'
import { type DisksData, loadDisks } from './disks'
import { type HostData, loadHost } from './host'
import { loadMemory, type MemoryData } from './memory'
import { loadPools, type PoolsData } from './pools'
import { loadUpdates, type UpdatesData } from './updates'

export type Tabs = {
  host: HostData
  memory: MemoryData
  disks: DisksData
  pools: PoolsData
  build: BuildData
  database: DatabaseData
  updates: UpdatesData
  backups: BackupsData
}
export type SystemData = TabPayload<typeof manifest, Tabs>

// No tab here reads the env: every number is prometheus's or the host
// snapshot's, so the loaders take nothing from the Ctx they are handed.
export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  host: loadHost,
  memory: loadMemory,
  disks: loadDisks,
  pools: loadPools,
  build: loadBuild,
  database: loadDatabase,
  updates: loadUpdates,
  backups: loadBackups,
})

export type { HostFacts } from '../../../lib/dashboard/host-facts'
