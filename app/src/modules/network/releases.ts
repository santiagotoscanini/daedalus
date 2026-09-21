import type { ReleaseSource } from '../../lib/dashboard/image-repos'

// Where the Network containers' release notes live: the edge and both
// tunnels, plus the speed test General reads.
export const releases: Record<string, ReleaseSource> = {
  traefik: { repo: 'traefik/traefik' },
  cloudflared: { repo: 'cloudflare/cloudflared' },
  'wg-easy': { repo: 'wg-easy/wg-easy' },
  // Master, not the release line — see `ReleaseSource.branch`.
  gluetun: { repo: 'qdm12/gluetun', branch: 'master' },
  'gluetun-argus': { repo: 'qdm12/gluetun', branch: 'master' },
  'gluetun-exporter': { repo: 'thecfu/gluetun-exporter', opts: { notesWhenUnknown: true } },
  'gluetun-argus-exporter': { repo: 'thecfu/gluetun-exporter', opts: { notesWhenUnknown: true } },
  myspeed: { repo: 'gnmyt/myspeed' },
}
