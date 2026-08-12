// The System category: the machine itself, a tab per layer.
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
// host snapshot — see ../host-facts and the script it documents.
//
// ── a note on container memory, because it looks alarming and is not ──────
//
// `container_memory_usage_bytes` is cgroup v2's memory.current, which INCLUDES
// page cache. A container doing file I/O sits at its limit forever and is
// perfectly healthy — the cache is reclaimed under pressure. The signal that a
// cap is genuinely too tight is container_oom_kills_total moving, which is why
// that counter is on the page and "percent of limit" is not.

import { bytes } from '../../format'
import { promBars, promScalar, promScalars, promSeries, promVector } from '../../prom'
import type { VersionGap } from '../github'
import {
  type DatasetFacts,
  type Hardware,
  type HostFacts,
  hostFacts,
  type ReplicationPair,
  type SmartDisk,
  type ZpoolFacts,
} from '../host-facts'
import { postgresGap } from '../postgres'

export type SystemData =
  | ({ tab: 'host' } & HostData)
  | ({ tab: 'memory' } & MemoryData)
  | ({ tab: 'disks' } & DisksData)
  | ({ tab: 'pools' } & PoolsData)
  | ({ tab: 'build' } & BuildData)
  | ({ tab: 'database' } & DatabaseData)
  | ({ tab: 'backups' } & BackupsData)

export async function loadSystem(tab: string): Promise<SystemData> {
  switch (tab) {
    case 'memory':
      return { tab: 'memory', ...(await loadMemory()) }
    case 'build':
      return { tab: 'build', ...(await loadBuild()) }
    case 'disks':
      return { tab: 'disks', ...(await loadDisks()) }
    case 'pools':
      return { tab: 'pools', ...(await loadPools()) }
    case 'database':
      return { tab: 'database', ...(await loadDatabase()) }
    case 'backups':
      return { tab: 'backups', ...(await loadBackups()) }
    default:
      return { tab: 'host', ...(await loadHost()) }
  }
}

/* ── Host ─────────────────────────────────────────────────────────────── */

type HostData = {
  cpuPct: number | null
  cpuSpark: number[]
  cores: number | null
  load: { m1: number | null; m5: number | null; m15: number | null }
  uptimeSeconds: number | null
  kernel: string | null
  temps: { label: string; value: number }[]
  /**
   * Pressure-stall: the share of the last ten seconds in which SOMETHING was
   * waiting on cpu, io or memory.
   *
   * The number load average was always a proxy for, and a better one — load
   * counts runnable tasks, which on a 16-thread box says nothing without
   * knowing what they were waiting for. Everything here is normally zero;
   * these panels exist for the day one of them is not.
   */
  pressure: { cpu: number | null; io: number | null; memory: number | null }
  containers: { total: number | null; down: string[] }
  failedUnits: number | null
  /**
   * Every boot generation on the box.
   *
   * `configurationLimit = 10` bounds the BOOT MENU, not the profile — a
   * distinction nothing on this box surfaced, and the count below is usually
   * the surprise.
   */
  generations: { id: number; date: string; current: boolean }[]
}

