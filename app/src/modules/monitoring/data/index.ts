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
// One page had all five stacked, which read as one system with five panels. It
// is five systems: Grafana evaluates rules and knows nothing about whether
// prometheus is scraping; prometheus scrapes and knows nothing about whether
// Loki is ingesting; gatus probes from outside and knows nothing about either.
// The one thing they share is that when one stops, the others keep looking
// fine — which is exactly why they should not share a scroll.
//
// ── these are services, and used not to be read as any ────────────────────
//
// Every tab here carried a log and nothing else: no artwork, no version, no
// verdict on whether that version is current, no release notes. That was the
// odd one out on this dashboard — Media, Home, AI, Gaming and Network all open
// with a service head and carry a changelog — and it was odd in the direction
// that matters least defensibly, because these five ARE five pinned images
// with five release cycles. The monitoring stack was the one part of this box
// whose own upgrades were invisible from the dashboard that watches
// everything else's.
//
// Three of them report a version about themselves and two do not. That
// difference is carried through to the page rather than smoothed over: a
// number the running process stated is a measurement, and a number read off
// the tag the flake pins is only true while the tag names a release.

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
