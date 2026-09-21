import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'monitoring',
  label: 'Monitoring',
  lede: 'The watchers, and whether each would still tell you.',
  order: 70,
  // Shaped to Alerts, the tab that opens by default.
  boardSpans: [8, 4, 4, 8],
  // No tile directory. Its five tiles were Grafana, Loki, Prometheus, Gatus
  // and Healthchecks — which is this tab row exactly, one scroll further
  // down and with three numbers each instead of a page.
  // A tab per watcher, because they fail SEPARATELY. Grafana evaluates rules
  // and knows nothing about whether prometheus is scraping; prometheus
  // scrapes and knows nothing about whether Loki is ingesting; gatus probes
  // from outside and knows nothing about either. What they share is that
  // when one stops, the rest keep looking fine.
  //
  // Probed like any other service — these are containers with hostnames, so
  // unlike System the dots here are real. Alerts wears Grafana's.
  //
  // And read like any other service, which they were not: these five are
  // five pinned images with five release cycles, and the pages carried a log
  // and nothing else — no artwork, no version, no verdict, no notes. The
  // monitoring stack was the one part of this box whose own upgrades were
  // invisible from the dashboard that watches everything else's.
  //
  // `nix` names the stack, not the container: Grafana and prometheus are one
  // module (stacks/monitoring), and so are Loki and alloy (stacks/logging).
  tabs: [
    {
      id: 'alerts',
      label: 'Alerts',
      probe: 'grafana',
      boardSpans: [8, 4, 4, 8],
      nix: 'monitoring',
    },
    { id: 'probes', label: 'Probes', probe: 'gatus', boardSpans: [8, 4, 4, 12], nix: 'gatus' },
    {
      id: 'metrics',
      label: 'Metrics',
      probe: 'prometheus',
      boardSpans: [8, 4, 8, 4],
      nix: 'monitoring',
    },
    // Loki publishes no gatus endpoint — it is reached over the monitoring
    // bridge and has no published hostname to probe from outside. That left
    // this the one tab in the row wearing a permanent grey dot, which read
    // as "nothing is checking the logs" beside four green ones; the truth
    // was that the check exists and the dot could not see it. Prometheus
    // scrapes both halves of the pipeline over that same bridge, so the
    // status is assembled from `up` instead of published for the sake of
    // being probed — a hostname for Loki would be new ingress bought to
    // colour a circle.
    {
      id: 'logs',
      label: 'Logs',
      health: 'log-pipeline',
      boardSpans: [8, 4, 4, 8],
      nix: 'logging',
    },
    {
      id: 'jobs',
      label: 'Jobs',
      probe: 'healthchecks',
      boardSpans: [8, 4, 12],
      nix: 'healthchecks',
    },
  ],
} as const satisfies ModuleManifest