async function loadHost(): Promise<HostData> {
  const [vitals, cpuSpark, temps, pressure, containerUp, failedUnits, facts] = await Promise.all([
    promScalars({
      cpu: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
      load1: 'node_load1',
      load5: 'node_load5',
      load15: 'node_load15',
      uptime: 'node_time_seconds - node_boot_time_seconds',
      cores: 'count(count by (cpu) (node_cpu_seconds_total))',
    }),
    promSeries('100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))', 6 * 60, 120),
    promVector('node_hwmon_temp_celsius'),
    promScalars({
      cpu: '100 * rate(node_pressure_cpu_waiting_seconds_total[5m])',
      io: '100 * rate(node_pressure_io_waiting_seconds_total[5m])',
      memory: '100 * rate(node_pressure_memory_waiting_seconds_total[5m])',
    }),
    promVector('container_up'),
    promScalar('systemd_failed_units'),
    hostFacts(),
  ])

  return {
    cpuPct: vitals.cpu,
    cpuSpark,
    cores: vitals.cores,
    load: { m1: vitals.load1, m5: vitals.load5, m15: vitals.load15 },
    uptimeSeconds: vitals.uptime,
    kernel: facts.kernel,
    // Labelled by chip: the sensor names alone (`temp1`, `temp3`) say nothing
    // about what is being measured.
    temps: temps
      .map((t) => ({
        label: `${(t.metric.chip ?? '?').replace(/^platform_/, '').replace(/_/g, ' ')} ${
          t.metric.sensor ?? ''
        }`.trim(),
        value: Number(t.value[1]),
      }))
      .filter((t) => Number.isFinite(t.value) && t.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 6),
    pressure: { cpu: pressure.cpu, io: pressure.io, memory: pressure.memory },
    containers: {
      total: containerUp.length === 0 ? null : containerUp.length,
      down: containerUp.filter((c) => c.value[1] !== '1').map((c) => c.metric.name ?? '?'),
    },
    failedUnits,
    generations: facts.generations,
  }
}

/* ── Build ────────────────────────────────────────────────────────────── */

/**
 * The parts this machine is made of, and what each of them is doing.
 *
 * The one tab here whose subject is not a layer of the operating system but
 * the objects in the cupboard. It exists because every other System tab
 * answers "how is it behaving" and none of them could answer "what is it" —
 * and on a box that gets opened once a year, the second question is the one
 * you have no way to look up when you are standing in front of it with a
 * screwdriver.
 *
 * Half declared, half measured, and the split is deliberate. What a part IS —
 * its name, its rating, its photograph — cannot be read from the machine: no
 * interface reports that the cooler is an NH-L9x65 or the PSU is 650 W, so
 * those are written down in the view. What a part is DOING is never written
 * down: every temperature, every rpm and every watt on this page is live.
 */
type BuildData = {
  hardware: Hardware
  /** Board sensors, named by the chip's own labels rather than by `temp3`. */
  temps: { label: string; value: number }[]
  /**
   * Every fan header, including the ones reading zero.
   *
   * The zeros are the point: eight headers with one spinning is a fact about
   * how the machine is wired, and dropping the empty ones would make an
   * unplugged case fan look identical to a header that does not exist.
   */
  fans: { label: string; rpm: number }[]
  /** The rails, for the PSU panel — the only thing on this box that observes it. */
  volts: { label: string; value: number }[]
  /** The iGPU, which does have an exporter. */
  gpu: {
    powerWatts: number | null
    packageWatts: number | null
    frequencyMhz: number | null
    clients: number | null
    busiestEngine: { name: string; pct: number } | null
  }
  cpu: { tempC: number | null; usagePct: number | null; frequencyMhz: number | null }
}

/**
 * hwmon sensor → its human label, from the chip's own `*_label` files.
 *
 * node-exporter publishes the reading and the name as two separate series
 * joined on (chip, sensor) — `node_hwmon_fan_rpm{sensor="fan1"}` and
 * `node_hwmon_sensor_label{sensor="fan1",label="CPU Fan"}`. Without the join
 * every panel on this tab would be a list of `fan1`, `temp3`, `in0`, which is
 * the board's wiring diagram rather than an answer.
 */
function labelled(
  values: { metric: Record<string, string>; value: [number, string] }[],
  labels: { metric: Record<string, string>; value: [number, string] }[],
): { label: string; value: number }[] {
  const names = new Map(
    labels.map((l) => [`${l.metric.chip ?? ''}/${l.metric.sensor ?? ''}`, l.metric.label ?? '']),
  )
  return values
    .map((v) => ({
      label: names.get(`${v.metric.chip ?? ''}/${v.metric.sensor ?? ''}`) ?? v.metric.sensor ?? '?',
      value: Number(v.value[1]),
    }))
    .filter((v) => Number.isFinite(v.value))
}

