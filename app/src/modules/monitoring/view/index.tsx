import { defineViews } from '../../../lib/modules/tabs'
import type { Tabs } from '../data'
import { manifest } from '../manifest'
import { AlertsView } from './alerts'
import { JobsView } from './jobs'
import { LogsView } from './logs'
import { MetricsView } from './metrics'
import { ProbesView } from './probes'

// The Monitoring pages — a tab per watcher (why: ../data/index.ts).
//
// Each tab is laid out like every other service page: the service head
// (artwork, version, verdict, what this watcher is FOR, the link), then the
// boards — leading with the gap rather than the total — the changelog and
// the log.

export const views = defineViews<typeof manifest, Tabs>(manifest, {
  alerts: AlertsView,
  probes: ProbesView,
  metrics: MetricsView,
  logs: LogsView,
  jobs: JobsView,
})
