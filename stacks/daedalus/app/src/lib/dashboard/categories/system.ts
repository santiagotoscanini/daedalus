// The System category: the box itself, and whether anything on it is unhappy.
//
// Everything here is prometheus except the healthchecks roster — this is the
// one category where no service has a better answer than the scrape does, and
// where the interesting numbers (per-container memory, cgroup pressure, pool
// capacity) exist nowhere else.
//
// A note on container memory, because it looks alarming and usually is not:
// `container_memory_usage_bytes` is cgroup v2's memory.current, which INCLUDES
// page cache. A container doing file I/O sits at its limit forever and is
// perfectly healthy — the cache is reclaimed under pressure. The signal that a
// cap is genuinely too tight is container_oom_kills_total moving, which is why
// that counter is on the page and "percent of limit" is not.

import {
  basicAuth,
  getJson,
  lokiScalar,
  lokiSeries,
  lokiVector,
  promBars,
  promScalar,
  promScalars,
  promSeries,
  promVector,
} from '../clients'
import { bytes, key } from '../format'

export type SystemData = {
  host: {
    cpuPct: number | null
    cpuSpark: number[]
    memUsed: number | null
    memTotal: number | null
    load1: number | null
    load5: number | null
    load15: number | null
    uptimeSeconds: number | null
    cores: number | null
    zramUsed: number | null
  }
  temps: { label: string; value: number }[]
  pools: { name: string; usedBytes: number; totalBytes: number; healthy: boolean | null }[]
  containers: {
    total: number | null
    down: string[]
    topMemory: { label: string; value: number; display: string }[]
    topCpu: { label: string; value: number; display: string }[]
    oomKills: number | null
  }
  health: {
    failedUnits: number | null
    firingAlerts: number | null
    probesUp: number | null
    probesDown: number | null
    uptime24h: number | null
    checks: { up: number; down: number; late: number } | null
  }
  logs: {
    lines1h: number | null
    warn1h: number | null
    errors1h: number | null
    /** 24 hourly buckets of error lines. */
    errorHistory: number[]
    /** Which containers are producing the errors. */
    noisiest: { label: string; value: number }[]
  }
  databases: { label: string; value: number; display: string }[]
}

export async function loadSystem(ctx: { base: (app: string) => string }): Promise<SystemData> {
  const [
    host,
    cpuSpark,
    temps,
    poolSizes,
    poolAvail,
    poolHealth,
    containerUp,
    topMemory,
    topCpu,
    oom,
    failedUnits,
    alerts,
    probes,
    checks,
    logs,
    errorHistory,
    noisiest,
    databases,
  ] = await Promise.all([
    promScalars({
      cpu: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))',
      memTotal: 'node_memory_MemTotal_bytes',
      memAvailable: 'node_memory_MemAvailable_bytes',
      load1: 'node_load1',
      load5: 'node_load5',
      load15: 'node_load15',
      uptime: 'node_time_seconds - node_boot_time_seconds',
      cores: 'count(count by (cpu) (node_cpu_seconds_total))',
      // zram is this box's only swap; bytes in it are memory pressure that
      // already happened, which no instantaneous gauge shows.
      swapUsed: 'node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes',
    }),
    promSeries('100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))', 6 * 60, 120),
    promVector('node_hwmon_temp_celsius'),
    promVector('node_filesystem_size_bytes{fstype="zfs"}'),
    promVector('node_filesystem_avail_bytes{fstype="zfs"}'),
    promVector('node_zfs_zpool_state{state="online"}'),
    promVector('container_up'),
    promBars('topk(8, container_memory_usage_bytes)', 'name'),
    promBars('topk(8, rate(container_cpu_usage_seconds_total[5m]))', 'name'),
    promScalar('sum(container_oom_kills_total)'),
    promScalar('systemd_failed_units'),
    loadAlerts(),
    promScalars({
      up: 'count(gatus_results_endpoint_success == 1) or vector(0)',
      down: 'count(gatus_results_endpoint_success == 0) or vector(0)',
      uptime: '100 * avg(avg_over_time(gatus_results_endpoint_success[24h]))',
    }),
    getJson<{ checks?: { status: string }[] }>(`${ctx.base('healthchecks')}/api/v1/checks/`, {
      headers: { 'X-Api-Key': key('HEALTHCHECKS_API_KEY') },
    }),
    loadLogVolume(),
    loadErrorHistory(),
    loadNoisiest(),
    promBars('topk(8, pg_database_size_bytes)', 'datname'),
  ])

  return {
    host: {
      cpuPct: host.cpu,
      cpuSpark,
      memUsed:
        host.memTotal !== null && host.memAvailable !== null ? host.memTotal - host.memAvailable : (
          null
        ),
      memTotal: host.memTotal,
      load1: host.load1,
      load5: host.load5,
      load15: host.load15,
      uptimeSeconds: host.uptime,
      cores: host.cores,
      zramUsed: host.swapUsed,
    },
    // Labelled by chip because the sensor names alone (`temp1`, `temp3`) say
    // nothing about what is being measured.
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
    pools: summarisePools(poolSizes, poolAvail, poolHealth),
    containers: {
      total: containerUp.length === 0 ? null : containerUp.length,
      down: containerUp.filter((c) => c.value[1] !== '1').map((c) => c.metric.name ?? '?'),
      topMemory: topMemory.map((m) => ({ ...m, display: bytes(m.value) })),
      topCpu: topCpu.map((m) => ({ ...m, display: `${(m.value * 100).toFixed(0)}%` })),
      oomKills: oom,
    },
    health: {
      failedUnits,
      firingAlerts: alerts,
      probesUp: probes.up,
      probesDown: probes.down,
      uptime24h: probes.uptime,
      checks:
        checks?.checks === undefined ? null : (
          {
            up: checks.checks.filter((c) => c.status === 'up').length,
            down: checks.checks.filter((c) => c.status === 'down').length,
            late: checks.checks.filter((c) => c.status === 'grace').length,
          }
        ),
    },
    logs: { ...logs, errorHistory, noisiest },
    databases: databases.map((d) => ({ ...d, display: bytes(d.value) })),
  }
}

