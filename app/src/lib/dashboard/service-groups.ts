// Which service each pinned image belongs to — the unit System › Updates
// groups by.
//
// The unit is what gets UPDATED TOGETHER. Immich's server, machine learning,
// postgres and redis are one release; the *arrs, Jellyfin and the tools that
// configure and clean up after them are one sitting, because a Sonarr major
// is also a Recyclarr and a Cleanuparr question. The nix side already names
// most of those sets: `fleet.logStacks` (exported as `/export/switches.json`'s
// `stacks`) maps every multi-container stack to its members, and a container
// missing from it is its own one-member stack. So the grouping is read first —
// a new stack groups itself — and corrected where a set spans stacks:
//
//   - FOLD names a stack that rides another: the *arr helpers into the TV
//     stack, an MCP sidecar or a vector store into the service it serves.
//   - a pin that is not a container (fleet.manualPins: a local build's base, a
//     build tool) belongs to the service it builds, found through the
//     containers it names; the engine's own pins name the control plane.
//
// Client-safe: pure, so the page can filter and re-sort without a round trip.

/** A stack (or lone container) whose updates are decided with another group's. */
const FOLD: Record<string, string> = {
  // The *arr ecosystem: each of these is configured against, or acts on,
  // the TV stack's Sonarr/Radarr/qBittorrent, and moves when they do.
  seerr: 'tv',
  recyclarr: 'tv',
  cleanuparr: 'tv',
  janitorr: 'tv',
  scraparr: 'tv',
  // Sidecars of one service.
  'grocy-mcp': 'grocy',
  'litellm-pgvector': 'litellm',
  // The control plane's own container is the engine.
  'app-daedalus': 'daedalus',
}

/** How a group is titled when its id is not how people say it. */
const LABELS: Record<string, string> = {
  tv: 'TV & *arrs',
  'app-db': 'Postgres',
  'argus-vpn': 'Argus VPN',
  'calibre-web': 'Calibre-Web',
  daedalus: 'Daedalus',
  downloads: 'VPN & downloads',
  getbased: 'getbased',
  'grocy-mcp': 'Grocy MCP',
  'hermes-agent': 'Hermes Agent',
  'hevy-mcp': 'Hevy MCP',
  'home-assistant': 'Home Assistant',
  'intel-gpu-exporter': 'Intel GPU exporter',
  'lemonade-logs': 'Lemonade logs',
  litellm: 'LiteLLM',
  'litellm-pgvector': 'LiteLLM pgvector',
  logging: 'Logging',
  metube: 'MeTube',
  myspeed: 'MySpeed',
  nzbget: 'NZBGet',
  'open-webui': 'Open WebUI',
  'pocket-id': 'Pocket ID',
  qbittorrent: 'qBittorrent',
  registry: 'Registry',
  searxng: 'SearXNG',
  'stirling-pdf': 'Stirling-PDF',
  'wg-easy': 'WireGuard',
  'yazio-mcp': 'Yazio MCP',
}

/**
 * The icon files under app/public, by name. A list rather than a probe: the
 * page is server-rendered, and an <img> that 404s would flash a broken glyph
 * before anything could swap in the monogram. service-groups.test.ts checks
 * every entry is a file that exists.
 */
