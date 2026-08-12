import { promScalar, promVector } from '../../../prom'
import { hostFacts, type SmartDisk } from '../../host-facts'

/* ── Disks ────────────────────────────────────────────────────────────── */

export type DisksData = {
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

export async function loadDisks(): Promise<DisksData> {
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
