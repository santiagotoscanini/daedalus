import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { imageVersion, type RunningVersion } from '../../../lib/dashboard/images'
import { getJson } from '../../../lib/http'

// The Logs tab: what Loki holds (volume, levels, stacks, the noisiest
// containers) and the write path into it, from alloy's metrics in prometheus
// — the half that keeps talking when shipping stops.

export type LogsData = {
  lines1h: number | null
  ingestRate: number | null
  byLevel: { label: string; value: number }[]
  volumeHistory: number[]
  errorHistory: number[]
  noisiest: { label: string; value: number }[]
  /** Which stack label each line lands under — the coverage question. */
  byStack: { label: string; value: number }[]
  /** Containers whose lines land under no registered stack. */
  unregistered: number | null
  /**
   * The write path between journald and Loki, from alloy's scraped metrics.
   *
   * Everything else on this tab is read back OUT of Loki, so all of it goes
   * quiet together when shipping stops — these are the only numbers here that
   * come from prometheus instead and keep talking through that failure.
   * Drops and retries are 24h increases rather than rates because their
   * healthy value is a flat zero and a rate of zero renders indistinguishable
   * from "not measured"; lag is the propagation histogram's 10m mean, which
   * includes journald's own batching (~1s standing is normal, minutes is a
   * backlog).
   */
  ship: {
    lagSeconds: number | null
    /**
     * The journal read rate, the noise-drop stages' rate, and what actually
     * leaves — read minus filtered ≈ sent. Carried together because the gap
     * between read and sent LOOKS like loss and is stacks/logging's
     * deliberate drop pipeline; the number that means loss is dropped24h.
     */
    sentPerSec: number | null
    journalPerSec: number | null
    filteredPerSec: number | null
    dropped24h: number | null
    retries24h: number | null
    /** alloy's last config reload — a failed one runs on the OLD rules. */
    configOk: boolean | null
  }
  /**
   * Two versions, because this tab has two subjects.
   *
   * Loki stores and answers; alloy tails journald and ships. They are separate
   * projects on separate release cycles, and the usual failure — lines stop
   * arriving — is as likely to be one as the other. Naming only the store
   * would leave the half that actually touches the journal unversioned.
   */
  loki: { version: string | null; gap: VersionGap }
  alloy: { running: RunningVersion; gap: VersionGap }
}

function loadLogVolume(ctx: Ctx): Promise<number | null> {
  return ctx.loki.scalar('sum(count_over_time({level=~".+"}[1h])) or vector(0)')
}

export async function loadLogs(ctx: Ctx): Promise<LogsData> {
  const alloyRunning = await imageVersion('alloy')

  const [
    lines1h,
    ingestRate,
    byLevel,
    volumeHistory,
    errorHistory,
    noisiest,
    byStack,
    adhoc,
    ship,
    lokiBuild,
    alloyGap,
  ] = await Promise.all([
    loadLogVolume(ctx),
    ctx.prom.scalar('sum(rate(loki_distributor_bytes_received_total[10m]))'),
    ctx.loki.vector('sum by (level) (count_over_time({level=~".+"}[1h]))', 'level'),
    ctx.loki.series('sum(count_over_time({level=~".+"}[1h]))', 24 * 60, 3600),
    ctx.loki.series('sum(count_over_time({level="error"}[1h]))', 24 * 60, 3600),
    ctx.loki.vector(
      'topk(8, sum by (container) (count_over_time({level="error"}[24h])))',
      'container',
    ),
    ctx.loki.vector('topk(10, sum by (stack) (count_over_time({stack=~".+"}[24h])))', 'stack'),
    ctx.loki.scalar('sum(count_over_time({stack="adhoc"}[24h])) or vector(0)'),
    ctx.prom.scalars({
      lag:
        'sum(rate(loki_write_entry_propagation_latency_seconds_sum[10m]))' +
        ' / sum(rate(loki_write_entry_propagation_latency_seconds_count[10m]))',
      sent: 'sum(rate(loki_write_sent_entries_total[10m]))',
      journal: 'sum(rate(loki_source_journal_target_lines_total[10m]))',
      filtered: 'sum(rate(loki_process_dropped_lines_total[10m])) or vector(0)',
      dropped: 'sum(increase(loki_write_dropped_entries_total[24h]))',
      retries: 'sum(increase(loki_write_batch_retries_total[24h]))',
      configOk: 'min(alloy_config_last_load_successful)',
    }),
    getJson<{ version?: string }>(`${ctx.loki.url()}/loki/api/v1/status/buildinfo`),
    versionGap('grafana/alloy', alloyRunning.version),
  ])

  const lokiVersion = lokiBuild?.version ?? null

  return {
    loki: {
      version: lokiVersion,
      // Same interleaved release lines as Grafana's own repo — 3.7.x and
      // 3.6.x are cut alternately — but both share a major, so sameMajor
      // buys nothing here and cmp() orders them correctly on its own.
      gap: await versionGap('grafana/loki', lokiVersion),
    },
    alloy: { running: alloyRunning, gap: alloyGap },
    lines1h,
    ingestRate,
    byLevel,
    volumeHistory,
    errorHistory,
    // Lines from the host journal carry `unit`, not `container`, so they group
    // under an empty label. Naming that group beats rendering a bare "?" as
    // though a container were missing.
    noisiest: noisiest.map((n) => (n.label === '?' ? { ...n, label: 'host units' } : n)),
    byStack,
    unregistered: adhoc,
    ship: {
      lagSeconds: ship.lag,
      sentPerSec: ship.sent,
      journalPerSec: ship.journal,
      filteredPerSec: ship.filtered,
      dropped24h: ship.dropped,
      retries24h: ship.retries,
      configOk: ship.configOk === null ? null : ship.configOk >= 1,
    },
  }
}
