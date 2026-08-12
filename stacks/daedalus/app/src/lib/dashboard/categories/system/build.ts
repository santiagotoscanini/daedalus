import { promScalars, promVector } from '../../../prom'
import { type Hardware, hostFacts } from '../../host-facts'

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
export type BuildData = {
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

export async function loadBuild(): Promise<BuildData> {
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