async function loadBuild(): Promise<BuildData> {
  const [facts, temps, fans, volts, labels, gpu, engines, cpu] = await Promise.all([
    hostFacts(),
    promVector('node_hwmon_temp_celsius'),
    promVector('node_hwmon_fan_rpm'),
    promVector('node_hwmon_in_volts'),
    promVector('node_hwmon_sensor_label'),
    // Every gpumon series carries a `type`, and taking the first sample of an
    // unqualified query means taking whichever the exporter happened to list
    // first — which for power is the whole PACKAGE, four times the figure the
    // render engine is drawing. Pinned, so a reordered scrape cannot quietly
    // put cpu watts in a graphics panel. Package power rides along beside it
    // because on an integrated part the two are worth seeing together.
    promScalars({
      power: 'gpumon_power{type="gpu"}',
      packagePower: 'gpumon_power{type="pkg"}',
      frequency: 'gpumon_frequency{type="actual"}',
      clients: 'gpumon_clients_count',
    }),
    // `attrib="busy"` is the occupancy; `sema` is time spent waiting on a
    // semaphore, which is not work being done and would double every engine.
    promVector('gpumon_engine_usage{attrib="busy"}'),
    promScalars({
      temp: 'node_hwmon_temp_celsius{chip="platform_coretemp_0",sensor="temp1"}',
      usage: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
      frequency: 'avg(node_cpu_scaling_frequency_hertz) / 1e6',
    }),
  ])

  const busiest = engines
    .map((e) => ({ name: e.metric.engine ?? e.metric.name ?? '?', pct: Number(e.value[1]) }))
    .filter((e) => Number.isFinite(e.pct))
    .sort((a, b) => b.pct - a.pct)[0]

  return {
    hardware: facts.hardware,
    // Board sensors only. coretemp's eleven per-core readings belong to the
    // cpu panel and would bury the six that describe the board.
    temps: labelled(
      temps.filter((t) => (t.metric.chip ?? '').includes('nct6687')),
      labels,
    ).sort((a, b) => b.value - a.value),
    fans: labelled(fans, labels).map((f) => ({ label: f.label, rpm: f.value })),
    volts: labelled(volts, labels),
    gpu: {
      powerWatts: gpu.power,
      packageWatts: gpu.packagePower,
      frequencyMhz: gpu.frequency,
      clients: gpu.clients,
      busiestEngine: busiest ?? null,
    },
    cpu: { tempC: cpu.temp, usagePct: cpu.usage, frequencyMhz: cpu.frequency },
  }
}

/* ── Memory ───────────────────────────────────────────────────────────── */

type MemoryData = {
  total: number | null
  used: number | null
  available: number | null
  cached: number | null
  dirty: number | null
  /**
   * ZFS's adaptive replacement cache, and the reason "used" looks high.
   *
   * ARC is charged to the kernel rather than to any process, so a box with
   * 64 GiB and 40 GiB of ARC reads as nearly full while having tens of
   * gigabytes it will hand back on demand. Nothing on this dashboard showed
   * it, which made the memory number unreadable.
   */
  arc: { size: number | null; max: number | null; min: number | null; hitRate: number | null }
  /** zram is this box's only swap — bytes in it are pressure that happened. */
  zram: { used: number | null; total: number | null }
  topMemory: { label: string; value: number; display: string }[]
  /** Containers with a cgroup cap, and what it is. */
  capped: { name: string; limitBytes: number; usageBytes: number | null }[]
  uncapped: number | null
  oomKills: number | null
  /**
   * What is physically in the slots.
   *
   * Prometheus can say how many bytes there are; only SMBIOS can say that
   * they arrive as two 32 GB DDR4 modules with two slots left over — which
   * is the fact an upgrade decision turns on and the one this tab was
   * missing.
   */
  modules: Hardware['memory']
}

