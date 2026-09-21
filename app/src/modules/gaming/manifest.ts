import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'gaming',
  label: 'Gaming',
  lede: 'The game servers: which build each one runs, and whether the people on the sofa can still join.',
  order: 40,
  boardSpans: [6, 6, 12],
  tabs: [
    { id: 'factorio', label: 'Factorio', probe: 'factorio-admin', nix: 'factorio' },
    { id: 'minecraft', label: 'Minecraft', nix: 'minecraft' },
  ],
} as const satisfies ModuleManifest