export const ICON_FILES: Record<string, string> = {
  bazarr: '/icon-bazarr.svg',
  'calibre-web': '/icon-calibre-web.svg',
  cleanuparr: '/icon-cleanuparr.png',
  cloudflare: '/icon-cloudflare.svg',
  daedalus: '/icon.svg',
  factorio: '/icon-factorio.png',
  gatus: '/icon-gatus.svg',
  getbased: '/icon-getbased.svg',
  gluetun: '/icon-gluetun.svg',
  grafana: '/icon-grafana.svg',
  grocy: '/icon-grocy.svg',
  healthchecks: '/icon-healthchecks.svg',
  'hermes-agent': '/icon-hermes-agent.png',
  hevy: '/icon-hevy.png',
  'home-assistant': '/icon-home-assistant.png',
  immich: '/icon-immich.svg',
  janitorr: '/icon-janitorr.png',
  jellyfin: '/icon-jellyfin.svg',
  lemonade: '/icon-lemonade.png',
  litellm: '/icon-litellm.png',
  loki: '/icon-loki.svg',
  metube: '/icon-metube.svg',
  minecraft: '/icon-minecraft.svg',
  n8n: '/icon-n8n.png',
  nextcloud: '/icon-nextcloud.svg',
  nzbget: '/icon-nzbget.svg',
  'open-webui': '/icon-open-webui.svg',
  pihole: '/icon-pihole.svg',
  'pocket-id': '/icon-pocket-id.svg',
  postgres: '/icon-postgres.svg',
  prometheus: '/icon-prometheus.svg',
  prowlarr: '/icon-prowlarr.svg',
  qbittorrent: '/icon-qbittorrent.svg',
  radarr: '/icon-radarr.svg',
  recyclarr: '/icon-recyclarr.svg',
  seerr: '/icon-seerr.svg',
  shelfmark: '/icon-shelfmark.png',
  shotter: '/icon-shotter.svg',
  sonarr: '/icon-sonarr.svg',
  'stirling-pdf': '/icon-stirling-pdf.svg',
  traefik: '/icon-traefik.svg',
  verdaccio: '/icon-verdaccio.png',
  wealthfolio: '/icon-wealthfolio.png',
  wireguard: '/icon-wireguard.svg',
  yazio: '/icon-yazio.png',
  zot: '/icon-zot.png',
}

/** A group whose id is not an icon's name, pointed at the icon that is its face. */
const ICON_ALIAS: Record<string, string> = {
  tv: 'jellyfin',
  'app-db': 'postgres',
  'argus-vpn': 'gluetun',
  cloudflared: 'cloudflare',
  downloads: 'gluetun',
  'grocy-mcp': 'grocy',
  'hevy-mcp': 'hevy',
  'lemonade-logs': 'lemonade',
  logging: 'loki',
  monitoring: 'grafana',
  registry: 'zot',
  'wg-easy': 'wireguard',
  'yazio-mcp': 'yazio',
}

export type ServiceGroup = {
  id: string
  label: string
  /** A path under the app's public root, or null for a monogram. */
  icon: string | null
  /** Row keys, `c:<container>` or `m:<manual pin id>`, in the order given. */
  members: string[]
}

/** The minimum of a row this needs: its key and, for a manual pin, what it builds. */
export type GroupableRow =
  | { kind: 'container'; container: string }
  | { kind: 'manual'; container: string; containers: string[]; engine: boolean }

export function rowKey(r: { kind: 'container' | 'manual'; container: string }): string {
  return `${r.kind === 'container' ? 'c' : 'm'}:${r.container}`
}

function titleCase(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

export function groupLabel(id: string): string {
  return LABELS[id] ?? titleCase(id)
}

export function groupIcon(id: string, members: readonly string[] = []): string | null {
  const own = ICON_FILES[ICON_ALIAS[id] ?? id]
  if (own !== undefined) return own
  for (const m of members) {
    const name = m.slice(2)
    const hit = ICON_FILES[ICON_ALIAS[name] ?? name]
    if (hit !== undefined) return hit
  }
  return null
}

/**
 * Every row into the group it belongs to. Groups keep the order their first
 * member arrives in; the page sorts them by what needs attention.
 */
export function serviceGroups(
  stacks: Record<string, readonly string[]>,
  rows: readonly GroupableRow[],
): ServiceGroup[] {
  const owner = new Map<string, string>()
  for (const [stack, members] of Object.entries(stacks)) {
    for (const m of members) owner.set(m, stack)
  }
  const keyOf = (container: string): string => {
    const k = owner.get(container) ?? container
    return FOLD[k] ?? k
  }

  const groups = new Map<string, string[]>()
  for (const r of rows) {
    let id: string
    if (r.kind === 'container') id = keyOf(r.container)
    else {
      const built = r.containers[0]
      if (built !== undefined) id = keyOf(built)
      else id = r.engine ? 'daedalus' : keyOf(r.container)
    }
    const members = groups.get(id) ?? []
    members.push(rowKey(r))
    groups.set(id, members)
  }

  return [...groups].map(([id, members]) => ({
    id,
    label: groupLabel(id),
    icon: groupIcon(id, members),
    members,
  }))
}
