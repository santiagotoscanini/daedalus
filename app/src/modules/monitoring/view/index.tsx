import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { AlertsView } from './alerts'
import { JobsView } from './jobs'
import { LogsView } from './logs'
import { MetricsView } from './metrics'
import { ProbesView } from './probes'

// The Monitoring pages — a tab per watcher.
//
// Five systems, not one with five panels: Grafana evaluates rules and knows
// nothing about whether prometheus is scraping; prometheus scrapes and knows
// nothing about whether Loki is ingesting; gatus probes from outside and knows
// nothing about either. What they share is that when one stops, the rest keep
// looking fine — which is the argument for tabs rather than a scroll.
//
// Every tab leads with the gap rather than the total. "38 endpoints up" is
// context; "which one is down, and which has the worst week" is the content.
//
// ── read like every other service page ────────────────────────────────────
//
// Artwork, the name, the version running, the verdict on whether that version
// is current, one sentence saying what this watcher is FOR, the link you came
// to click — then the boards, the changelog and the log. Identical to Media,
// Home, AI and Gaming, and these five were the exception: they carried a log
// and nothing else, so the only part of this box whose upgrades you could not
// see from the dashboard was the part that does the watching.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  alerts: AlertsView,
  probes: ProbesView,
  metrics: MetricsView,
  logs: LogsView,
  jobs: JobsView,
})
