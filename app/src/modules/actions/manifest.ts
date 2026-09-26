import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'actions',
  label: 'Actions',
  lede: 'Every workflow run across the repositories this box knows, and the runners it could lend them.',
  // After Database, before Monitoring: it is about GitHub's machines and this
  // network's, not about a service the box runs. Why it is not part of Apps:
  // view/index.tsx.
  order: 68,
  boardSpans: [8, 4, 12, 6, 6],
  // No ServiceHead: the subject is a platform, not a container with a
  // version. No dot: nothing on the box probes GitHub.
  tabs: [
    { id: 'runs', label: 'Runs', boardSpans: [8, 4, 12, 6, 6], head: false },
    { id: 'workflows', label: 'Workflows', boardSpans: [4, 4, 4, 12], head: false },
    { id: 'minutes', label: 'Minutes', boardSpans: [8, 4, 6, 6], head: false },
    { id: 'runners', label: 'Runners', boardSpans: [8, 4, 6, 6, 12], head: false },
  ],
} as const satisfies ModuleManifest
