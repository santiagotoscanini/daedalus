import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the Gaming containers' release notes live. Factorio is deliberately
// absent: ofsm wraps the game, and the version that matters is Factorio's
// own, which the tab reads from the wiki changelog because there is no
// GitHub release for it. minecraft-monitor's base states no version at all.
export const releases: Record<string, ReleaseSource> = {
  minecraft: { repo: 'itzg/docker-minecraft-server', opts: { notesWhenUnknown: true } },
}
