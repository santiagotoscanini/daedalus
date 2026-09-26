import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the Home containers' release notes live — the same repo each tab
// passes to versionGap (lib/dashboard/image-repos.ts says why that matters).
// Immich's two containers are one project and one release, which is why both
// are here; its Redis and Postgres, and Nextcloud's Redis, are sidecars no tab
// fronts and stay in image-repos. Home Assistant and Nextcloud are left to
// `releaseSourceFor`'s image-label fallback.
export const releases: Record<string, ReleaseSource> = {
  immich: { repo: 'immich-app/immich' },
  'immich-machine-learning': { repo: 'immich-app/immich' },
  grocy: { repo: 'grocy/grocy' },
  wealthfolio: { repo: 'afadil/wealthfolio' },
  'stirling-pdf': { repo: 'Stirling-Tools/Stirling-PDF' },
  'pocket-id': { repo: 'pocket-id/pocket-id' },
}
