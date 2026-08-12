import { bytes } from '../../../format'
import { promBars, promScalar, promScalars, promVector } from '../../../prom'
import { type Hardware, hostFacts } from '../../host-facts'

/* ── Memory ───────────────────────────────────────────────────────────── */

export type MemoryData = {
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
  /**
   * Kept alongside the named list because it is the only way to tell "none,
   * ever" from "prometheus unreachable": the filtered topk answers [] to both,
   * while this sum answers 0 to one and null to the other.
   */
  oomKills: number | null
  /**
   * Containers the kernel has actually killed, named, worst first.
   *
   * Only the ones with a non-zero counter: this is the one number that means a
   * cap is genuinely too tight (usage-at-limit is normal for page-cache-heavy
   * apps), and a roster of seventy zeros would bury the signal it exists to
   * carry. Empty means it has never happened — a fact, not missing data. No
   * restart column next to it: the cgroup exporter reads memory.events only,
   * and rootless containers have no start-time series to derive one from.
   */
  oomKilled: { label: string; value: number }[]
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

export async function loadMemory(): Promise<MemoryData> {
  const [mem, arc, arcHits, topMemory, limits, usage, oom, oomKilled, containers, facts] =
    await Promise.all([
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
      // `> 0` so the list is only ever the killed, never the fleet.
      promBars('topk(10, container_oom_kills_total > 0)', 'name'),
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
    oomKilled,
    modules: facts.hardware.memory,
  }
}
