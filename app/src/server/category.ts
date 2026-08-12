import { createServerFn } from '@tanstack/react-start'

import type { AiData } from '../lib/dashboard/categories/ai'
import type { GamingData } from '../lib/dashboard/categories/gaming'
import type { HomeData } from '../lib/dashboard/categories/home'
import type { MediaData } from '../lib/dashboard/categories/media'
import type { MonitoringData } from '../lib/dashboard/categories/monitoring'
import type { NetworkData } from '../lib/dashboard/categories/network'
import type { SystemData } from '../lib/dashboard/categories/system'
import { CATEGORIES, type CategoryName } from '../lib/dashboard/nav'

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
// ── two entry points, not one ─────────────────────────────────────────────
//
// The boards and the sub-tab dots are separate server functions. The dots are
// one prometheus query and land almost immediately; the boards fan out across
// a dozen services and do not. Hanging the dots off the boards payload would
// hold the whole tab row hostage to the slowest upstream on the page, in order
// to draw a circle. The page's own frame — title, lede, tab labels — waits for
// neither: it comes from the static CATEGORIES table on the client.
//
// There used to be a third, for a directory of per-service cards under every
// page. It is gone: every service on this box has a tab now, so the cards were
// restating three of a page's own numbers one scroll below it.

export type { AiData, GamingData, HomeData, MediaData, MonitoringData, NetworkData, SystemData }

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
    const [probes, egress, uplink, logs] = await Promise.all([
      promVector(`max_over_time(gatus_results_endpoint_success[${PROBE_WINDOW}])`),
      // Only when a tab actually asks for it — this is two more prometheus
      // queries and every category pays for this handler.
      spec.tabs.some((t) => t.health === 'vpn-egress') ? vpnEgressHealth() : Promise.resolve(null),
      spec.tabs.some((t) => t.health === 'uplink') ? uplinkHealth() : Promise.resolve(null),
      spec.tabs.some((t) => t.health === 'log-pipeline')
        ? logPipelineHealth()
        : Promise.resolve(null),
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
        t.health === 'vpn-egress'
          ? egress
          : t.health === 'uplink'
            ? uplink
            : t.health === 'log-pipeline'
              ? logs
              : t.probes !== undefined
                ? all(t.probes)
                : t.probe === undefined
                  ? null
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
  const { declaredVpnEgress } = await import('../lib/vpn-egress')

  const declared = await declaredVpnEgress()
  if (declared.length === 0) return null

  const { escapeRe } = await import('../lib/metrics')
  const names = declared.flatMap((d) => [d.container, d.exporter])
  const [tunnels, containers, seen] = await Promise.all([
    // `min` over the set, and `count` beside it: min alone would report
    // healthy if prometheus had lost a tunnel's series entirely.
    promScalar(`min(gluetun_vpn_status)`),
    promScalar(`min(container_up{name=~"${names.map(escapeRe).join('|')}"})`),
    promScalar(`count(gluetun_vpn_status)`),
  ])

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

/**
 * Is the log pipeline both shipping and storing.
 *
 * Neither half publishes a hostname, so gatus has nothing to probe — but
 * prometheus scrapes both over the monitoring bridge, and a scrape that
 * succeeded IS the liveness answer: `up` is 1 only when the process accepted
 * a connection and served its own metrics.
 *
 * Both, and the AND is the point. Alloy tails journald and pushes; Loki
 * stores and answers. Alloy alone up means lines are being collected and
 * dropped on the floor, Loki alone up means a store nothing is writing to,
 * and this tab's own text calls them two halves of one pipeline. Reporting
 * either one as "logs are fine" would be green over a broken half — the same
 * argument the multi-probe tabs make.
 *
 * `count` beside `min` for the reason the other two computed checks have it:
 * min over an empty set is not a failure, it is no answer.
 */
async function logPipelineHealth(): Promise<boolean | null> {
  const { promScalar } = await import('../lib/dashboard/clients')
  const [worst, seen] = await Promise.all([
    promScalar('min(up{job=~"loki|alloy"})'),
    promScalar('count(up{job=~"loki|alloy"})'),
  ])
  if (worst === null || seen === null || seen < 2) return null
  return worst === 1
}

type Body =
  | { kind: 'ai'; data: AiData }
  | { kind: 'media'; data: MediaData }
  | { kind: 'home'; data: HomeData }
  | { kind: 'network'; data: NetworkData }
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
      return { kind: 'home', data: await loadHome(tab, ctx) }
    }
    case 'network': {
      const { loadNetwork } = await import('../lib/dashboard/categories/network')
      return { kind: 'network', data: await loadNetwork(tab, ctx) }
    }
    case 'system': {
      const { loadSystem } = await import('../lib/dashboard/categories/system')
      return { kind: 'system', data: await loadSystem(tab) }
    }
    case 'monitoring': {
      const { loadMonitoring } = await import('../lib/dashboard/categories/monitoring')
      return { kind: 'monitoring', data: await loadMonitoring(tab, ctx) }
    }
    case 'gaming': {
      const { loadGaming } = await import('../lib/dashboard/categories/gaming')
      return { kind: 'gaming', data: await loadGaming(tab, ctx) }
    }
  }
}