async function loadMemory(): Promise<MemoryData> {
  const [mem, arc, arcHits, topMemory, limits, usage, oom, containers, facts] = await Promise.all([
    promScalars({
      total: 'node_memory_MemTotal_bytes',
      available: 'node_memory_MemAvailable_bytes',
      cached: 'node_memory_Cached_bytes',
      dirty: 'node_memory_Dirty_bytes',
      swapTotal: 'node_memory_SwapTotal_bytes',
      swapFree: 'node_memory_SwapFree_bytes',
    }),
    promScalars({
      size: 'node_zfs_arc_size',
      max: 'node_zfs_arc_c_max',
      min: 'node_zfs_arc_c_min',
    }),
    promScalar(
      '100 * rate(node_zfs_arc_hits[30m]) / (rate(node_zfs_arc_hits[30m]) + rate(node_zfs_arc_misses[30m]))',
    ),
    promBars('topk(10, container_memory_usage_bytes)', 'name'),
    promVector('container_memory_limit_bytes'),
    promVector('container_memory_usage_bytes'),
    promScalar('sum(container_oom_kills_total)'),
    promScalar('count(container_up)'),
    hostFacts(),
  ])

  const usageBy = new Map(usage.map((u) => [u.metric.name ?? '', Number(u.value[1])]))

  return {
    total: mem.total,
    used: mem.total !== null && mem.available !== null ? mem.total - mem.available : null,
    available: mem.available,
    cached: mem.cached,
    dirty: mem.dirty,
    arc: { size: arc.size, max: arc.max, min: arc.min, hitRate: arcHits },
    zram: {
      used: mem.swapTotal !== null && mem.swapFree !== null ? mem.swapTotal - mem.swapFree : null,
      total: mem.swapTotal,
    },
    topMemory: topMemory.map((m) => ({ ...m, display: bytes(m.value) })),
    // The series is OMITTED for an uncapped container rather than reported as
    // infinity, so the length of this list IS the count of capped ones.
    capped: limits
      .map((l) => ({
        name: l.metric.name ?? '?',
        limitBytes: Number(l.value[1]),
        usageBytes: usageBy.get(l.metric.name ?? '') ?? null,
      }))
      .sort((a, b) => a.limitBytes - b.limitBytes),
    uncapped: containers === null ? null : containers - limits.length,
    oomKills: oom,
    modules: facts.hardware.memory,
  }
}

/* ── Disks ────────────────────────────────────────────────────────────── */

type DisksData = {
  disks: SmartDisk[]
  /** Per device, from node_exporter — SMART says nothing about throughput. */
  io: {
    device: string
    readBytes: number | null
    writtenBytes: number | null
    utilPct: number | null
  }[]
  /** When smartd's own timers last ran, so a silent scheduler is visible. */
  smartdActive: boolean | null
}

async function loadDisks(): Promise<DisksData> {
  const [facts, reads, writes, util, smartd] = await Promise.all([
    hostFacts(),
    promVector('rate(node_disk_read_bytes_total[5m])'),
    promVector('rate(node_disk_written_bytes_total[5m])'),
    promVector('100 * rate(node_disk_io_time_seconds_total[5m])'),
    promScalar('systemd_unit_state{name="smartd.service",state="active"}'),
  ])

  const by = (rows: { metric: Record<string, string>; value: [number, string] }[]) =>
    new Map(rows.map((r) => [r.metric.device ?? '', Number(r.value[1])]))
  const r = by(reads)
  const w = by(writes)
  const u = by(util)

  return {
    disks: facts.disks,
    io: facts.disks.map((d) => ({
      device: d.device,
      readBytes: r.get(d.device) ?? null,
      writtenBytes: w.get(d.device) ?? null,
      utilPct: u.get(d.device) ?? null,
    })),
    smartdActive: smartd === null ? null : smartd === 1,
  }
}

/* ── Pools ────────────────────────────────────────────────────────────── */

type PoolsData = {
  pools: ZpoolFacts[]
  datasets: DatasetFacts[]
  /** Total snapshot bytes across every dataset — the growth to watch. */
  snapshotBytes: number
  snapshots: number
}

