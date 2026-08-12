import { promScalar, promScalars, promSeries, promVector } from '../../../prom'
import { hostFacts } from '../../host-facts'

/* ── Host ─────────────────────────────────────────────────────────────── */

export type HostData = {
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
   * The failed units by NAME, from the host snapshot. The count above is
   * prometheus's and refreshes every 60s; this list refreshes with the
   * snapshot (10 min), so the two can briefly disagree after a unit flips.
   */
  failedUnitsList: { unit: string; description: string | null; subState: string | null }[]
  /**
   * Every boot generation on the box.
   *
   * `configurationLimit = 10` bounds the BOOT MENU, not the profile — a
   * distinction nothing on this box surfaced, and the count below is usually
   * the surprise.
   */
  generations: { id: number; date: string; current: boolean }[]
}

export async function loadHost(): Promise<HostData> {
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
    failedUnitsList: facts.failedUnits.map((u) => ({
      unit: u.unit,
      description: u.description,
      subState: u.subState,
    })),
    generations: facts.generations,
  }
}
