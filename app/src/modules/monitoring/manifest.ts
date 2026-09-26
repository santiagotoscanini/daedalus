import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'monitoring',
  label: 'Monitoring',
  lede: 'The watchers, and whether each would still tell you.',
  order: 70,
  // Shaped to Alerts, the tab that opens by default.
  boardSpans: [8, 4, 4, 8],
  // No tile directory: its tiles would be this tab row. A tab per watcher
  // (why: data/index.ts), each dotted by its watcher's own gatus probe;
  // Alerts wears Grafana's.
  //
  // `nix` names the catalog module, not the container: Grafana and
  // prometheus are one module (nix/modules/monitoring), and so are Loki and
  // alloy (nix/modules/logging).
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
    // Loki has no published hostname, so no gatus endpoint to borrow. The
    // dot is computed from prometheus's `up` for both loki and alloy
    // (server/tab-status.ts) rather than buying new ingress to colour it.
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
