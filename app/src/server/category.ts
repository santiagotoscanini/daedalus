import { createServerFn } from '@tanstack/react-start'
import type { Hosts } from '../host/hosts'

import type { CategoryDataMap, CategoryPayload } from '../lib/dashboard/category-data'
import { CATEGORIES, type CategoryName, isCategoryName, resolveTab } from '../lib/dashboard/nav'
import { isRecord } from '../lib/is-record'
import type { PageSpec } from '../lib/modules/manifest'
import { isModuleId, moduleById } from '../lib/modules/registry'

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

export type { CategoryPayload }

export const fetchCategoryBoards = createServerFn()
  // The category is a real check because `LOADERS[category]` below is indexed
  // with it. The tab is only checked for being a string: `resolveTab` answers
  // the category's first tab for one it does not recognise, which is the
  // behaviour a stale link depends on.
  .validator((data: unknown): { category: CategoryName; tab: string } => {
    if (!isRecord(data) || !isCategoryName(data.category)) throw new Error('expected a category')
    if (typeof data.tab !== 'string') throw new Error('expected a tab')
    return { category: data.category, tab: data.tab }
  })
  .handler(async ({ data }): Promise<CategoryPayload> => {
    const { makeHosts } = await import('../host/hosts')
    return loadCategory(data.category, resolveTab(data.category, data.tab), await makeHosts())
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
  .validator((data: unknown): { category: string } => {
    if (!isRecord(data) || !(isModuleId(data.category) || isCategoryName(data.category))) {
      throw new Error('expected a category')
    }
    return { category: data.category }
  })
  .handler(async ({ data }): Promise<TabStatus> => {
    // A module's manifest or a category's spec — the tab row is the same
    // shape either way, and this is the one server function both share.
    const spec: PageSpec | undefined =
      moduleById(data.category) ?? CATEGORIES.find((c) => c.id === data.category)
    if (spec === undefined) return {}

    const { promVector } = await import('../host/prom')
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
    const all = (names: readonly string[]): boolean | null => {
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
  const { promScalar } = await import('../host/prom')
  const { declaredVpnEgress } = await import('../host/vpn-egress')

  const declared = await declaredVpnEgress()
  if (declared.length === 0) return null

  const { promEscape } = await import('../host/prom')
  const names = declared.flatMap((d) => [d.container, d.exporter])
  const [tunnels, containers, seen] = await Promise.all([
    // `min` over the set, and `count` beside it: min alone would report
    // healthy if prometheus had lost a tunnel's series entirely.
    promScalar(`min(gluetun_vpn_status)`),
    promScalar(`min(container_up{name=~"${names.map(promEscape).join('|')}"})`),
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
  const { promScalar } = await import('../host/prom')
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
  const { promScalar } = await import('../host/prom')
  const [worst, seen] = await Promise.all([
    promScalar('min(up{job=~"loki|alloy"})'),
    promScalar('count(up{job=~"loki|alloy"})'),
  ])
  if (worst === null || seen === null || seen < 2) return null
  return worst === 1
}

type Loader<K extends CategoryName> = (tab: string, hosts: Hosts) => Promise<CategoryDataMap[K]>

/**
 * One dynamic-import thunk per category — the server half of the registry
 * whose types live in lib/dashboard/category-data.ts and whose views live in
 * components/category/registry.tsx. Dynamic imports, because each category's
 * data module drags its whole upstream graph with it and one request should
 * load exactly one.
 */
const LOADERS: { [K in CategoryName]: () => Promise<Loader<K>> } = {
  network: async () => (await import('../lib/dashboard/categories/network')).loadNetwork,
}

async function loadCategory(
  category: CategoryName,
  tab: string,
  hosts: Hosts,
): Promise<CategoryPayload> {
  const load = await LOADERS[category]()
  // TS cannot correlate an indexed record lookup with the union member the
  // same key selects, so this one cast carries what the record's mapped type
  // already proved: LOADERS[k] returns exactly CategoryDataMap[k].
  return { kind: category, data: await load(tab, hosts) } as CategoryPayload
}
