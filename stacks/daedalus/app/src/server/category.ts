import { createServerFn } from '@tanstack/react-start'

import type { AiData } from '../lib/dashboard/categories/ai'
import type { GamingData } from '../lib/dashboard/categories/gaming'
import type { MediaData } from '../lib/dashboard/categories/media'
import type { HomeData } from '../lib/dashboard/categories/home'
import type { MonitoringData } from '../lib/dashboard/categories/monitoring'
import type { NetworkData } from '../lib/dashboard/categories/network'
import type { SecurityData } from '../lib/dashboard/categories/security'
import type { SystemData } from '../lib/dashboard/categories/system'
import { CATEGORIES } from '../lib/dashboard/nav'
import type { CategoryName } from '../lib/dashboard/tiles'

// The loaders behind every category page.
//
// Server-side only, and necessarily so: every per-service API key in
// /run/daedalus-dashboard/env is read here and none of it may cross to the
// browser. What the client receives is numbers that have already been read,
// summed and formatted.
//
// One category and one sub-tab per request. The alternative — load everything
// and let the client pick — would mean ~90 upstream calls to render a page
// showing a fifth of them, on a box where several of those upstreams are
// services that charge real seconds for a cold connection.
//
// ── two functions, not one ────────────────────────────────────────────────
//
// A category page is two independent fan-outs: the boards (this category's own
// panels) and the tiles (the per-service directory beneath them). They share
// nothing, they finish at different times, and the route streams each in
// behind its own skeleton — so they are separate entry points rather than one
// call the page has to wait out. The page's own frame (title, lede, sub-tabs)
// needs neither: it comes from the static CATEGORIES table on the client and
// is on screen before either request is answered.

export type {
  AiData,
  GamingData,
  HomeData,
  MediaData,
  MonitoringData,
  NetworkData,
  SecurityData,
  SystemData,
}

/** The service directory that sits under every category's own panels. */
export type Tile = {
  key: string
  name: string
  group: string
  description: string
  href: string
  up: boolean | null
  stats: { label: string; value: string }[]
  note: string | null
}

export type CategoryTiles = {
  groups: { name: string; icon: string; tiles: Tile[] }[]
  /** Services in this category that gatus says are not answering. */
  down: string[]
}

export type CategoryPayload = Body

/** `https://<hostname>` per webApp, plus the host as containers see it. */
async function makeCtx(): Promise<{ base: (app: string) => string; hc: string }> {
  const { webAppHosts } = await import('../lib/nix-manifest')
  const hosts = await webAppHosts()
  return {
    // A missing webApp is a catalogue bug, not a runtime condition — the
    // manifest carries every published hostname. Falling back to the bare
    // name yields an obviously-broken link rather than a crashed page.
    base: (app: string) => `https://${hosts[app] ?? app}`,
    hc: 'http://host.containers.internal',
  }
}

/** Resolve a requested sub-tab against what the category actually declares. */
function resolveTab(category: CategoryName, tab: string): string {
  const spec = CATEGORIES.find((c) => c.id === category)
  if (spec === undefined) return ''
  return spec.tabs.some((t) => t.id === tab) ? tab : (spec.tabs[0]?.id ?? '')
}

export const fetchCategoryBoards = createServerFn()
  .inputValidator((input: { category: CategoryName; tab: string }) => input)
  .handler(async ({ data }): Promise<CategoryPayload> => {
    return loadCategory(data.category, resolveTab(data.category, data.tab), await makeCtx())
  })

/** Tab id → is its subject answering. `null` = nothing probes it. */
export type TabStatus = Record<string, boolean | null>

/**
 * How long a probe has to have been failing before a dot calls it down.
 *
 * gatus runs every 60s and its gauge is the LAST result, so reading it
 * instantaneously makes one timed-out request a red dot for a minute. That is
 * not a hypothetical here: traefik dials the *arrs at a port published out of
 * gluetun's rootless network namespace, where a new connection stalls ~10.5s
 * about one time in forty (measured — see stacks/scraparr for the same fault
 * hitting the exporter). gatus times out at 10s, so roughly 2% of probes for
 * those endpoints fail against a service that is perfectly healthy, and Sonarr
 * and Radarr spent ~30 minutes of the last day reported down between them
 * while answering every request anybody actually made.
 *
 * `max_over_time` over three windows means down requires that NOTHING answered
 * in three minutes — a real outage, not one lost SYN. The cost is detection
 * latency: a service that dies is drawn red up to two minutes later than
 * before. For a dot on a dashboard that is a good trade; the alerting that
 * pages is Grafana's, and it has its own thresholds.
 *
 * This matters most on a tab that ANDs several probes, which multiplies the
 * flap rate — Wanted holds three, so it was red several percent of the time
 * with all three services up.
 */
const PROBE_WINDOW = '3m'

