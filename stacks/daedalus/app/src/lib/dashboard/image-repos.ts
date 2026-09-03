import type { GapOptions } from './github'
import { imageLabels } from './images'

// Which project's release notes belong to which container.
//
// Every service tab on this dashboard already answers this, one hardcoded
// `versionGap('owner/repo', …)` at a time, and that was fine while the only
// pages asking were the pages that had a service head. The Updates page asks
// about all sixty-five pinned containers at once — including the two dozen
// exporters, sidecars and janitors that have no tab, and whose changelog
// nobody could read anywhere in this app before it existed.
//
// ── why this is a table and not a label read ──────────────────────────────
//
// Images publish `org.opencontainers.image.source`, and it is tempting to
// treat that as the answer. It is not, and the failure is the same one
// lib/dashboard/images.ts documents for versions: the label is a claim the
// PUBLISHER made, and for a repackaged image the publisher is not the project.
//
// On this box, today: every linuxserver image points at its own packaging repo
// (`linuxserver/docker-radarr`), whose releases are `-lsNNN` build numbers
// rather than the Radarr versions anyone wants to read; `calibre-web`'s points
// at `linuxserver/docker-baseimage-ubuntu`, inherited from a base image and
// about a different piece of software entirely; `gluetun`'s points at a fork.
// Rendering any of those as "what changed" would be confidently wrong, which
// is worse than the blank it replaced.
//
// So the curated entry wins, the label is the fallback for a container nobody
// has curated, and a container with neither gets no notes rather than a guess.
// The tag deltas and candidate list still render — "there is a newer tag and
// we cannot tell you what is in it" is a real answer.

export type ReleaseSource = {
  repo: string
  opts?: GapOptions
  /**
   * Compare COMMITS on this branch instead of releases.
   *
   * For an image built off a moving branch, where a release list is not merely
   * uninformative but misleading — gluetun's `:latest` is master, which has
   * diverged from the v3.41.x line, so its release notes would advise a
   * downgrade into a known port-forwarding deadlock. See `commitsSince`.
   */
  branch?: string
}

/** The *arr build number is the fourth segment, and it is the one that moves. */
const ARR_TAG = /^v?(\d+\.\d+\.\d+\.\d+)$/
/** Two segments or three — for projects that ship both `4.3` and `4.3.1`. */
const TWO_OR_THREE = /^v?(\d+\.\d+(?:\.\d+)?)$/

/**
 * Container → where its release notes live.
 *
 * Keyed by CONTAINER, not by image: `immich` and `immich-machine-learning` are
 * one project and two containers, and every *arr rides one packaging repo.
 * Keying by image would make those separate questions.
 *
 * Every entry that a service tab also uses is the same repo and the same
 * options that tab passes — deliberately, so the Updates row and the service
 * page cannot disagree about what "3 behind" means.
 */
