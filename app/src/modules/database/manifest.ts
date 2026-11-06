import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'database',
  label: 'Data',
  lede: 'Where the apps on this box keep their state: one Postgres cluster and one object store, every app a tenant of each.',
  // After System's number (System itself draws at the rail's foot): services
  // with a version, a release cycle and minors that are security fixes, which
  // the box can switch off — none of which a System tab, a layer of the
  // machine, has.
  order: 65,
  section: 'Infrastructure',
  boardSpans: [8, 4, 12],
  // No dot on either tab: nothing probes them from outside — each page reads
  // its own service's metrics, which is the same claim made better.
  tabs: [
    { id: 'postgres', label: 'Postgres', boardSpans: [8, 4, 12], nix: 'app-db' },
    { id: 'garage', label: 'Object storage', boardSpans: [8, 4, 12], nix: 'garage' },
  ],
} as const satisfies ModuleManifest