/**
 * The dots on the sub-tab row.
 *
 * Its own entry point rather than a field on the boards payload, because the
 * tab row is the one part of a category page that renders before anything is
 * fetched — see the note at the top of this file. Hanging the dots off the
 * boards would hold the whole row hostage to the slowest upstream on the
 * page, to draw a circle. This is one Prometheus query and lands first.
 */
export const fetchTabStatus = createServerFn()
  .inputValidator((input: { category: CategoryName }) => input)
  .handler(async ({ data }): Promise<TabStatus> => {
    const spec = CATEGORIES.find((c) => c.id === data.category)
    if (spec === undefined) return {}

    const { promVector } = await import('../lib/dashboard/clients')
    const [probes, egress, uplink] = await Promise.all([
      promVector(`max_over_time(gatus_results_endpoint_success[${PROBE_WINDOW}])`),
      // Only when a tab actually asks for it — this is two more prometheus
      // queries and every category pays for this handler.
      spec.tabs.some((t) => t.health === 'vpn-egress') ? vpnEgressHealth() : Promise.resolve(null),
      spec.tabs.some((t) => t.health === 'uplink') ? uplinkHealth() : Promise.resolve(null),
    ])
    // The `name` label, not `key` — `key` is `<group>_<name>`, so reading it
    // means knowing which group an endpoint was declared in. gatus probes the
    // published web apps AND a couple of off-box services (Lemonade), and a
    // tab should not have to care which list its subject is on.
    const health = new Map(probes.map((p) => [p.metric.name ?? '', p.value[1] === '1']))

    /** All green, or null the moment one of them cannot be read. */
    const all = (names: string[]): boolean | null => {
      const seen = names.map((n) => health.get(n) ?? null)
      return seen.includes(null) ? null : seen.every(Boolean)
    }

    return Object.fromEntries(
      spec.tabs.map((t) => [
        t.id,
        t.health === 'vpn-egress' ? egress
        : t.health === 'uplink' ? uplink
        : t.probes !== undefined ? all(t.probes)
        : t.probe === undefined ? null
        : (health.get(t.probe) ?? null),
      ]),
    )
  })

/**
 * Are all the VPN egress tunnels working.
 *
 * Three conditions, and all three are needed: every declared tunnel reports
 * itself connected, every gluetun container is up, and so is every exporter —
 * which is the thing the first condition is READ from, so an exporter that
 * has died leaves `gluetun_vpn_status` frozen at whatever it last said. A
 * green dot resting on a stale metric is worse than a grey one.
 *
 * The container names come from `fleet.vpnEgress` rather than a name pattern,
 * so a third tunnel called something else still counts. Null when the registry
 * is unreadable or prometheus has no answer — "cannot tell", not "down".
 */
async function vpnEgressHealth(): Promise<boolean | null> {
  const { promScalar } = await import('../lib/dashboard/clients')

  let declared: { container: string; exporter: string }[] = []
  try {
    declared = JSON.parse(process.env.VPN_EGRESS ?? '[]') as typeof declared
  } catch {
    return null
  }
  if (declared.length === 0) return null

  const names = declared.flatMap((d) => [d.container, d.exporter])
  const [tunnels, containers] = await Promise.all([
    // `min` over the set, and `count` beside it: min alone would report
    // healthy if prometheus had lost a tunnel's series entirely.
    promScalar(`min(gluetun_vpn_status)`),
    promScalar(`min(container_up{name=~"${names.join('|')}"})`),
  ])
  const seen = await promScalar(`count(gluetun_vpn_status)`)

  if (tunnels === null || containers === null || seen === null) return null
  return tunnels === 1 && containers === 1 && seen >= declared.length
}

/**
 * Can this house reach the router, and anything past it.
 *
 * The General tab has no service to probe — it is the wire — but "the wire is
 * fine" is a real, checkable claim, and the exporter pings both hops every
 * minute for exactly this. Green needs BOTH: the router alone answering means
 * the LAN works and the internet does not, which is not a working uplink.
 *
 * `count` beside `min` for the same reason the egress check has it: min over
 * an empty set is not a failure, it is no answer, and those must not render
 * the same.
 */
async function uplinkHealth(): Promise<boolean | null> {
  const { promScalar } = await import('../lib/dashboard/clients')
  const [worst, seen] = await Promise.all([
    promScalar('min(network_hop_up)'),
    promScalar('count(network_hop_up)'),
  ])
  if (worst === null || seen === null || seen < 2) return null
  return worst === 1
}

export const fetchCategoryTiles = createServerFn()
  .inputValidator((input: { category: CategoryName; tab: string }) => input)
  .handler(async ({ data }): Promise<CategoryTiles> => {
    const { GROUPS, TILES } = await import('../lib/dashboard/tiles')
    const { pool, promVector } = await import('../lib/dashboard/clients')
    return loadTiles(data.category, resolveTab(data.category, data.tab), {
      GROUPS,
      TILES,
      pool,
      promVector,
      ctx: await makeCtx(),
    })
  })

