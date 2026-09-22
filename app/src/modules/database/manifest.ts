import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'database',
  label: 'Database',
  lede: 'The one Postgres cluster every app on this box is a tenant of.',
  // Right after System: it was a tab there until the row's own argument put
  // it out. Every other System tab is a layer of the machine — no head, no
  // dot, always shown — and this one is a service with a version, a release
  // cycle and minors that are security fixes, which the box can switch off.
  // A tab that broke every rule of its row was a module.
  order: 65,
  boardSpans: [8, 4, 12],
  // One tab, and no dot on it: nothing probes the cluster from outside —
  // the page reads postgres_exporter, which is the same claim made better.
  tabs: [{ id: 'postgres', label: 'Postgres', boardSpans: [8, 4, 12], nix: 'app-db' }],
} as const satisfies ModuleManifest
