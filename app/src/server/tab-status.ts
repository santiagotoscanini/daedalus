import { asValidator, obj, withMessage } from '../lib/contract/decode'
import { moduleIdField } from '../lib/contract/fields'
import { moduleById } from '../lib/modules/registry'
import { readFn } from './fn'

// The dots on a module page's sub-tab row.
//
// Its own server function rather than a field on the boards payload, because
// the tab row is the one part of a module page that renders before anything
// is fetched: the boards fan out across a dozen services and the dots are a
// few prometheus queries. Hanging the dots off the boards would hold the whole row
// hostage to the slowest upstream on the page, in order to draw a circle.

/** Tab id → is its subject answering. `null` = nothing probes it. */
export type TabStatus = Record<string, boolean | null>

/**
 * How long a probe has to have been failing before a dot calls it down.
 *
 * gatus runs every 60s and its gauge is the LAST result, so reading it
 * instantaneously makes one timed-out request a red dot for a minute. That is
 * not a hypothetical here: traefik dials the *arrs at a port published out of
 * gluetun's rootless network namespace, where a new connection stalls ~10.5s
 * about one time in forty (measured; the scraparr exporter hits the same
 * fault). gatus times out at 10s, so roughly 2% of probes for
 * those endpoints fail against a service that is perfectly healthy, and Sonarr
 * and Radarr spent ~30 minutes of the last day reported down between them
 * while answering every request anybody actually made.
 *
 * `max_over_time` over three windows means down requires that NOTHING answered
 * in three minutes — a real outage, not one lost SYN. The cost is detection
 * latency: a service that dies is drawn red up to two minutes later than an
 * instantaneous read would draw it. For a dot on a dashboard that is a good
 * trade; the alerting that pages is Grafana's, and it has its own thresholds.
 *
 * This matters most on a tab that ANDs several probes, which multiplies the
 * flap rate — Media's Wanted holds four, and read instantaneously it would be
 * red several percent of the time with every service up.
 */
const PROBE_WINDOW = '3m'

export const fetchTabStatus = readFn
  .validator(asValidator(withMessage(obj({ module: moduleIdField }), 'expected a module')))
  .handler(async ({ data }): Promise<TabStatus> => {
    const spec = moduleById(data.module)
    if (spec === undefined) return {}

    const { promVector } = await import('../host/prom')
    const [probes, egress, uplink, logs, minecraft] = await Promise.all([
      promVector(`max_over_time(gatus_results_endpoint_success[${PROBE_WINDOW}])`),
      // Each only when a tab actually asks for it — they are more prometheus
      // queries, and every module pays for this handler.
      spec.tabs.some((t) => t.health === 'vpn-egress') ? vpnEgressHealth() : Promise.resolve(null),
      spec.tabs.some((t) => t.health === 'uplink') ? uplinkHealth() : Promise.resolve(null),
      spec.tabs.some((t) => t.health === 'log-pipeline')
        ? logPipelineHealth()
        : Promise.resolve(null),
      spec.tabs.some((t) => t.health === 'minecraft-ping')
        ? minecraftHealth()
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
              : t.health === 'minecraft-ping'
                ? minecraft
                : t.probes !== undefined
                  ? all(t.probes)
                  : t.probe === undefined
                    ? null
                    : (health.get(t.probe) ?? null),
      ]),
    )
  })

/**
 * Is the Minecraft server answering the game's own status ping.
 *
 * It publishes no hostname — the game is a bare TCP protocol on a forwarded
 * port — so gatus has nothing to probe. mc-monitor speaks the server-list ping
 * and exports the answer, which is a stronger claim than any container check:
 * a wedged JVM reads as down here and as up everywhere else. Over the same
 * window as the probes, so one slow ping during a save is not a red dot.
 *
 * The exporter's own `up` beside it: a dead exporter leaves the gauge
 * absent, and absent is "cannot tell" (grey), never "down".
 */
async function minecraftHealth(): Promise<boolean | null> {
  const { promScalar } = await import('../host/prom')
  const [answered, exporter] = await Promise.all([
    promScalar(`max(max_over_time(minecraft_status_healthy[${PROBE_WINDOW}]))`),
    promScalar('max(up{job="minecraft"})'),
  ])
  if (answered === null || exporter !== 1) return null
  return answered >= 1
}

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
  const { promEscape, promScalar } = await import('../host/prom')
  const { declaredVpnEgress } = await import('../host/vpn-egress')

  const declared = await declaredVpnEgress()
  if (declared.length === 0) return null

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
