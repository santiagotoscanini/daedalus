import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the Gaming containers' release notes live. Factorio is deliberately
// absent: ofsm wraps the game, and the version that matters is Factorio's
// own, which the tab reads from the wiki changelog because there is no
// GitHub release for it. The Minecraft server's GAME version is not the
// image's either — the tab reads Mojang and Paper for that. mc-monitor's
// image states no version label, so its notes are read without one, like
// the server image's.
export const releases: Record<string, ReleaseSource> = {
  minecraft: { repo: 'itzg/docker-minecraft-server', opts: { notesWhenUnknown: true } },
  'minecraft-monitor': { repo: 'itzg/mc-monitor', opts: { notesWhenUnknown: true } },
}
