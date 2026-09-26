// The Monitoring category: the machinery that watches everything else.
//
// Its own page rather than a corner of System because it answers a different
// question. System asks "is the box healthy"; this asks "would I be told if it
// were not" — and those fail independently. A dead scrape target, a Loki that
// stopped accepting writes and a healthchecks slug nobody pings all leave the
// System page looking perfect.
//
// So every tab here is deliberately built around the GAPS: targets that are
// down get named, endpoints are ranked by their worst uptime rather than their
// average, and every dead-man's-switch is listed with how overdue it is. The
// green numbers are context; the list of things not reporting is the content.
//
// ── a tab per watcher, because they fail separately ───────────────────────
//
// Grafana evaluates rules and knows nothing about whether prometheus is
// scraping; prometheus scrapes and knows nothing about whether Loki is
// ingesting; gatus probes from outside and knows nothing about either. When
// one stops, the others keep looking fine — so they do not share a scroll.
//
// ── and each read like any other service ──────────────────────────────────
//
// They are pinned images with their own release cycles, so every tab opens
// with a service head and carries a changelog. Grafana, prometheus and Loki
// report their own version; gatus, healthchecks and alloy are read off the
// pinned image tag. The page keeps that difference visible: a number the
// running process stated is a measurement, and a tag is only true while it
// names a release.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type AlertsData, loadAlerts } from './alerts'
import { type JobsData, loadJobs } from './jobs'
import { type LogsData, loadLogs } from './logs'
import { loadMetrics, type MetricsData } from './metrics'
import { loadProbes, type ProbesData } from './probes'

export type Tabs = {
  alerts: AlertsData
  probes: ProbesData
  metrics: MetricsData
  logs: LogsData
  jobs: JobsData
}
export type MonitoringData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  alerts: loadAlerts,
  probes: loadProbes,
  metrics: loadMetrics,
  logs: loadLogs,
  jobs: loadJobs,
})