type Body =
  | { kind: 'ai'; data: AiData }
  | { kind: 'media'; data: MediaData }
  | { kind: 'home'; data: HomeData }
  | { kind: 'network'; data: NetworkData }
  | { kind: 'security'; data: SecurityData }
  | { kind: 'system'; data: SystemData }
  | { kind: 'monitoring'; data: MonitoringData }
  | { kind: 'gaming'; data: GamingData }

async function loadCategory(
  category: CategoryName,
  tab: string,
  ctx: { base: (app: string) => string; hc: string },
): Promise<Body> {
  switch (category) {
    case 'ai': {
      const { loadAi } = await import('../lib/dashboard/categories/ai')
      return { kind: 'ai', data: await loadAi(tab, ctx) }
    }
    case 'media': {
      const { loadMedia } = await import('../lib/dashboard/categories/media')
      return { kind: 'media', data: await loadMedia(tab, ctx) }
    }
    case 'home': {
      const { loadHome } = await import('../lib/dashboard/categories/home')
      return { kind: 'home', data: await loadHome(ctx) }
    }
    case 'network': {
      const { loadNetwork } = await import('../lib/dashboard/categories/network')
      return { kind: 'network', data: await loadNetwork(tab, ctx) }
    }
    case 'security': {
      const { loadSecurity } = await import('../lib/dashboard/categories/security')
      return { kind: 'security', data: await loadSecurity(tab, ctx) }
    }
    case 'system': {
      const { loadSystem } = await import('../lib/dashboard/categories/system')
      return { kind: 'system', data: await loadSystem(ctx) }
    }
    case 'monitoring': {
      const { loadMonitoring } = await import('../lib/dashboard/categories/monitoring')
      return { kind: 'monitoring', data: await loadMonitoring(ctx) }
    }
    case 'gaming': {
      const { loadGaming } = await import('../lib/dashboard/categories/gaming')
      return { kind: 'gaming', data: await loadGaming(tab, ctx) }
    }
  }
}

type TileModules = {
  GROUPS: typeof import('../lib/dashboard/tiles')['GROUPS']
  TILES: typeof import('../lib/dashboard/tiles')['TILES']
  pool: typeof import('../lib/dashboard/clients')['pool']
  promVector: typeof import('../lib/dashboard/clients')['promVector']
  ctx: { base: (app: string) => string; hc: string }
}

async function loadTiles(
  category: CategoryName,
  tab: string,
  m: TileModules,
): Promise<CategoryTiles> {
  const groups = m.GROUPS.filter(
    (g) => g.category === category && (g.tab === undefined || g.tab === tab),
  )
  const names = new Set(groups.map((g) => g.name))
  const wanted = m.TILES.filter((t) => names.has(t.group))

  // Status comes from gatus, in one query for every tile: it probes the real
  // public URL from outside. `container_up` would answer a different question
  // — the unit being active does not mean the service is answering, and every
  // Type=oneshot podman unit on this box can be green over a dead container.
  //
  // Debounced over the same window as the tab dots, for the same reason: these
  // are the same gauge, and a tile that goes red on one lost SYN is reporting
  // a fault that had already healed before the page finished loading.
  const probes = await m.promVector(
    `max_over_time(gatus_results_endpoint_success[${PROBE_WINDOW}])`,
  )
  const health = new Map(
    probes.map((p) => [(p.metric.key ?? '').replace(/^web-apps_/, ''), p.value[1] === '1']),
  )

  const loaded = await m.pool(
    wanted.map((t) => async () => {
      // The catch is the backstop for a `load` that throws despite the
      // helpers: one bad upstream must not blank the page, because "which one
      // is broken" is the whole reason to look at this.
      const result =
        t.load === undefined ? { stats: [], note: undefined } : (
          await t.load(m.ctx).catch(() => ({ stats: [], note: undefined }))
        )
      return {
        key: t.key,
        name: t.name,
        group: t.group as string,
        description: t.description,
        href: 'url' in t.link ? t.link.url : `${m.ctx.base(t.link.app)}${t.link.path ?? ''}`,
        // null = nothing probes this (the off-box services, and the link-only
        // bookmarks). Rendered as "no probe", not as down.
        up: t.gatus === undefined ? null : (health.get(t.gatus) ?? null),
        stats: result.stats,
        note: result.note ?? null,
      }
    }),
  )

  return {
    groups: groups.map((g) => ({
      name: g.name,
      icon: g.icon,
      tiles: loaded.filter((t) => t.group === g.name),
    })),
    down: loaded.filter((t) => t.up === false).map((t) => t.name),
  }
}