async function loadPools(): Promise<PoolsData> {
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

/* ── Database ─────────────────────────────────────────────────────────── */

/**
 * The shared Postgres cluster, which every app on this box is a tenant of.
 *
 * postgres_exporter already publishes all of this and nothing read it — the
 * old page showed the top eight databases by size and stopped, which answers
 * "what is big" and none of the questions you actually have about a cluster:
 * whether it is serving from cache, whether anything is stuck in a
 * transaction, whether a tenant is rolling back more than it commits.
 */
type DatabaseData = {
  databases: {
    name: string
    sizeBytes: number
    connections: number | null
    /** Buffer-cache hit rate. Below ~99% on a box this size means seeks. */
    cacheHitPct: number | null
    commits: number | null
    rollbacks: number | null
    deadlocks: number | null
  }[]
  totals: {
    sizeBytes: number
    connections: number | null
    maxConnections: number | null
    /** Longest running transaction, seconds. The stuck-query signal. */
    longestTxSeconds: number | null
    locks: number | null
    tempBytes: number | null
  }
  version: string | null
  up: boolean | null
  /**
   * The release gap, from postgresql.org rather than GitHub.
   *
   * The mirror at postgres/postgres carries tags and publishes no releases, so
   * the usual `versionGap` would report the one service on this box whose
   * minors are almost purely security fixes as having no notes at all. See
   * ../postgres.ts.
   */
  gap: VersionGap
}

async function loadDatabase(): Promise<DatabaseData> {
  const [sizes, conns, hits, reads, commits, rollbacks, deadlocks, totals, up] = await Promise.all([
    promVector('pg_database_size_bytes'),
    promVector('pg_stat_database_numbackends'),
    promVector('pg_stat_database_blks_hit'),
    promVector('pg_stat_database_blks_read'),
    promVector('pg_stat_database_xact_commit'),
    promVector('pg_stat_database_xact_rollback'),
    promVector('pg_stat_database_deadlocks'),
    promScalars({
      connections: 'sum(pg_stat_activity_count)',
      maxConnections: 'pg_settings_max_connections',
      longestTx: 'max(pg_stat_activity_max_tx_duration)',
      locks: 'sum(pg_locks_count)',
      temp: 'sum(pg_stat_database_temp_bytes)',
    }),
    promScalar('pg_up'),
  ])

  const version = await pgVersion()

  const by = (rows: { metric: Record<string, string>; value: [number, string] }[]) =>
    new Map(rows.map((r) => [r.metric.datname ?? '', Number(r.value[1])]))
  const c = by(conns)
  const h = by(hits)
  const rd = by(reads)
  const cm = by(commits)
  const rb = by(rollbacks)
  const dl = by(deadlocks)

  const databases = sizes
    .map((s) => {
      const name = s.metric.datname ?? '?'
      const hit = h.get(name)
      const read = rd.get(name)
      return {
        name,
        sizeBytes: Number(s.value[1]),
        connections: c.get(name) ?? null,
        cacheHitPct:
          hit === undefined || read === undefined || hit + read === 0
            ? null
            : (hit / (hit + read)) * 100,
        commits: cm.get(name) ?? null,
        rollbacks: rb.get(name) ?? null,
        deadlocks: dl.get(name) ?? null,
      }
    })
    // Postgres's own three are real databases and appear in every metric, but
    // they are not tenants and their presence at the top of a size-ordered
    // list is noise.
    .filter((d) => !['template0', 'template1'].includes(d.name))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

  return {
    databases,
    totals: {
      sizeBytes: databases.reduce((n, d) => n + d.sizeBytes, 0),
      connections: totals.connections,
      maxConnections: totals.maxConnections,
      longestTxSeconds: totals.longestTx,
      locks: totals.locks,
      tempBytes: totals.temp,
    },
    version,
    gap: await postgresGap(version),
    up: up === null ? null : up === 1,
  }
}

async function pgVersion(): Promise<string | null> {
  const rows = await promVector('pg_static')
  const v = rows[0]?.metric.short_version ?? rows[0]?.metric.version ?? null
  return v === null ? null : v.split(' ').slice(0, 2).join(' ')
}

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
type BackupsData = {
  pairs: ReplicationPair[]
  /** Datasets enrolled in snapshots, and those deliberately not. */
  coverage: { name: string; snapshots: number; usedBytes: number }[]
  unsnapshotted: { name: string; usedBytes: number }[]
  totalReplicatedBytes: number
}

async function loadBackups(): Promise<BackupsData> {
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

export type { HostFacts }