export const RELEASE_SOURCES: Record<string, ReleaseSource> = {
  // ── the media chain ────────────────────────────────────────────────────
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
  // No curated entry on this box until now, and no label either — both are
  // sidecars of the chain above rather than services anyone opens.
  flaresolverr: { repo: 'FlareSolverr/FlareSolverr' },
  subgen: { repo: 'McCloudS/subgen', opts: { notesWhenUnknown: true } },
  scraparr: { repo: 'thecfu/scraparr' },

  // ── the household ──────────────────────────────────────────────────────
  immich: { repo: 'immich-app/immich' },
  'immich-machine-learning': { repo: 'immich-app/immich' },
  'immich-redis': { repo: 'valkey-io/valkey' },
  'immich-postgres': { repo: 'immich-app/base-images', opts: { notesWhenUnknown: true } },
  grocy: { repo: 'grocy/grocy' },
  wealthfolio: { repo: 'afadil/wealthfolio' },
  'stirling-pdf': { repo: 'Stirling-Tools/Stirling-PDF' },
  'pocket-id': { repo: 'pocket-id/pocket-id' },
  'nextcloud-redis': { repo: 'redis/redis', opts: { notesWhenUnknown: true } },

  // ── the edge ───────────────────────────────────────────────────────────
  traefik: { repo: 'traefik/traefik' },
  cloudflared: { repo: 'cloudflare/cloudflared' },
  'wg-easy': { repo: 'wg-easy/wg-easy' },
  // Master, not the release line — see `branch` above.
  gluetun: { repo: 'qdm12/gluetun', branch: 'master' },
  'gluetun-argus': { repo: 'qdm12/gluetun', branch: 'master' },
  'gluetun-exporter': { repo: 'thecfu/gluetun-exporter', opts: { notesWhenUnknown: true } },
  'gluetun-argus-exporter': { repo: 'thecfu/gluetun-exporter', opts: { notesWhenUnknown: true } },
  searxng: { repo: 'searxng/searxng', branch: 'master' },
  myspeed: { repo: 'gnmyt/myspeed' },

  // ── the watchers ───────────────────────────────────────────────────────
  grafana: { repo: 'grafana/grafana', opts: { sameMajor: true } },
  prometheus: { repo: 'prometheus/prometheus' },
  loki: { repo: 'grafana/loki' },
  alloy: { repo: 'grafana/alloy' },
  gatus: { repo: 'TwiN/gatus' },
  healthchecks: { repo: 'healthchecks/healthchecks', opts: { tag: TWO_OR_THREE } },
  'node-exporter': { repo: 'prometheus/node_exporter' },
  'app-db-exporter': { repo: 'prometheus-community/postgres_exporter' },
  'intel-gpu-exporter': { repo: 'clambin/intel-gpu-exporter' },

  // ── AI, apps, games ────────────────────────────────────────────────────
  litellm: { repo: 'BerriAI/litellm' },
  'open-webui': { repo: 'open-webui/open-webui' },
  n8n: { repo: 'n8n-io/n8n', opts: { tag: /^n8n@(\d+\.\d+\.\d+)$/, sameMajor: true } },
  'mcp-grocy': { repo: 'miguelangel-nubla/mcp-grocy' },
  zot: { repo: 'project-zot/zot' },
  minecraft: { repo: 'itzg/docker-minecraft-server', opts: { notesWhenUnknown: true } },

  // Deliberately absent, and each for a reason rather than an oversight:
  //   factorio      — ofsm wraps the game; the version that matters is
  //                   Factorio's own, which the Gaming tab reads from the
  //                   wiki changelog because there is no GitHub release for it.
  //   lemonade-logs — a stdlib-only bridge.py bind-mounted into an unmodified
  //                   `python:3.13-alpine`. The code in it is ours and is not
  //                   in the image; what ages is CPython and the Alpine
  //                   packages under it. Pointing this at `python/cpython`
  //                   was tried and reverted: that repo publishes ZERO GitHub
  //                   Releases (only tags — CPython's notes live on
  //                   python.org), so the panel rendered an empty board,
  //                   which is a worse answer than none. The version delta is
  //                   carried on the row itself instead — see `remoteVersion`
  //                   in lib/dashboard/images.ts.
  //   minecraft-monitor — same shape, and its base states no version at all.
}

/**
 * Where to read this container's notes, or null if nowhere trustworthy.
 *
 * The label fallback is deliberately narrow: only `github.com/<owner>/<repo>`,
 * and only when nothing is curated. A source URL pointing anywhere else is a
 * repo this app has no reader for, and one pointing at a packaging repo is
 * exactly what the curated table exists to override.
 */
export async function releaseSourceFor(container: string): Promise<ReleaseSource | null> {
  const curated = RELEASE_SOURCES[container]
  if (curated !== undefined) return curated

  const { source } = await imageLabels(container)
  if (source === null) return null

  const m = /^https?:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/.exec(source)
  if (m?.[1] === undefined) return null

  // `notesWhenUnknown`, because an uncurated container is one whose running
  // version this app has no reader for either — so the honest panel is "here
  // is what upstream has published, and we cannot say which of it you have".
  return { repo: m[1], opts: { notesWhenUnknown: true } }
}