/**
 * ZFS filesystems, folded back into the two pools they belong to.
 *
 * node_exporter reports one row per mounted dataset and every dataset in a
 * pool reports the SAME free space — that is how ZFS works, they share it. So
 * "used" has to be summed per dataset (size minus avail) while "free" is taken
 * once, from any of them. Summing the sizes instead would report a 4 TB NVMe
 * as 15 TB.
 */
function summarisePools(
  sizes: { metric: Record<string, string>; value: [number, string] }[],
  avail: { metric: Record<string, string>; value: [number, string] }[],
  online: { metric: Record<string, string>; value: [number, string] }[],
): SystemData['pools'] {
  const poolOf = (device: string) => device.split('/')[0] ?? device
  const availByMount = new Map(avail.map((a) => [a.metric.mountpoint ?? '', Number(a.value[1])]))
  const healthy = new Map(online.map((o) => [o.metric.zpool ?? '', o.value[1] === '1']))

  const pools = new Map<string, { used: number; free: number }>()
  for (const s of sizes) {
    const mount = s.metric.mountpoint ?? ''
    // /nix and /nix/store are the same dataset mounted twice; counting both
    // would double that dataset's usage.
    if (mount === '/nix/store') continue
    const pool = poolOf(s.metric.device ?? '')
    const size = Number(s.value[1])
    const free = availByMount.get(mount) ?? 0
    const acc = pools.get(pool) ?? { used: 0, free }
    acc.used += Math.max(0, size - free)
    acc.free = free
    pools.set(pool, acc)
  }

  return [...pools]
    .map(([name, p]) => ({
      name,
      usedBytes: p.used,
      totalBytes: p.used + p.free,
      healthy: healthy.get(name) ?? null,
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes)
}

async function loadAlerts(): Promise<number | null> {
  const body = await getJson<{ data?: { groups?: { rules?: { state?: string }[] }[] } }>(
    'http://grafana:3000/api/prometheus/grafana/api/v1/rules',
    { headers: { Authorization: basicAuth(key('GRAFANA_USER'), key('GRAFANA_PASS')) } },
  )
  if (body === null) return null
  return (body.data?.groups ?? []).flatMap((g) => g.rules ?? []).filter((r) => r.state === 'firing')
    .length
}

async function loadLogVolume(): Promise<{
  lines1h: number | null
  warn1h: number | null
  errors1h: number | null
}> {
  const [lines1h, warn1h, errors1h] = await Promise.all([
    lokiScalar('sum(count_over_time({level=~".+"}[1h])) or vector(0)'),
    lokiScalar('sum(count_over_time({level="warning"}[1h])) or vector(0)'),
    lokiScalar('sum(count_over_time({level="error"}[1h])) or vector(0)'),
  ])
  return { lines1h, warn1h, errors1h }
}

/** One hourly bucket of error lines per point, a day wide. */
function loadErrorHistory(): Promise<number[]> {
  return lokiSeries('sum(count_over_time({level="error"}[1h]))', 24 * 60, 3600)
}

async function loadNoisiest(): Promise<{ label: string; value: number }[]> {
  const rows = await lokiVector(
    'topk(6, sum by (container) (count_over_time({level="error"}[24h])))',
    'container',
  )
  // Lines from the host journal carry `unit`, not `container`, so they group
  // under an empty label. Naming that group beats rendering a bare "?" as
  // though a container were missing.
  return rows.map((r) => (r.label === '?' ? { ...r, label: 'host units' } : r))
}
