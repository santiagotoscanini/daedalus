import type { ReleaseSource } from '../../lib/dashboard/image-repos'
import { ARR_TAG, TWO_OR_THREE } from '../../lib/release-tags'

// Where the Media containers' release notes live: the chain, and the three
// sidecars whose logs are folded under it.
export const releases: Record<string, ReleaseSource> = {
  radarr: { repo: 'Radarr/Radarr', opts: { tag: ARR_TAG } },
  sonarr: { repo: 'Sonarr/Sonarr', opts: { tag: ARR_TAG } },
  prowlarr: { repo: 'Prowlarr/Prowlarr', opts: { tag: ARR_TAG } },
  bazarr: { repo: 'morpheus65535/bazarr' },
  seerr: { repo: 'seerr-team/seerr' },
  recyclarr: { repo: 'recyclarr/recyclarr', opts: { notesWhenUnknown: true } },
  jellyfin: { repo: 'jellyfin/jellyfin', opts: { tag: TWO_OR_THREE } },
  'calibre-web': { repo: 'crocodilestick/Calibre-Web-Automated' },
  qbittorrent: { repo: 'qbittorrent/qBittorrent', opts: { tag: /^release-(\d+\.\d+\.\d+)$/ } },
  nzbget: { repo: 'nzbgetcom/nzbget', opts: { tag: TWO_OR_THREE } },
  metube: { repo: 'alexta69/metube', opts: { tag: /^(\d{4}\.\d{2}\.\d{2})$/ } },
  shelfmark: { repo: 'calibrain/shelfmark', opts: { notesWhenUnknown: true } },
  cleanuparr: { repo: 'Cleanuparr/Cleanuparr' },
  janitorr: { repo: 'Schaka/janitorr', opts: { notesWhenUnknown: true } },
  // The three sidecars: no page of their own, only a log folded under the
  // tab they serve.
  flaresolverr: { repo: 'FlareSolverr/FlareSolverr' },
  subgen: { repo: 'McCloudS/subgen', opts: { notesWhenUnknown: true } },
  scraparr: { repo: 'thecfu/scraparr' },
}
